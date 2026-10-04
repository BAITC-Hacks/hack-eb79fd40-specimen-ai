import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  loadReferralRiskArtifact, REFERRAL_RISK_ARTIFACT_SHA256, REFERRAL_RISK_FEATURES,
  referralRiskToken, scoreReferralRisk, validateReferralRiskArtifact,
  type ReferralRiskArtifact,
} from "../../lib/referral-risk";
import { MemoryReferralRepository, ReferralService, validateReferralDatabase } from "../../lib/referrals/service";
import type { ReferralActor, RegistrationFeatures } from "../../lib/referrals/types";
import { handleReferralRisk, handleRegistrationSnapshot } from "../../lib/workspace-api";
import { WorkspaceAuthError } from "../../lib/workspace-auth";

const doctor: ReferralActor = { id: "doctor-a", displayName: "Врач А", role: "doctor", organizationId: "org-a" };
const colleague: ReferralActor = { ...doctor, id: "doctor-b", displayName: "Врач Б" };
const owner: ReferralActor = { ...doctor, id: "owner-a", role: "owner" };
const analyst: ReferralActor = { ...doctor, id: "analyst-a", role: "analyst" };
const foreign: ReferralActor = { ...doctor, id: "foreign", organizationId: "org-z" };
const features: RegistrationFeatures = {
  bed_profile: null,
  icd10_ref_diag_code: "synthetic-icd",
  referring_mo: "synthetic-referring",
  hospital_mo: "synthetic-hospital",
  territorial_type: "synthetic-territory",
  finance_source: "synthetic-finance",
  referral_purpose: "synthetic-purpose",
};
const post = (body: unknown, path = "/api/referrals/r/registration-snapshot") => new Request(`https://workspace.test${path}`, {
  method: "POST", headers: { "content-type": "application/json", origin: "https://workspace.test" }, body: JSON.stringify(body),
});
const get = (path = "/api/referrals/r/risk") => new Request(`https://workspace.test${path}`);

function setup() {
  const repository = new MemoryReferralRepository();
  let id = 0;
  const service = new ReferralService(repository, { now: () => 1_780_000_000_000, id: () => `risk-${++id}` });
  return { repository, service };
}
async function create(service: ReferralService) {
  return service.create(doctor, { patientLabel: "Исследовательский эпизод", profile: "Хирургический", idempotencyKey: "create" });
}

