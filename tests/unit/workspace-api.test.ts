import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryReferralRepository, ReferralService } from "../../lib/referrals/service";
import { MemorySessionStore } from "../../lib/store";
import { LinkRateLimiter } from "../../lib/rate-limit";
import { analyze } from "../../lib/triage";
import type { TriageResult } from "../../lib/types";
import { failingLlm } from "../fixtures/triage.ports";
import { WorkspaceAuthError, type WorkspaceActor } from "../../lib/workspace-auth";
import {
  handleReferrals, handleReferral, handleReferralEvents, handleReferralExaminations,
  handlePatientMemo, handleWorkspaceAggregates, handleWorkspaceIntake, handleWorkspaceIntakes, handleWorkspaceLink,
  workspaceBoundary,
  type WorkspaceApiDeps,
} from "../../lib/workspace-api";
import { POST as linkRoute } from "../../app/api/link/route";
import { handleReferralNotify } from "../../app/api/referrals/[id]/notify/handler";

const BASE = "https://workspace.example.test";
const doctor: WorkspaceActor = { id: "doctor-a", displayName: "Doctor A", role: "doctor", organizationId: "clinic-a" };
const other: WorkspaceActor = { ...doctor, id: "doctor-b", displayName: "Doctor B" };
const outsider: WorkspaceActor = { ...doctor, id: "doctor-c", organizationId: "clinic-b" };
const owner: WorkspaceActor = { ...doctor, id: "owner-a", role: "owner" };
const analyst: WorkspaceActor = { ...doctor, id: "analyst-a", role: "analyst" };
let referrals: ReferralService;
let sessions: MemorySessionStore;
let result: TriageResult;
let key = 0;

beforeAll(async () => {
  result = await analyze([{ role: "user", content: "Тестовый опрос" }], { llm: failingLlm({ calls: 0 }) });
});
beforeEach(() => {
  referrals = new ReferralService(new MemoryReferralRepository());
  sessions = new MemorySessionStore();
  vi.stubEnv("APP_BASE_URL", BASE);
});
afterEach(() => vi.unstubAllEnvs());

