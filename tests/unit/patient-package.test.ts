import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileReferralRepository, MemoryReferralRepository, ReferralService, validateReferralDatabase, REFERRAL_DATABASE_SCHEMA_VERSION } from "../../lib/referrals/service";
import { PREPARATION_TTL_MS } from "../../lib/referrals/patient";
import { attachStartedPreparation, handleConfirmPreparation, handleDiscoverPreparation, handleManagePreparation, handlePreparation, handlePreparationAccess, preparationCookie, renderPreparationText } from "../../lib/patient-package";
import type { PatientReportInput, ReferralActor, RequirementCatalogue } from "../../lib/referrals/types";
import { FRONTEND_RESULT } from "../fixtures/frontend-result";
import { MemorySessionStore } from "../../lib/store";
import { handleWorkspaceLink } from "../../lib/workspace-api";

const doctor: ReferralActor = { id: "doctor-a", displayName: "Врач А", organizationId: "org-a", role: "doctor" };
const token = "abcdef0123456789";
const dateNow = Date.parse("2026-10-04T08:00:00Z");
const catalogue: RequirementCatalogue = { schemaVersion: 1, version: "fixture-v1", status: "available", source: "synthetic-test-only", validated: false,
  scope: { population: "adult", careSetting: "inpatient", treatment: "operative" }, profiles: [{ profile: "Хирургический", requirements: [
    { id: "r1", label: "Первое обследование", required: true, conditional: false, validForDays: 7 },
    { id: "r2", label: "Второе обследование", required: true, conditional: false, validForDays: 30 },
    { id: "r3", label: "Условное обследование", required: false, conditional: true, validForDays: 10 },
  ] }] };