describe("B3 privacy-safe runtime artifact", () => {
  it("binds exact bytes, frozen semantics, sklearn oracle and exact normalization", async () => {
    const bytes = await readFile("models/referral-risk-v1.json");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(REFERRAL_RISK_ARTIFACT_SHA256);
    const artifact = await loadReferralRiskArtifact();
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.classifier.fields[0].frequent)).toBe(true);
    expect(artifact.classifier.fields.map((field) => field.frequent.length)).toEqual([91, 896, 897, 1074, 2, 3, 10]);
    expect(artifact).toMatchObject({ classifier: { intercept: -0.5447459873871785, workingThreshold: 0.1709380688837899,
      iterations: 16, maxIterations: 300, classes: [0, 1], positiveClass: 1 }, heldoutBenchmark: { rows: 223353, positives: 24469 } });
    expect(referralRiskToken("bed_profile", " Synthetic Ё ")).toBe(artifact.oracle.hashVector.token);
    const score = scoreReferralRisk(features, artifact);
    expect(score.inputCoverage.bed_profile).toBe("missing");
    expect(Number.isFinite(score.refusalProbabilityAmongMatureOutcomes)).toBe(true);
    expect(() => scoreReferralRisk({ ...features, finance_source: "__MISSING__" }, artifact)).toThrow("INVALID_REFERRAL_RISK_INPUTS");
    expect(() => scoreReferralRisk({ ...features, hospital_mo: null }, artifact)).toThrow("INVALID_REFERRAL_RISK_INPUTS");
  });

  it("rejects recursive extras, semantic drift, non-finite values and oracle tampering", async () => {
    const source = JSON.parse(await readFile("models/referral-risk-v1.json", "utf8"));
    const mutate = (work: (copy: ReferralRiskArtifact) => void) => { const copy = structuredClone(source) as ReferralRiskArtifact; work(copy); return () => validateReferralRiskArtifact(copy); };
    expect(mutate((copy) => { Object.assign(copy, { extra: true }); })).toThrow();
    expect(mutate((copy) => { copy.classifier.workingThreshold = 0.2; })).toThrow();
    expect(mutate((copy) => { copy.classifier.fields[0].frequent[0].weight = Number.NaN; })).toThrow();
    expect(mutate((copy) => { copy.classifier.fields[0].unseenPolicy = "zero"; })).toThrow();
    expect(mutate((copy) => { copy.provenance.inputSha256 = "0".repeat(64); })).toThrow();
    expect(mutate((copy) => { copy.oracle.cases[0].expected.probability += 0.01; })).toThrow();
  });

  it("pins the private March production-TS parity proof without row payload", async () => {
    const report = JSON.parse(await readFile("reports/referral-risk-parity.json", "utf8"));
    const fixture = JSON.parse(await readFile("tests/fixtures/referral-risk-v1.json", "utf8"));
    expect(report.artifactSha256).toBe(REFERRAL_RISK_ARTIFACT_SHA256);
    expect(fixture.artifactSha256).toBe(REFERRAL_RISK_ARTIFACT_SHA256);
    expect(report.pythonTsRuntimeParity).toEqual({ reference: "sklearn_pipeline_predict_proba_vs_lib_referral_risk_ts",
      rows: 223353, maximumAbsoluteProbabilityDelta: 3.3306690738754696e-16, riskBandMismatches: 0, passed: true });
    expect(report.source).toMatchObject({ containsRowData: false, containsIdentifiers: false, containsCategoryValues: false });
  });
});