function deps(actor: WorkspaceActor = doctor): WorkspaceApiDeps {
  return { actor: async () => actor, referrals, sessions, limiter: new LinkRateLimiter(() => 0) };
}
function req(method = "GET", payload?: unknown, origin = BASE, pathname = "/api/referrals"): Request {
  const headers = new Headers({ origin, "x-forwarded-for": "192.0.2.35" });
  if (payload !== undefined) headers.set("content-type", "application/json");
  return new Request(`${BASE}${pathname}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
}
function input(extra: Record<string, unknown> = {}) {
  return { patientLabel: "Тестовый эпизод", profile: "Хирургический", idempotencyKey: `request-${++key}`, ...extra };
}
function persistedPayload(payload: { referral: Record<string, unknown> }) {
  const referral = { ...payload.referral };
  // Replays re-evaluate current age and completeness; persisted history is stable.
  delete referral.observedStageDays;
  delete referral.completeness;
  delete referral.flow;
  return { referral };
}
async function makeReferral(actor = doctor) {
  return referrals.create(actor, input());
}
async function intake(actor: WorkspaceActor | null = doctor, completed = true) {
  const token = await sessions.createDoctorToken();
  if (actor) await referrals.bindLink(token, actor);
  const session = await sessions.createSession(token);
  await sessions.appendMessage(session.id, { role: "user", content: "private transcript never returned" });
  if (completed) await sessions.completeSession(session.id, result);
  return session;
}

describe("workspace HTTP authorization", () => {
  it("classifies branded errors across module instances without accepting arbitrary status objects", async () => {
    // A global runtime may retain an error constructor from an earlier bundle.
    for (const [brand, status, code] of [
      ["demeu.WorkspaceAuthError", 401, "UNAUTHORIZED"],
      ["demeu.ReferralError", 409, "REVISION_CONFLICT"],
    ] as const) {
      const brandKey = Symbol.for(brand);
      class OtherModuleError extends Error {
        readonly [brandKey] = true;
        readonly status = status;
        readonly code = code;
      }
      const response = await workspaceBoundary(async () => { throw new OtherModuleError("private detail"); });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
    for (const value of [
      { status: 403, code: "FORBIDDEN", name: "WorkspaceAuthError" },
      { [Symbol.for("demeu.WorkspaceAuthError")]: true, status: 200, code: "FORBIDDEN" },
      { [Symbol.for("demeu.ReferralError")]: true, status: 404, code: "patient private text" },
    ]) {
      const response = await workspaceBoundary(async () => { throw value; });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "INTERNAL", error: "Внутренняя ошибка" });
    }
  });

  it("requires authentication before reading data", async () => {
    const listSessions = vi.fn(async () => []);
    const unauthorized = { ...deps(), actor: async (): Promise<WorkspaceActor> => { throw new WorkspaceAuthError(401, "UNAUTHORIZED"); }, sessions: { ...sessions, getSession: sessions.getSession.bind(sessions), createDoctorToken: sessions.createDoctorToken.bind(sessions), listSessions } };
    const response = await handleWorkspaceIntakes(req(), unauthorized);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("blocks analysts from every detailed surface, mutation and link creation", async () => {
    const item = await makeReferral();
    const restricted = deps(analyst);
    const responses = await Promise.all([
      handleReferrals(req(), restricted), handleReferrals(req("POST", input()), restricted),
      handleReferral(req(), item.id, restricted), handlePatientMemo(req(), item.id, restricted),
      handleReferralEvents(req("POST", {}), item.id, restricted),
      handleReferralExaminations(req("POST", {}), item.id, restricted),
      handleWorkspaceIntakes(req(), restricted), handleWorkspaceLink(req("POST"), restricted),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toContain(item.id);
    }
  });

  it("returns indistinguishable 404 for another doctor's records and unknown records", async () => {
    const item = await makeReferral(other);
    const hidden = await handleReferral(req(), item.id, deps());
    const absent = await handleReferral(req(), "not-found", deps());
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await absent.json());
    expect((await handlePatientMemo(req(), item.id, deps())).status).toBe(404);
    expect((await handleReferralEvents(req("POST", { expectedRevision: 1, idempotencyKey: "hidden", patch: { queue: true } }), item.id, deps())).status).toBe(404);
    const visible = await handleReferrals(req(), deps());
    expect(await visible.json()).toEqual({ referrals: [] });
    expect((await handleReferral(req(), item.id, deps(owner))).status).toBe(200);
    expect((await handleReferral(req(), item.id, deps({ ...owner, organizationId: "clinic-b" }))).status).toBe(404);
  });

  it("enforces Origin on all mutations without creating state", async () => {
    const item = await makeReferral();
    for (const origin of ["https://evil.example.test", "null", ""]) {
      const responses = await Promise.all([
        handleReferrals(req("POST", input(), origin), deps()),
        handleReferralEvents(req("POST", {}, origin), item.id, deps()),
        handleReferralExaminations(req("POST", {}, origin), item.id, deps()),
        handleWorkspaceLink(req("POST", undefined, origin), deps()),
      ]);
      expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    }
    expect(await sessions.listSessions()).toEqual([]);
    expect((await referrals.detail(doctor, item.id)).revision).toBe(1);
  });

  it("does not fall back to shared-code link auth under partial workspace configuration", async () => {
    vi.stubEnv("DEMEU_ACCOUNTS_FILE", "");
    vi.stubEnv("DEMEU_AUTH_SECRET", undefined);
    vi.stubEnv("DOCTOR_ACCESS_CODE", "shared");
    const request = req("POST");
    request.headers.set("x-doctor-code", "shared");
    const response = await linkRoute(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("token");
  });
});

describe("source sessions, ownership and data projections", () => {
  it("lists only authorized intakes and never includes tokens or transcript messages", async () => {
    const mine = await intake();
    const colleague = await intake(other);
    await intake(outsider);
    await intake(null);
    const response = await handleWorkspaceIntakes(req(), deps());
    const data = await response.json();
    expect(data.intakes.map((entry: { sessionId: string }) => entry.sessionId)).toEqual([mine.id]);
    expect(Object.keys(data.intakes[0]).sort()).toEqual(["createdAt", "deliveryStatus", "referralId", "result", "sessionId", "status"]);
    expect(data.intakes[0].referralId).toBeNull();
    expect(JSON.stringify(data)).not.toContain(mine.doctorToken);
    expect(JSON.stringify(data)).not.toContain("private transcript");
    const organization = await (await handleWorkspaceIntakes(req(), deps(owner))).json();
    expect(new Set(organization.intakes.map((entry: { sessionId: string }) => entry.sessionId))).toEqual(new Set([mine.id, colleague.id]));
  });

  it("scopes an intake detail to its doctor and same-organization owner with indistinguishable denials", async () => {
    const mine = await intake();
    const own = await handleWorkspaceIntake(req("GET", undefined, BASE, `/api/workspace/intakes/${mine.id}`), mine.id, deps());
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("no-store");
    const projection = await own.json();
    expect(Object.keys(projection.intake).sort()).toEqual(["createdAt", "deliveryStatus", "referralId", "result", "sessionId", "status"]);
    expect(JSON.stringify(projection)).not.toContain(mine.doctorToken);
    expect(JSON.stringify(projection)).not.toContain("private transcript");
    expect((await handleWorkspaceIntake(req(), mine.id, deps(owner))).status).toBe(200);

    const missing = await handleWorkspaceIntake(req(), "missing", deps());
    for (const principal of [other, outsider, analyst]) {
      const hidden = await handleWorkspaceIntake(req(), mine.id, deps(principal));
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual(await missing.clone().json());
    }
  });

  it("requires login before resolving an intake detail", async () => {
    const mine = await intake();
    const getSession = vi.fn(sessions.getSession.bind(sessions));
    const response = await handleWorkspaceIntake(req(), mine.id, {
      ...deps(),
      actor: async (): Promise<WorkspaceActor> => { throw new WorkspaceAuthError(401, "UNAUTHORIZED"); },
      sessions: { getSession, createDoctorToken: sessions.createDoctorToken.bind(sessions), listSessions: sessions.listSessions.bind(sessions) },
    });
    expect(response.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("derives a source snapshot and owner server-side, including owner acting for a doctor", async () => {
    const source = await intake(other);
    const response = await handleReferrals(req("POST", input({ sourceSessionId: source.id })), deps(owner));
    expect(response.status).toBe(200);
    const { referral } = await response.json();
    expect(referral.doctorId).toBe(other.id);
    expect(referral.organizationId).toBe(other.organizationId);
    expect(referral.triageSnapshot).toMatchObject({ source: "rules_only", hypothesis: result.hypothesis });
    expect(referral.triageSnapshot).not.toHaveProperty("messages");
    expect(JSON.stringify(referral)).not.toContain(source.doctorToken);
    expect(referral.queue).toBeNull();
    expect(referral.scheduledDate).toBeNull();
    expect(referral.attendance).toBeNull();
    const intakes = await (await handleWorkspaceIntakes(req(), deps(owner))).json();
    expect(intakes.intakes.find((entry: { sessionId: string }) => entry.sessionId === source.id).referralId).toBe(referral.id);

    const duplicate = await handleReferrals(req("POST", input({ sourceSessionId: source.id, patientLabel: "Повтор" })), deps(owner));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).referral.id).toBe(referral.id);
    expect(await referrals.list(owner)).toHaveLength(1);
  });

  it("rejects foreign, orphan and unfinished source sessions without revealing foreign status", async () => {
    const foreign = await intake(other, false);
    const orphan = await intake(null);
    const unfinished = await intake(doctor, false);
    for (const sourceSessionId of [foreign.id, orphan.id, "unknown-id"]) {
      const response = await handleReferrals(req("POST", input({ sourceSessionId })), deps());
      expect(response.status).toBe(404);
    }
    const response = await handleReferrals(req("POST", input({ sourceSessionId: unfinished.id })), deps());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SOURCE_SESSION_NOT_COMPLETED" });
    expect(await referrals.list(doctor)).toEqual([]);
  });

  it("rejects client-forged ownership, actor history and triage snapshots", async () => {
    for (const field of ["doctorId", "organizationId", "actorId", "triageSnapshot", "source", "events"]) {
      const response = await handleReferrals(req("POST", input({ [field]: "forged" })), deps());
      expect(response.status).toBe(400);
    }
    const item = await makeReferral();
    const response = await handleReferralEvents(req("POST", { expectedRevision: 1, idempotencyKey: "forged-history", patch: { queue: true }, actorId: other.id }), item.id, deps());
    expect(response.status).toBe(400);
    expect((await referrals.detail(doctor, item.id)).revision).toBe(1);
  });

  it("creates links only after the ownership binding succeeds, charging the limiter", async () => {
    const injected = deps();
    for (let i = 0; i < 10; i++) {
      const response = await handleWorkspaceLink(req("POST"), injected);
      expect(response.status).toBe(200);
      const { token } = await response.json();
      expect(await referrals.ownerForToken(token)).toEqual(doctor);
    }
    const limited = await handleWorkspaceLink(req("POST"), injected);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("6");
    const failed = await handleWorkspaceLink(req("POST"), { ...deps(), referrals: {
      list: referrals.list.bind(referrals), detail: referrals.detail.bind(referrals), create: referrals.create.bind(referrals),
      replayCreate: referrals.replayCreate.bind(referrals),
      update: referrals.update.bind(referrals), examination: referrals.examination.bind(referrals), memo: referrals.memo.bind(referrals),
      aggregates: referrals.aggregates.bind(referrals), ownerForToken: referrals.ownerForToken.bind(referrals),
      bindLink: async () => { throw new Error("private disk location"); },
    } });
    expect(failed.status).toBe(500);
    const failedBody = await failed.json();
    expect(failedBody).not.toHaveProperty("token");
    expect(JSON.stringify(failedBody)).not.toContain("private disk");
  });
});

describe("commands, memo and aggregate HTTP contracts", () => {
  it("replays a source-based create after the original intake expires", async () => {
    const source = await intake();
    const create = input({ sourceSessionId: source.id });
    const original = await (await handleReferrals(req("POST", create), deps())).json();
    const getSession = vi.fn(async () => undefined);
    const repeated = await handleReferrals(req("POST", create), { ...deps(), sessions: {
      getSession, createDoctorToken: sessions.createDoctorToken.bind(sessions), listSessions: sessions.listSessions.bind(sessions),
    } });
    expect(repeated.status).toBe(200);
    expect(persistedPayload(await repeated.json())).toEqual(persistedPayload(original));
    expect(getSession).not.toHaveBeenCalled();
  });

  it("keeps create/update retries idempotent and rejects stale revisions", async () => {
    const create = input();
    const first = await (await handleReferrals(req("POST", create), deps())).json();
    const repeated = await (await handleReferrals(req("POST", create), deps())).json();
    expect(persistedPayload(repeated)).toEqual(persistedPayload(first));
    const command = { expectedRevision: 1, idempotencyKey: "event-id", patch: { queue: true } };
    const response = await handleReferralEvents(req("POST", command), first.referral.id, deps());
    const second = await response.json();
    expect(response.status).toBe(200);
    expect(second.referral.events).toHaveLength(2);
    expect(second.referral.events[1].actorId).toBe(doctor.id);
    expect(second.referral.events[1].occurredAt).toBeNull();
    expect(persistedPayload(await (await handleReferralEvents(req("POST", command), first.referral.id, deps())).json())).toEqual(persistedPayload(second));
    const stale = await handleReferralEvents(req("POST", { ...command, idempotencyKey: "another", patch: { sent: true } }), first.referral.id, deps());
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("records examinations and delivers only the patient-safe memo projection", async () => {
    const source = await intake();
    const { referral } = await (await handleReferrals(req("POST", input({ sourceSessionId: source.id })), deps())).json();
    const response = await handleReferralExaminations(req("POST", {
      expectedRevision: 1, idempotencyKey: "exam-id",
      record: { requirementId: "manual-test", label: "Тестовый документ", resultAvailable: null, performedOn: null, expiresOn: null, applicability: "unknown" },
    }), referral.id, deps());
    expect(response.status).toBe(200);
    const memo = await (await handlePatientMemo(req(), referral.id, deps())).json();
    expect(Object.keys(memo.memo).sort()).toEqual(["careContext", "catalogueAvailable", "destinationOrganization", "items", "patientLabel", "scheduledDate"].sort());
    expect(memo.memo.catalogueAvailable).toBe(false);
    expect(JSON.stringify(memo)).not.toMatch(/hypothesis|anamnesis|triageSnapshot|sourceSessionId|doctorToken/u);
  });

  it("passes a recorded expired examination to the doctor's notification without draft requirements", async () => {
    const fixed = new ReferralService(new MemoryReferralRepository(), { now: () => Date.parse("2026-09-18T12:00:00Z") });
    let created = await fixed.create(doctor, input());
    created = await fixed.assess(doctor, created.id, { expectedRevision: created.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "notify-assessment", reason: "Тестовый operative контекст",
      assessment: { hypothesis: null, profile: created.profile, icd10Code: created.icd10Code ?? null, careContext: "operative" } });
    const scheduled = await fixed.update(doctor, created.id, {
      expectedRevision: created.revision, idempotencyKey: "scheduled-notify", patch: { scheduledDate: "2026-09-25" },
    });
    const examined = await fixed.examination(doctor, created.id, {
      expectedRevision: scheduled.revision, idempotencyKey: "exam-notify",
      record: { requirementId: "cbc", label: "Общий анализ крови", performedOn: "2026-08-01", expiresOn: "2026-08-11", resultAvailable: true, applicability: "yes" },
    });
    let delivered: unknown;
    const response = await handleReferralNotify(req("POST", {
      expectedRevision: examined.revision, idempotencyKey: "notify-123",
    }, BASE, `/api/referrals/${created.id}/notify`), created.id, {
      actor: async () => doctor,
      detail: (actor, id) => fixed.detail(actor, id),
      send: async (_actor, _referral, memo) => { delivered = memo; return { sent: true }; },
    });
    expect(response.status).toBe(200);
    const deliveredMemo = delivered as { catalogueAvailable: boolean; items: { label: string; status: string; expiresOn: string | null }[] };
    expect(deliveredMemo.catalogueAvailable).toBe(false);
    expect(deliveredMemo.items[0]).toEqual({ label: "Общий анализ крови (развернутый)", status: "expired", expiresOn: "2026-08-11" });
    expect(deliveredMemo.items[1]).toEqual({ label: "Общий анализ мочи", status: "unknown", expiresOn: null });
    expect(deliveredMemo.items).toHaveLength(13);
    expect(deliveredMemo.items.slice(1).every((item) => item.status === "unknown")).toBe(true);
  });

  it("returns a separate suppressed aggregate DTO for analysts and rejects ad-hoc filters", async () => {
    const item = await makeReferral();
    const response = await handleWorkspaceAggregates(req(), deps(analyst));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.aggregates).toMatchObject({ suppressed: true, total: null, forecast: null });
    expect(JSON.stringify(data)).not.toContain(item.id);
    expect(JSON.stringify(data)).not.toContain(item.patientLabel);
    const filtered = await handleWorkspaceAggregates(req("GET", undefined, BASE, "/api/workspace/aggregates?doctorId=doctor-a"), deps(analyst));
    expect(filtered.status).toBe(400);
  });

  it("rejects oversized streamed bodies and sanitizes unexpected backend errors", async () => {
    const large = await handleReferrals(req("POST", input({ patientLabel: "x".repeat(17_000) })), deps());
    expect(large.status).toBe(413);
    expect(large.headers.get("cache-control")).toBe("no-store");
    const failed = await handleWorkspaceIntakes(req(), { ...deps(), sessions: {
      getSession: sessions.getSession.bind(sessions), createDoctorToken: sessions.createDoctorToken.bind(sessions),
      listSessions: async () => { throw new Error("private medical record and disk path"); },
    } });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ code: "INTERNAL", error: "Внутренняя ошибка" });
  });
});