function setup(repository = new MemoryReferralRepository(), validated = false) {
  let clock = dateNow;
  let serial = 0;
  const service = new ReferralService(repository, { catalogue: { ...catalogue, validated }, now: () => clock, id: () => `record-${++serial}` });
  return { repository, service, advance: (ms: number) => { clock += ms; } };
}
async function episode(service: ReferralService) {
  await service.bindLink(token, doctor);
  const grant = await service.issuePreparation("source-1", doctor, token);
  const before = await service.preparation(grant.token, grant.accessId);
  const created = await service.create(doctor, { patientLabel: "Тестовый эпизод", profile: "Хирургический", icd10Code: "I67.1", sourceSessionId: "source-1", idempotencyKey: "create" },
    { sessionId: "source-1", doctorToken: token, result: FRONTEND_RESULT });
  const referral = await service.assess(doctor, created.id, { expectedRevision: created.revision, expectedAssessmentRevision: 0,
    idempotencyKey: "operative-assessment", reason: "Тестовое подтверждение профиля",
    assessment: { hypothesis: FRONTEND_RESULT.hypothesis.text, profile: "Хирургический", icd10Code: "I67.1", careContext: "operative" } });
  return { grant, before, referral };
}
const report = (overrides: Partial<PatientReportInput> = {}): PatientReportInput => ({ requirementId: "r1", performedOn: "2026-10-01", resultAvailable: true, expectedRevision: 0, idempotencyKey: "patient-command", ...overrides });
function request(path: string, body?: unknown, cookie?: string, origin = "http://localhost") {
  return new Request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeEach(() => { vi.stubEnv("APP_BASE_URL", "http://localhost"); vi.stubEnv("DEMEU_AUTH_SECRET", "s".repeat(48)); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("patient preparation: durable scope and whitelist", () => {
  it("owner cannot issue an intake or grant an owner-owned preparation episode; doctor assignment is checked against current accounts", async () => {
    const { service } = setup();
    const owner: ReferralActor = { ...doctor, id: "owner", role: "owner" };
    const sessions = new MemorySessionStore();
    const response = await handleWorkspaceLink(request("/api/link", {}), { actor: async () => owner, referrals: service, sessions, limiter: { consume: () => 0 } });
    expect(response.status).toBe(403);
    const direction = await service.create(owner, { patientLabel: "Организационная запись", profile: "Хирургический", idempotencyKey: "owner-manual" });
    await expect(service.managePreparation(owner, direction.id, "reissue", { expectedAccessRevision: 0, idempotencyKey: "grant" }, "o".repeat(43))).rejects.toMatchObject({ code: "DOCTOR_ASSIGNMENT_REQUIRED" });
    const repository = new MemoryReferralRepository();
    const staleDoctor = new ReferralService(repository, { catalogue, now: () => dateNow, resolveDoctor: async () => ({ ...doctor, role: "owner" }) });
    await staleDoctor.bindLink(token, doctor);
    await expect(staleDoctor.issuePreparation("source", doctor, token)).rejects.toMatchObject({ code: "DOCTOR_ASSIGNMENT_REQUIRED" });
  });
  it("issues before referral, attaches one proven source and never includes clinical snapshot", async () => {
    const { service, repository } = setup();
    const { grant, before, referral } = await episode(service);
    expect(before.state).toBe("awaiting_referral");
    expect(referral.triageSnapshot?.hypothesis.text).toBe(FRONTEND_RESULT.hypothesis.text); // sensitive positive control
    expect(referral.triageSnapshot?.red_flags.length).toBeGreaterThan(0);
    const payload = await service.preparation(grant.token, grant.accessId);
    expect(payload.items).toHaveLength(3);
    expect(payload).toMatchObject({ state: "preparing", catalogueVersion: "fixture-v1", catalogueValidated: false, confirmedCompleteness: "unknown" });
    expect(Object.keys(payload).sort()).toEqual(["accessId", "careContext", "catalogueAvailable", "catalogueSource", "catalogueValidated", "catalogueVersion", "confirmedCompleteness", "destinationOrganization", "evaluatedOn", "expiresAt", "items", "patientLabel", "scheduledDate", "state"].sort());
    const serialized = JSON.stringify(payload);
    for (const hidden of ["triageSnapshot", "hypothesis", "risk", "red_flags", "anamnesis", "doctorId", "sourceSessionId", "capabilityHash", "Боль в груди", FRONTEND_RESULT.hypothesis.text]) expect(serialized).not.toContain(hidden);
    const stored = await repository.read((state) => JSON.stringify(state));
    expect(stored).not.toContain(grant.token);
    expect(stored).toContain("capabilityHash");
  });
  it("rejects doctor token, another access id and grants across two patients", async () => {
    const { service } = setup();
    const first = await episode(service);
    const other = await service.create(doctor, { patientLabel: "Другой эпизод", profile: "Хирургический", idempotencyKey: "other" });
    const second = await service.managePreparation(doctor, other.id, "reissue", { expectedAccessRevision: 0, idempotencyKey: "second" }, "z".repeat(43));
    await expect(service.preparation(token)).rejects.toMatchObject({ status: 401 });
    await expect(service.preparation(first.grant.token, second!.accessId)).rejects.toMatchObject({ status: 401 });
    expect((await service.preparation(second!.token)).patientLabel).toBe("Другой эпизод");
    await expect(service.issuePreparation("cross-source", { ...doctor, organizationId: "org-b" }, token)).rejects.toMatchObject({ status: 404 });
    await expect(service.issuePreparation("unproved-source", doctor, "unbound-token")).rejects.toMatchObject({ status: 404 });
  });
  it("expires at exactly 30 days, independent of chat retention", async () => {
    const { service, advance } = setup();
    const { grant } = await episode(service);
    advance(2 * 86400000);
    expect((await service.preparation(grant.token)).state).toBe("preparing");
    advance(28 * 86400000);
    await expect(service.preparation(grant.token)).rejects.toMatchObject({ status: 401 });
  });
  it("does not project the operative catalogue before the physician records care context", async () => {
    const { service } = setup();
    await service.bindLink(token, doctor);
    const grant = await service.issuePreparation("source-unknown", doctor, token);
    await service.create(doctor, { patientLabel: "Контекст не подтверждён", profile: "Хирургический", sourceSessionId: "source-unknown", idempotencyKey: "unknown-create" },
      { sessionId: "source-unknown", doctorToken: token, result: FRONTEND_RESULT });
    expect(await service.preparation(grant.token)).toMatchObject({ items: [], confirmedCompleteness: "unknown", catalogueAvailable: false, careContext: "unknown" });
  });
  it("migrates a genuine v3 snapshot without reviving legacy patient claims into the active package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "demeu-preparation-"));
    const path = join(dir, "referrals.json");
    let repo = new FileReferralRepository(path);
    try {
      const service = new ReferralService(repo, { catalogue, now: () => dateNow });
      const { grant } = await episode(service);
      await service.reportPreparation(grant.token, grant.accessId, report());
      expect(await readFile(path, "utf8")).not.toContain(grant.token);
      await repo.close();
      const legacyV3 = JSON.parse(await readFile(path, "utf8"));
      legacyV3.schemaVersion = 3;
      for (const record of legacyV3.referrals) {
        delete record.doctorAssessment;
        delete record.requirementSnapshotId;
        record.events = record.events.filter((event: { type: string }) => event.type !== "doctor_assessment_changed");
        record.events.forEach((event: { revision: number }, index: number) => { event.revision = index + 1; });
        record.revision = record.events.length;
        record.updatedAt = record.events.at(-1).recordedAt;
        for (const examination of record.examinations) delete examination.requirementSnapshotId;
      }
      legacyV3.commands = legacyV3.commands.filter((command: { payload: string }) => !command.payload.includes('"action":"doctor_assessment"'));
      for (const reportEntry of legacyV3.patientReports) delete reportEntry.requirementSnapshotId;
      delete legacyV3.patientAccess[0].sourceLinkHash;
      await writeFile(path, JSON.stringify(legacyV3));
      repo = new FileReferralRepository(path);
      const restored = new ReferralService(repo, { now: () => dateNow + 2 * 86400000 });
      expect(await restored.preparation(grant.token)).toMatchObject({ items: [], careContext: "unknown", confirmedCompleteness: "unknown" });
      expect(await repo.read((state) => state.patientReports?.length)).toBe(1);
      expect(await repo.read((state) => state.patientAccess?.[0].sourceLinkHash)).toBe(null);
    } finally { await repo.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe("patient reports: audit, dates, revision and physician confirmation", () => {
  it("records two claims, updates preparation but never marks clinician readiness", async () => {
    const { service } = setup(); const { grant, referral } = await episode(service);
    await service.reportPreparation(grant.token, grant.accessId, report());
    const packageData = await service.reportPreparation(grant.token, grant.accessId, report({ requirementId: "r2", idempotencyKey: "second-report" }));
    expect(packageData.items.slice(0, 2).map((item) => item.preparationStatus)).toEqual(["present", "present"]);
    expect(packageData.confirmedCompleteness).toBe("unknown");
    const detail = await service.detail(doctor, referral.id);
    expect(detail.examinations).toHaveLength(0);
    expect(detail.patientReports).toHaveLength(2);
    expect(detail.patientReports?.[0]).toMatchObject({ source: "patient_self_report", actorAccessId: grant.accessId, recordedAt: dateNow, revision: 1 });
  });
  it("replays one successful command, rejects changed replay and stale/concurrent edits", async () => {
    const { service, repository } = setup(); const { grant } = await episode(service);
    await service.reportPreparation(grant.token, grant.accessId, report());
    await service.reportPreparation(grant.token, grant.accessId, report());
    expect(await repository.read((state) => state.patientReports?.length)).toBe(1);
    await expect(service.reportPreparation(grant.token, grant.accessId, report({ performedOn: "2026-10-02" }))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const responses = await Promise.allSettled([
      service.reportPreparation(grant.token, grant.accessId, report({ expectedRevision: 1, performedOn: "2026-10-02", idempotencyKey: "edit1" })),
      service.reportPreparation(grant.token, grant.accessId, report({ expectedRevision: 1, performedOn: "2026-10-03", idempotencyKey: "edit2" })),
    ]);
    expect(responses.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect((responses.find((entry) => entry.status === "rejected") as PromiseRejectedResult).reason.code).toBe("REVISION_CONFLICT");
  });
  it("rejects future/invalid dates, unknown fields, fabricated expiration and unconfirmed conditional applicability", async () => {
    const { service } = setup(); const { grant } = await episode(service);
    for (const performedOn of ["2026-10-05", "2026-02-30", "yesterday"]) await expect(service.reportPreparation(grant.token, grant.accessId, report({ performedOn }))).rejects.toMatchObject({ status: 400 });
    await expect(service.reportPreparation(grant.token, grant.accessId, { ...report(), expiresOn: "2099-01-01" } as PatientReportInput)).rejects.toMatchObject({ status: 400 });
    await expect(service.reportPreparation(grant.token, grant.accessId, report({ requirementId: "r3" }))).rejects.toMatchObject({ code: "APPLICABILITY_UNCONFIRMED" });
  });
  it("calculates expiry server-side and checks appointed date, including past date before actual test", async () => {
    const { service } = setup(); const { grant, referral } = await episode(service);
    const scheduled = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "date", patch: { scheduledDate: "2026-10-10" } });
    const next = await service.reportPreparation(grant.token, grant.accessId, report());
    expect(next.items[0]).toMatchObject({ expiresOn: "2026-10-08", preparationStatus: "expired", expiringBeforeAdmission: true });
    await service.update(doctor, referral.id, { expectedRevision: scheduled.revision, idempotencyKey: "past", patch: { scheduledDate: "2026-09-30" }, reason: "Изменение даты" });
    expect((await service.preparation(grant.token)).items[0].preparationStatus).toBe("unknown");
  });
  it("requires explicit authorized physician confirmation and preserves an auditable pointer", async () => {
    const { service, repository } = setup(undefined, true); const { grant, referral } = await episode(service);
    await service.reportPreparation(grant.token, grant.accessId, report());
    const claim = (await service.detail(doctor, referral.id)).patientReports![0];
    const input = { reportId: claim.id, expectedRevision: referral.revision, expectedReportRevision: 1, idempotencyKey: "confirm" };
    for (const actor of [{ ...doctor, id: "colleague" }, { ...doctor, organizationId: "elsewhere" }, { ...doctor, role: "analyst" as const }, { ...doctor, role: "owner" as const }]) await expect(service.confirmPatientReport(actor, referral.id, input)).rejects.toMatchObject({ status: ["analyst", "owner"].includes(actor.role) ? 403 : 404 });
    const confirmed = await service.confirmPatientReport(doctor, referral.id, input);
    expect(confirmed.examinations[0]).toMatchObject({ patientReportId: claim.id, expiresOn: "2026-10-08", applicability: "yes" });
    expect(confirmed.events.at(-1)).toMatchObject({ source: "doctor_confirmation", actorId: doctor.id });
    expect((await service.preparation(grant.token)).items[0].selfReport?.confirmed).toBe(true);
    expect((await service.confirmPatientReport(doctor, referral.id, input)).revision).toBe(referral.revision + 1);
    const state = await repository.read((entry) => entry);
    expect(validateReferralDatabase(state).schemaVersion).toBe(REFERRAL_DATABASE_SCHEMA_VERSION);
    state.referrals[0].events[state.referrals[0].events.length - 1].after = { ...confirmed.examinations[0], patientReportId: "invented" };
    state.referrals[0].examinations[0].patientReportId = "invented";
    expect(() => validateReferralDatabase(state)).toThrow("Invalid referral snapshot");
  });
  it("limits append volume, rejects identical changes, and rates patient history durably", async () => {
    const { service, advance } = setup(); const { grant } = await episode(service);
    for (let i = 0; i < 10; i++) await service.reportPreparation(grant.token, grant.accessId, report({ expectedRevision: i, resultAvailable: i % 2 === 0, idempotencyKey: `change-${i}` }));
    await expect(service.reportPreparation(grant.token, grant.accessId, report({ expectedRevision: 10, resultAvailable: false, idempotencyKey: "noop" }))).rejects.toMatchObject({ code: "NO_CHANGES" });
    await expect(service.reportPreparation(grant.token, grant.accessId, report({ expectedRevision: 10, idempotencyKey: "rate" }))).rejects.toMatchObject({ status: 429 });
    advance(60001);
    for (let i = 10; i < 20; i++) await service.reportPreparation(grant.token, grant.accessId, report({ expectedRevision: i, resultAvailable: i % 2 === 0, idempotencyKey: `change-${i}` }));
    advance(60001);
    await expect(service.reportPreparation(grant.token, grant.accessId, report({ expectedRevision: 20, idempotencyKey: "cap" }))).rejects.toMatchObject({ code: "REPORT_LIMIT" });
  });
});

describe("patient API: cookie, CSRF, recovery, reissue and PDF", () => {
  it("exchanges a bearer for scoped cookie; duplicate/cross-episode/missing cookies cannot read or write", async () => {
    const { service } = setup(); const { grant } = await episode(service);
    const exchange = await handlePreparationAccess(request("/api/patient/access", { token: grant.token }), { service });
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get("referrer-policy")).toBe("no-referrer");
    expect(exchange.headers.get("set-cookie")).toContain("Path=/api/patient; HttpOnly; SameSite=Strict");
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0];
    expect((await handlePreparation(request(`/api/patient/${grant.accessId}/package`, undefined, cookie), grant.accessId, { service })).status).toBe(200);
    for (const cookies of [undefined, `${cookie}; ${cookie}`]) expect((await handlePreparation(request("/api/patient/x/package", undefined, cookies), grant.accessId, { service })).status).toBe(401);
    expect((await handlePreparation(request("/api/patient/x/package", report(), cookie, "https://attacker.test"), grant.accessId, { service })).status).toBe(403);
    expect((await handlePreparationAccess(request("/api/patient/access", { token: grant.token }, undefined, "https://attacker.test"), { service })).status).toBe(403);
  });
  it("accepts only the explicit JSON/PDF package query contract", async () => {
    const { service } = setup(); const { grant } = await episode(service);
    const cookie = preparationCookie(grant.accessId, grant.token, grant.expiresAt, dateNow).split(";")[0];
    const jsonResponse = await handlePreparation(request("/package", undefined, cookie), grant.accessId, { service });
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.headers.get("content-type")).toContain("application/json");
    for (const path of ["/package?format=pdf", "/package?format=pdf&lang=ru", "/package?format=pdf&lang=kk"]) {
      const response = await handlePreparation(request(path, undefined, cookie), grant.accessId, { service });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
    }
    for (const path of [
      "/package?format=json", "/package?lang=kk", "/package?format=pdf&lang=en", "/package?format=pdf&extra=1",
      "/package?format=pdf&format=pdf", "/package?format=pdf&lang=ru&lang=kk",
    ]) {
      const response = await handlePreparation(request(path, undefined, cookie), grant.accessId, { service });
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
    }
  });
  it("checks package capability and same-origin protections before rejecting query", async () => {
    const { service } = setup(); const { grant } = await episode(service);
    const cookie = preparationCookie(grant.accessId, grant.token, grant.expiresAt, dateNow).split(";")[0];
    const forgedCookie = preparationCookie(grant.accessId, "x".repeat(43), grant.expiresAt, dateNow).split(";")[0];
    expect((await handlePreparation(request("/package?unknown=1"), grant.accessId, { service })).status).toBe(401);
    expect((await handlePreparation(request("/package?unknown=1", undefined, forgedCookie), grant.accessId, { service })).status).toBe(401);
    expect((await handlePreparation(request("/package?unknown=1", report(), forgedCookie), grant.accessId, { service })).status).toBe(401);
    const crossSite = new Request("http://localhost/package?unknown=1", { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } });
    expect((await handlePreparation(crossSite, grant.accessId, { service })).status).toBe(403);
    expect((await handlePreparation(request("/package?unknown=1", report(), cookie, "https://attacker.test"), grant.accessId, { service })).status).toBe(403);
    expect((await handlePreparationAccess(request("/api/patient/access?unknown=1", { token: "x".repeat(43) }), { service })).status).toBe(401);
    expect((await handleDiscoverPreparation(request("/api/patient/discover?unknown=1", { token: "1234567890abcdef" }, cookie), { service })).status).toBe(401);
  });
  it("rejects query strings on every patient-package POST surface after its security gate", async () => {
    const { service } = setup(); const { grant, referral } = await episode(service);
    const cookie = preparationCookie(grant.accessId, grant.token, grant.expiresAt, dateNow).split(";")[0];
    const claimInput = { reportId: "unused", expectedRevision: 1, expectedReportRevision: 1, idempotencyKey: "confirm-query" };
    const responses = await Promise.all([
      handlePreparationAccess(request(`/api/patient/access?x=1`, { token: grant.token }), { service }),
      handleDiscoverPreparation(request(`/api/patient/discover?x=1`, { token }, cookie), { service }),
      handlePreparation(request(`/package?x=1`, report(), cookie), grant.accessId, { service }),
      handleManagePreparation(request(`/access?x=1`, { action: "revoke", expectedAccessRevision: 1, idempotencyKey: "revoke-query" }), referral.id, { service, actor: async () => doctor }),
      handleConfirmPreparation(request(`/confirm?x=1`, claimInput), referral.id, { service, actor: async () => doctor }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400]);
    for (const response of responses) expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect((await handlePreparationAccess(request("/api/patient/access?x=1", { token: grant.token }, undefined, "https://attacker.test"), { service })).status).toBe(403);
    expect((await handleManagePreparation(request("/access?x=1", { action: "revoke", expectedAccessRevision: 1, idempotencyKey: "other-query" }), referral.id,
      { service, actor: async () => ({ ...doctor, id: "other" }) })).status).toBe(404);
    expect((await handleConfirmPreparation(request("/confirm?x=1", claimInput), referral.id,
      { service, actor: async () => ({ ...doctor, role: "owner" }) })).status).toBe(403);
  });
  it("original URL discovers only its episode from actual capability cookie after storage loss", async () => {
    const { service } = setup(); const { grant } = await episode(service);
    const cookie = preparationCookie(grant.accessId, grant.token, grant.expiresAt, dateNow).split(";")[0];
    expect((await handleDiscoverPreparation(request("/api/patient/discover", { token }), { service })).status).toBe(401);
    const result = await handleDiscoverPreparation(request("/api/patient/discover", { token }, cookie), { service });
    expect(result.status).toBe(200);
    expect((await result.json()).package.accessId).toBe(grant.accessId);
    expect((await handleDiscoverPreparation(request("/api/patient/discover", { token: "1234567890abcdef" }, cookie), { service })).status).toBe(401);
  });
  it("preserves chat response/cookie during grant write failure and recovers same grant without plaintext persistence", async () => {
    const { service, repository } = setup(); await service.bindLink(token, doctor);
    const start = () => Response.json({ sessionId: "source-1", reply: "Опрос", turnsLeft: 20 }, { headers: { "Set-Cookie": "chat=proof; Path=/api/chat; HttpOnly" } });
    const original = service.issuePreparation.bind(service);
    const stub = vi.spyOn(service, "issuePreparation").mockRejectedValueOnce(new Error("disk failure"));
    const failed = await attachStartedPreparation(start(), token, { service });
    expect(failed.status).toBe(200); expect((await failed.json()).preparationPending).toBe(true);
    expect(failed.headers.get("set-cookie")).toContain("chat=proof");
    stub.mockImplementation(original);
    const recovered = await attachStartedPreparation(start(), token, { service });
    const recoveredData = await recovered.json();
    const replay = await attachStartedPreparation(start(), token, { service });
    expect((await replay.json()).preparationId).toBe(recoveredData.preparationId);
    expect(await repository.read((state) => state.patientAccess?.length)).toBe(1);
    await repository.transaction((state) => { state.patientAccess![0].sourceLinkHash = null; });
    const backfilled = await attachStartedPreparation(start(), token, { service });
    const recoveredCookie = backfilled.headers.getSetCookie().find((entry) => entry.includes("demeu_preparation_"))!.split(";")[0];
    expect((await service.discoverPreparation(token, recoveredCookie)).accessId).toBe(recoveredData.preparationId);
    expect(await repository.read((state) => state.patientAccess![0].sourceLinkHash)).not.toBeNull();
    vi.stubEnv("DEMEU_AUTH_SECRET", "new-key".repeat(8));
    expect((await (await attachStartedPreparation(start(), token, { service })).json()).preparationPending).toBe(true);
    expect(await repository.read((state) => state.patientAccess?.length)).toBe(1);
  });
  it("reissue is revision-gated and idempotent, revokes old grant, and old report cannot replay", async () => {
    const { service } = setup(); const { grant, referral } = await episode(service);
    await service.reportPreparation(grant.token, grant.accessId, report());
    const deps = { service, actor: async () => doctor };
    const input = { action: "reissue", expectedAccessRevision: 1, idempotencyKey: "reissue" };
    const first = await handleManagePreparation(request(`/api/referrals/${referral.id}/patient-access`, input), referral.id, deps);
    const firstData = await first.json(); expect(first.status).toBe(200);
    const replay = await handleManagePreparation(request("/access", input), referral.id, deps);
    expect((await replay.json()).preparationUrl).toBe(firstData.preparationUrl);
    await expect(service.preparation(grant.token)).rejects.toMatchObject({ status: 401 });
    await expect(service.reportPreparation(grant.token, grant.accessId, report())).rejects.toMatchObject({ status: 401 });
    expect((await handleManagePreparation(request("/access", { ...input, idempotencyKey: "competing" }), referral.id, deps)).status).toBe(409);
    const current = await service.preparationStatus(doctor, referral.id);
    const revoked = await handleManagePreparation(request("/access", { action: "revoke", expectedAccessRevision: current.accessRevision, idempotencyKey: "revoke" }), referral.id, deps);
    expect(revoked.status).toBe(200);
    await expect(service.preparation(firstData.preparationUrl.slice(3))).rejects.toMatchObject({ status: 401 });
    const retryInitial = await attachStartedPreparation(Response.json({ sessionId: "source-1" }), token, { service });
    expect((await retryInitial.json()).preparationPending).toBe(true);
  });
  it("rejects other doctor/organization/analyst reissue and invalid/missing command key as client errors", async () => {
    const { service } = setup(); const { referral } = await episode(service);
    for (const actor of [{ ...doctor, id: "elsewhere" }, { ...doctor, organizationId: "other" }, { ...doctor, role: "analyst" as const }]) {
      const response = await handleManagePreparation(request("/access", { action: "reissue", expectedAccessRevision: 1, idempotencyKey: "key" }), referral.id, { service, actor: async () => actor });
      expect(response.status).toBe(actor.role === "analyst" ? 403 : 404);
    }
    expect((await handleManagePreparation(request("/access", { action: "reissue", expectedAccessRevision: 1 }), referral.id, { service, actor: async () => doctor })).status).toBe(400);
  });
  it("PDF whitelist is readable for RU/KK and accurately identifies verified vs reported facts", async () => {
    const { service } = setup(); const { grant, referral } = await episode(service);
    await service.reportPreparation(grant.token, grant.accessId, report());
    let data = await service.preparation(grant.token);
    expect(renderPreparationText(data)).toContain("со слов пациента, требует проверки врача");
    expect(renderPreparationText(data, "kk")).toContain("пациент белгісі");
    const claim = (await service.detail(doctor, referral.id)).patientReports![0];
    const response = await handleConfirmPreparation(request("/confirm", { reportId: claim.id, expectedRevision: referral.revision, expectedReportRevision: 1, idempotencyKey: "confirm" }), referral.id, { service, actor: async () => doctor });
    expect(response.status).toBe(200);
    data = await service.preparation(grant.token);
    expect(renderPreparationText(data)).toContain("подтверждено врачом");
    expect(renderPreparationText(data)).not.toContain(FRONTEND_RESULT.hypothesis.text);
    const cookie = preparationCookie(grant.accessId, grant.token, grant.expiresAt, dateNow).split(";")[0];
    for (const lang of ["ru", "kk"]) {
      const pdf = await handlePreparation(request(`/package?format=pdf&lang=${lang}`, undefined, cookie), grant.accessId, { service });
      expect(pdf.status).toBe(200); expect(pdf.headers.get("content-type")).toBe("application/pdf");
      expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    }
  });
});

describe("patient snapshot migration and integrity", () => {
  it("rejects missing current-schema arrays, nonnumeric/future schema, TTL expansion and cross-ref grant binding", async () => {
    const { service, repository } = setup(); await episode(service);
    const state = await repository.read((entry) => entry);
    for (const version of [String(REFERRAL_DATABASE_SCHEMA_VERSION), true, REFERRAL_DATABASE_SCHEMA_VERSION + 1]) {
      expect(() => validateReferralDatabase({ ...state, schemaVersion: version })).toThrow();
    }
    expect(() => validateReferralDatabase({ ...state, patientAccess: undefined })).toThrow();
    const extended = structuredClone(state); extended.patientAccess![0].expiresAt += PREPARATION_TTL_MS;
    expect(() => validateReferralDatabase(extended)).toThrow();
    const cross = structuredClone(state); cross.patientAccess![0].organizationId = "other";
    expect(() => validateReferralDatabase(cross)).toThrow();
    const falseLink = structuredClone(state); falseLink.patientAccess![0].sourceLinkHash = "a".repeat(64);
    expect(() => validateReferralDatabase(falseLink)).toThrow();
  });
});