describe("immutable registration snapshot", () => {
  it("requires six core inputs, permits trained bed missing, and records one doctor-attested event", async () => {
    const { service } = setup();
    const created = await create(service);
    for (const field of REFERRAL_RISK_FEATURES.filter((name) => name !== "bed_profile")) {
      await expect(service.recordRegistrationSnapshot(doctor, created.id, { expectedRevision: 1, idempotencyKey: `bad-${field}`,
        attestedAtRegistration: true, features: { ...features, [field]: null } })).rejects.toMatchObject({ status: 400 });
    }
    await expect(service.recordRegistrationSnapshot(doctor, created.id, { expectedRevision: 1, idempotencyKey: "reserved",
      attestedAtRegistration: true, features: { ...features, finance_source: "__MISSING__" } })).rejects.toMatchObject({ status: 400 });
    const input = { expectedRevision: 1, idempotencyKey: "snapshot", attestedAtRegistration: true as const, features };
    const saved = await service.recordRegistrationSnapshot(doctor, created.id, input);
    expect(saved.registrationSnapshot).toEqual(features);
    expect(saved.events.at(-1)).toMatchObject({ type: "registration_snapshot_recorded", actorId: doctor.id, before: null, after: features, revision: 2 });
    expect(await service.recordRegistrationSnapshot(doctor, created.id, input)).toEqual(saved);
    await expect(service.recordRegistrationSnapshot(doctor, created.id, { ...input, features: { ...features, finance_source: "changed" } }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    saved.registrationSnapshot!.finance_source = "client mutation";
    expect((await service.detail(doctor, created.id)).registrationSnapshot?.finance_source).toBe(features.finance_source);
    await expect(service.recordRegistrationSnapshot(doctor, created.id, { ...input, idempotencyKey: "second", expectedRevision: 2 }))
      .rejects.toMatchObject({ code: "REGISTRATION_SNAPSHOT_IMMUTABLE" });
    await expect(service.recordRegistrationSnapshot(owner, created.id, { ...input, idempotencyKey: "owner", expectedRevision: 2 })).rejects.toMatchObject({ status: 403 });
    await expect(service.recordRegistrationSnapshot(colleague, created.id, input)).rejects.toMatchObject({ status: 404 });
    await expect(service.recordRegistrationSnapshot(foreign, created.id, input)).rejects.toMatchObject({ status: 404 });
    await expect(service.recordRegistrationSnapshot(analyst, created.id, input)).rejects.toMatchObject({ status: 403 });
  });

  it("serializes concurrent first capture without overwriting the winner", async () => {
    const { service } = setup();
    const created = await create(service);
    const outcomes = await Promise.allSettled(["a", "b"].map((idempotencyKey) => service.recordRegistrationSnapshot(doctor, created.id, {
      expectedRevision: 1, idempotencyKey, attestedAtRegistration: true, features,
    })));
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect((await service.detail(doctor, created.id)).events.filter((event) => event.type === "registration_snapshot_recorded")).toHaveLength(1);
  });

  it("migrates v4 without erasing Phase3 state and rejects single-field journal corruption", async () => {
    const { repository, service } = setup();
    const created = await create(service);
    const assessed = await service.assess(doctor, created.id, { expectedRevision: 1, expectedAssessmentRevision: 0,
      idempotencyKey: "assessment", reason: "Подтверждено для миграции", assessment: {
        hypothesis: "Исследовательская запись", profile: "Хирургический", icd10Code: null, careContext: "unknown",
      } });
    const current = await repository.read((value) => value);
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 4;
    const legacyReferrals = legacy.referrals as Record<string, unknown>[];
    delete legacyReferrals[0].registrationSnapshot;
    const migrated = validateReferralDatabase(legacy);
    expect(migrated.referrals[0].registrationSnapshot).toBeNull();
    expect(migrated.referrals[0].doctorAssessment).toEqual(assessed.doctorAssessment);
    expect(migrated.referrals[0].requirementSnapshotId).toBe(assessed.requirementSnapshotId);
    const saved = await service.recordRegistrationSnapshot(doctor, created.id, { expectedRevision: 2, idempotencyKey: "snapshot",
      attestedAtRegistration: true, features });
    const state = await repository.read((value) => value);
    const tampered = structuredClone(state);
    tampered.referrals[0].registrationSnapshot!.finance_source = "changed";
    expect(() => validateReferralDatabase(tampered)).toThrow("Invalid referral snapshot");
    expect(saved.revision).toBe(3);
  });
});

describe("scoped research risk API", () => {
  it("protects registration capture before parsing caller-controlled payloads", async () => {
    const { service } = setup();
    const created = await create(service);
    const body = { expectedRevision: 1, idempotencyKey: "capture", attestedAtRegistration: true, features };
    const deps = (actor: ReferralActor) => ({ actor: async () => actor, referrals: service });
    const unauthorized = await handleRegistrationSnapshot(post({ forged: true }), created.id, {
      ...deps(doctor), actor: async () => { throw new WorkspaceAuthError(401, "UNAUTHORIZED"); },
    });
    expect(unauthorized.status).toBe(401);
    expect((await handleRegistrationSnapshot(post({ forged: true }), created.id, deps(owner))).status).toBe(403);
    expect((await handleRegistrationSnapshot(post({ forged: true }), created.id, deps(analyst))).status).toBe(403);
    expect((await handleRegistrationSnapshot(post({ forged: true }), created.id, deps(colleague))).status).toBe(404);
    expect((await handleRegistrationSnapshot(post({ forged: true }), created.id, deps(foreign))).status).toBe(404);
    expect((await handleRegistrationSnapshot(post(body, "/api/referrals/r/registration-snapshot?extra=1"), created.id, deps(doctor))).status).toBe(400);
    expect((await handleRegistrationSnapshot(post({ ...body, extra: true }), created.id, deps(doctor))).status).toBe(400);
    expect((await handleRegistrationSnapshot(post({ ...body, features: { ...features, extra: true } }), created.id, deps(doctor))).status).toBe(400);
    expect((await service.detail(doctor, created.id)).revision).toBe(1);
    expect((await service.detail(doctor, created.id)).registrationSnapshot).toBeNull();
  });

  it("does not load the artifact before auth, role, scope, query and snapshot checks", async () => {
    const { service } = setup();
    const created = await create(service);
    const load = vi.fn(loadReferralRiskArtifact);
    const deps = (actor: ReferralActor) => ({ actor: async () => actor, referrals: service, riskArtifact: load });
    expect((await handleReferralRisk(get(), created.id, { ...deps(doctor), actor: async () => { throw new WorkspaceAuthError(401, "UNAUTHORIZED"); } })).status).toBe(401);
    expect((await handleReferralRisk(get(), created.id, deps(analyst))).status).toBe(403);
    expect((await handleReferralRisk(get(), created.id, deps(colleague))).status).toBe(404);
    expect((await handleReferralRisk(get(), created.id, deps(foreign))).status).toBe(404);
    expect((await handleReferralRisk(get("/api/referrals/r/risk?extra=1"), created.id, deps(doctor))).status).toBe(400);
    const missing = await handleReferralRisk(get(), created.id, deps(doctor));
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ risk: { status: "unavailable", reason: "REGISTRATION_SNAPSHOT_MISSING" } });
    expect(load).not.toHaveBeenCalled();
  });

  it("captures through strict API, scores for owner, and never returns model internals", async () => {
    const { service } = setup();
    const created = await create(service);
    const deps = { actor: async () => doctor, referrals: service, riskArtifact: loadReferralRiskArtifact };
    const captured = await handleRegistrationSnapshot(post({ expectedRevision: 1, idempotencyKey: "capture", attestedAtRegistration: true, features }), created.id, deps);
    expect(captured.status).toBe(200);
    const response = await handleReferralRisk(get(), created.id, { ...deps, actor: async () => owner });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const payload = await response.json();
    expect(Object.keys(payload.risk).sort()).toEqual(["status", "researchOnly", "limitationsLabel", "modelVersion", "method",
      "refusalProbabilityAmongMatureOutcomes", "workingThreshold", "riskBand", "inputRevision", "inputCoverage", "warnings", "limitations"].sort());
    expect(payload.risk).toMatchObject({ status: "available", researchOnly: true, limitationsLabel: "experimental_research_only",
      modelVersion: "referral-refusal-baseline-v0", inputRevision: 2 });
    expect(JSON.stringify(payload)).not.toMatch(/token|weight|intercept|category/i);
  });

  it("fails closed when the artifact cannot be verified", async () => {
    const { service } = setup();
    const created = await create(service);
    await service.recordRegistrationSnapshot(doctor, created.id, { expectedRevision: 1, idempotencyKey: "snapshot", attestedAtRegistration: true, features });
    const response = await handleReferralRisk(get(), created.id, { actor: async () => doctor, referrals: service,
      riskArtifact: async () => { throw new Error("private path"); } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ risk: { status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE", missingInputs: [], inputRevision: 2 } });
  });

  it("ships server artifact and exposes a manual, research-only UI", async () => {
    const [docker, page] = await Promise.all([readFile("Dockerfile", "utf8"), readFile("app/workspace/referrals/[id]/page.tsx", "utf8")]);
    expect(docker).toContain("/app/models/referral-risk-v1.json ./models/referral-risk-v1.json");
    expect(page).toContain("Введите значения из записи на момент регистрации");
    expect(page).toContain("Только исследование");
    expect(page).toContain("текущий профиль, код и организация не копируются сюда автоматически");
  });
});
