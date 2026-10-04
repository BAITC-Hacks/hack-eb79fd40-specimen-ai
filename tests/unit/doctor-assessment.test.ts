import { describe, expect, it } from "vitest";
import { patientMemoFromReferral, renderPatientMemoText } from "../../lib/patient-memo";
import conservativeData from "../../data/examination_requirements_conservative.json";
import { CLOSED_REFERRAL_PROFILES } from "../../lib/referrals/profiles";
import { validateRequirementCatalogue } from "../../lib/referrals/requirements";
import { MemoryReferralRepository, REFERRAL_DATABASE_SCHEMA_VERSION, ReferralService, validateReferralDatabase } from "../../lib/referrals/service";
import type { ReferralActor, RequirementCatalogue } from "../../lib/referrals/types";
import type { TriageResult } from "../../lib/types";
import { handleDoctorAssessment, type WorkspaceApiDeps } from "../../lib/workspace-api";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const BASE = "https://workspace.example.test";
const doctor: ReferralActor = { id: "doctor-a", displayName: "Врач А", role: "doctor", organizationId: "org-a" };
const colleague: ReferralActor = { ...doctor, id: "doctor-b", displayName: "Врач Б" };
const owner: ReferralActor = { ...doctor, id: "owner-a", role: "owner" };
const analyst: ReferralActor = { ...doctor, id: "analyst-a", role: "analyst" };
const foreign: ReferralActor = { ...doctor, id: "doctor-z", organizationId: "org-z" };

const requirements = (treatment: "operative" | "conservative"): RequirementCatalogue => ({
  schemaVersion: 1,
  version: `test-${treatment}`,
  status: "available",
  source: "synthetic-test-only",
  validated: false,
  scope: { population: "adult", careSetting: "inpatient", treatment },
  profiles: ["Хирургический", "Сосудистая хирургия"].map((profile) => ({
    profile,
    requirements: [{ id: "common", label: "Общее исследование", required: true, conditional: false, validForDays: 14,
      ...(treatment === "conservative" ? { provenance: "source_documented" as const } : {}) }],
  })),
});
const triage: TriageResult = {
  anamnesis: { chief_complaint: "Тестовая жалоба", symptom: { onset: "", location: "", quality: "", severity: null, modifiers: "", associated: [] }, past_history: [], chronic: [], allergies: [], medications: [], context: { age: null, sex: "unknown", pregnancy: "na", risk_factors: [] } },
  red_flags: [], urgency: "planned", urgency_reasons: [], routing: [],
  hypothesis: { text: "Исходная предварительная гипотеза", confidence: 0, disclaimer: "Это не диагноз, решает врач" }, source: "rules_only",
};

function setup() {
  const repository = new MemoryReferralRepository();
  let serial = 0;
  const service = new ReferralService(repository, { now: () => NOW, id: () => `id-${++serial}`,
    catalogue: requirements("operative"), conservativeCatalogue: requirements("conservative") });
  return { repository, service };
}
async function create(service: ReferralService) {
  await service.bindLink("doctor-link", doctor);
  return service.create(doctor, { patientLabel: "Эпизод", profile: "Хирургический", sourceSessionId: "session-1", idempotencyKey: "create" },
    { sessionId: "session-1", doctorToken: "doctor-link", result: triage });
}
const assessment = (patch: Partial<{ hypothesis: string | null; profile: string; icd10Code: string | null; careContext: "operative" | "conservative" | "unknown" }> = {}) => ({
  hypothesis: "Заключение врача",
  profile: "Хирургический",
  icd10Code: "I65.2",
  careContext: "operative" as const,
  ...patch,
});

describe("doctor assessment and care-context package", () => {
  it("locks the real conservative draft source, scope and unverified additions", () => {
    const catalogue = validateRequirementCatalogue(conservativeData);
    expect(catalogue).toMatchObject({ schemaVersion: 1, version: "2025-02-17-order-9-appendix-5-conservative-draft-v1",
      status: "available", validated: false, scope: { population: "adult", careSetting: "inpatient", treatment: "conservative" } });
    expect(catalogue.source).toContain("https://old.adilet.zan.kz/rus/docs/V2200027218");
    expect(catalogue.profiles.map((entry) => entry.profile)).toEqual(CLOSED_REFERRAL_PROFILES);
    expect(catalogue.profiles.some((entry) => /нейрохир/u.test(entry.profile))).toBe(false);
    for (const profile of catalogue.profiles) {
      const byId = new Map(profile.requirements.map((entry) => [entry.id, entry]));
      expect(byId.has("therapist")).toBe(false);
      expect(byId.get("biochem_extra")).toMatchObject({ required: false, conditional: true, provenance: "source_documented" });
      expect(byId.get("coagulogram")).toMatchObject({ required: false, conditional: true, provenance: "source_documented" });
      expect(byId.get("ecg")).toMatchObject({ required: false, conditional: true, validForDays: 14, provenance: "source_documented" });
      expect(byId.get("ecg_oncology")).toMatchObject({ required: false, conditional: true, validForDays: 30, provenance: "source_documented" });
      expect(profile.requirements.filter((entry) => entry.provenance === "profile_addition_unverified")
        .every((entry) => entry.required === null && entry.conditional)).toBe(true);
    }
  });
  it("starts unknown, preserves triage, and writes a server-owned audited assessment", async () => {
    const { service } = setup();
    const created = await create(service);
    expect(created).toMatchObject({ doctorAssessment: null, completeness: { catalogueAvailable: false, entries: [] } });
    const originalTriage = structuredClone(created.triageSnapshot);
    const saved = await service.assess(doctor, created.id, { expectedRevision: 1, expectedAssessmentRevision: 0,
      idempotencyKey: "assessment-1", reason: "Проверено врачом", assessment: assessment({ profile: "Сосудистая хирургия" }) });
    expect(saved.triageSnapshot).toEqual(originalTriage);
    expect(saved).toMatchObject({ profile: "Сосудистая хирургия", icd10Code: "I65.2",
      doctorAssessment: { authorId: doctor.id, authorName: doctor.displayName, recordedAt: NOW, revision: 1, careContext: "operative" },
      requirementSnapshot: { scope: { treatment: "operative" }, profiles: [{ profile: "Сосудистая хирургия" }] } });
    expect(saved.events.at(-1)).toMatchObject({ type: "doctor_assessment_changed", actorId: doctor.id, occurredAt: null,
      reason: "Проверено врачом", before: { assessment: null }, after: { assessment: { revision: 1 } } });
  });

  it("keeps snapshot identity and current evidence for hypothesis-only changes", async () => {
    const { service } = setup();
    let referral = await create(service);
    referral = await service.assess(doctor, referral.id, { expectedRevision: referral.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "operative", reason: "Определён контекст", assessment: assessment() });
    const snapshotId = referral.requirementSnapshotId;
    referral = await service.examination(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "exam", record: {
      requirementId: "common", label: "Общее исследование", resultAvailable: true, performedOn: "2026-10-01", expiresOn: "2026-10-15", applicability: "yes",
    } });
    referral = await service.assess(doctor, referral.id, { expectedRevision: referral.revision, expectedAssessmentRevision: 1,
      idempotencyKey: "wording", reason: "Уточнена формулировка", assessment: assessment({ hypothesis: "Уточнённое заключение" }) });
    expect(referral.requirementSnapshotId).toBe(snapshotId);
    expect(referral.doctorAssessment?.revision).toBe(2);
    expect(referral.examinations.find((item) => item.requirementSnapshotId === snapshotId)).toBeTruthy();
  });

  it("keeps current pending patient reports in assessment, operational and examination responses", async () => {
    const repository = new MemoryReferralRepository();
    let serial = 0;
    const operative = requirements("operative");
    for (const profile of operative.profiles) {
      profile.requirements.push({ id: "second", label: "Второе исследование", required: true, conditional: false, validForDays: 14 });
    }
    const service = new ReferralService(repository, { now: () => NOW, id: () => `reports-${++serial}`,
      catalogue: operative, conservativeCatalogue: requirements("conservative") });
    let referral = await create(service);
    referral = await service.assess(doctor, referral.id, { expectedRevision: referral.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "reports-operative", reason: "Определён контекст", assessment: assessment() });
    const access = await service.issuePreparation("session-1", doctor, "doctor-link");
    await service.reportPreparation(access.token, access.accessId, { requirementId: "common", performedOn: "2026-10-01",
      resultAvailable: true, expectedRevision: 0, idempotencyKey: "report-common" });
    await service.reportPreparation(access.token, access.accessId, { requirementId: "second", performedOn: "2026-10-02",
      resultAvailable: true, expectedRevision: 0, idempotencyKey: "report-second" });

    const wordingInput = { expectedRevision: referral.revision, expectedAssessmentRevision: 1,
      idempotencyKey: "reports-wording", reason: "Уточнена формулировка", assessment: assessment({ hypothesis: "Уточнено" }) };
    referral = await service.assess(doctor, referral.id, wordingInput);
    expect(referral.patientReports).toHaveLength(2);
    expect((await service.assess(doctor, referral.id, wordingInput)).patientReports).toHaveLength(2);

    const operationalInput = { expectedRevision: referral.revision, idempotencyKey: "reports-operational",
      patch: { destinationOrganization: "Клиника" } };
    referral = await service.update(doctor, referral.id, operationalInput);
    expect(referral.patientReports).toHaveLength(2);
    expect((await service.update(doctor, referral.id, operationalInput)).patientReports).toHaveLength(2);

    const examinationInput = { expectedRevision: referral.revision, idempotencyKey: "reports-examination", record: {
      requirementId: "common", label: "Общее исследование", resultAvailable: true,
      performedOn: "2026-10-01", expiresOn: "2026-10-15", applicability: "yes" as const,
    } };
    referral = await service.examination(doctor, referral.id, examinationInput);
    expect(referral.patientReports).toHaveLength(2);
    expect((await service.examination(doctor, referral.id, examinationInput)).patientReports).toHaveLength(2);
  });

  it("does not resurrect reports or examinations across operative → conservative → operative", async () => {
    const { service } = setup();
    let referral = await create(service);
    referral = await service.assess(doctor, referral.id, { expectedRevision: referral.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "operative", reason: "Определён контекст", assessment: assessment() });
    const operativeId = referral.requirementSnapshotId;
    const access = await service.issuePreparation("session-1", doctor, "doctor-link");
    let patient = await service.reportPreparation(access.token, access.accessId, { requirementId: "common", performedOn: "2026-10-01",
      resultAvailable: true, expectedRevision: 0, idempotencyKey: "patient-mark" });
    const report = (await service.detail(doctor, referral.id)).patientReports![0];
    referral = await service.confirmPatientReport(doctor, referral.id, { reportId: report.id, expectedRevision: referral.revision,
      expectedReportRevision: report.revision, idempotencyKey: "confirm" });
    expect(patient.items[0].selfReport).not.toBeNull();
    expect(referral.examinations[0].requirementSnapshotId).toBe(operativeId);

    referral = await service.assess(doctor, referral.id, { expectedRevision: referral.revision, expectedAssessmentRevision: 1,
      idempotencyKey: "conservative", reason: "Изменён план лечения", assessment: assessment({ careContext: "conservative" }) });
    const conservativeId = referral.requirementSnapshotId;
    expect(conservativeId).not.toBe(operativeId);
    patient = await service.preparation(access.token, access.accessId);
    expect(patient.items[0]).toMatchObject({ selfReport: null, confirmedStatus: "unknown" });
    expect(referral.completeness.entries[0].status).toBe("unknown");

    referral = await service.assess(doctor, referral.id, { expectedRevision: referral.revision, expectedAssessmentRevision: 2,
      idempotencyKey: "operative-again", reason: "План снова изменён", assessment: assessment() });
    expect(referral.requirementSnapshotId).not.toBe(operativeId);
    expect(referral.requirementSnapshotId).not.toBe(conservativeId);
    patient = await service.preparation(access.token, access.accessId);
    expect(patient.items[0]).toMatchObject({ selfReport: null, confirmedStatus: "unknown" });
    expect(referral.examinations).toHaveLength(1);
  });

  it("keeps unknown care empty in detail, memo and patient text while preserving historic records", async () => {
    const { service } = setup();
    let referral = await create(service);
    referral = await service.examination(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "historic", record: {
      requirementId: "common", label: "Историческое исследование", resultAvailable: true, performedOn: "2026-10-01", expiresOn: "2026-10-15", applicability: "yes",
    } });
    expect(referral.examinations).toHaveLength(1);
    expect(referral.completeness.entries).toEqual([]);
    const memo = patientMemoFromReferral(referral);
    expect(memo).toMatchObject({ careContext: "unknown", catalogueAvailable: false, items: [] });
    expect(renderPatientMemoText(memo)).not.toContain("Историческое исследование");
  });

  it("keeps I67.1 on the physician-selected profile and never invents a neurosurgical profile", async () => {
    const { service } = setup();
    const created = await create(service);
    const saved = await service.assess(doctor, created.id, { expectedRevision: 1, expectedAssessmentRevision: 0,
      idempotencyKey: "i671", reason: "Профиль выбран врачом", assessment: assessment({ icd10Code: "I67.1", profile: "Хирургический" }) });
    expect(saved.profile).toBe("Хирургический");
    expect(saved.requirementSnapshot?.profiles.map((item) => item.profile)).toEqual(["Хирургический"]);
    expect(JSON.stringify(saved)).not.toContain("Нейрохирург");
  });

  it("enforces physician scope, both revisions, reason and canonical idempotency", async () => {
    const { service } = setup();
    const created = await create(service);
    const input = { expectedRevision: 1, expectedAssessmentRevision: 0, idempotencyKey: "assessment",
      reason: "Проверено врачом", assessment: assessment() };
    await expect(service.assess(owner, created.id, input)).rejects.toMatchObject({ status: 403 });
    await expect(service.assess(colleague, created.id, input)).rejects.toMatchObject({ status: 404 });
    await expect(service.assess(foreign, created.id, input)).rejects.toMatchObject({ status: 404 });
    await expect(service.assess(analyst, created.id, input)).rejects.toMatchObject({ status: 403 });
    await expect(service.assess(doctor, created.id, { ...input, reason: "" })).rejects.toMatchObject({ status: 400 });
    const saved = await service.assess(doctor, created.id, input);
    expect(await service.assess(doctor, created.id, input)).toEqual(saved);
    await expect(service.assess(doctor, created.id, { ...input, assessment: assessment({ hypothesis: "Другое" }) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(service.assess(doctor, created.id, { ...input, idempotencyKey: "stale-global" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(service.assess(doctor, created.id, { ...input, expectedRevision: saved.revision, idempotencyKey: "stale-assessment",
      assessment: assessment({ hypothesis: "Другое" }) })).rejects.toMatchObject({ code: "ASSESSMENT_REVISION_CONFLICT" });
  });

  it("routes legacy profile/code patches through the same audit without owner or reason bypass", async () => {
    const { service } = setup();
    const created = await create(service);
    await expect(service.update(owner, created.id, { expectedRevision: 1, idempotencyKey: "owner", patch: { icd10Code: "I65.2" }, reason: "Попытка" })).rejects.toMatchObject({ status: 403 });
    await expect(service.update(doctor, created.id, { expectedRevision: 1, idempotencyKey: "missing-reason", patch: { icd10Code: "I65.2" } })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    const updated = await service.update(doctor, created.id, { expectedRevision: 1, idempotencyKey: "legacy", patch: { profile: "Сосудистая хирургия", icd10Code: "I65.2" }, reason: "Совместимый клиент" });
    expect(updated.events.at(-1)).toMatchObject({ type: "doctor_assessment_changed", reason: "Совместимый клиент" });
    expect(updated.doctorAssessment).toMatchObject({ profile: "Сосудистая хирургия", icd10Code: "I65.2", authorId: doctor.id, revision: 1 });
  });

  it("rejects forged assessment audit metadata and invented active profiles", async () => {
    const { repository, service } = setup();
    const created = await create(service);
    await service.assess(doctor, created.id, { expectedRevision: 1, expectedAssessmentRevision: 0,
      idempotencyKey: "assessment", reason: "Проверено", assessment: assessment() });
    const state = await repository.read((entry) => entry);
    const tamper = (change: (copy: typeof state) => void) => {
      const copy = structuredClone(state); change(copy); return () => validateReferralDatabase(copy);
    };
    expect(tamper((copy) => { copy.referrals[0].doctorAssessment!.authorId = "forged"; })).toThrow("Invalid referral snapshot");
    expect(tamper((copy) => { copy.referrals[0].doctorAssessment!.recordedAt += 1; })).toThrow("Invalid referral snapshot");
    expect(tamper((copy) => { copy.referrals[0].events[1].after = { ...(copy.referrals[0].events[1].after as object), assessment: { ...copy.referrals[0].doctorAssessment!, revision: 9 } } as never; })).toThrow("Invalid referral snapshot");
    expect(tamper((copy) => { copy.referrals[0].doctorAssessment!.profile = "Выдуманный профиль"; copy.referrals[0].profile = "Выдуманный профиль"; copy.referrals[0].requirementSnapshot!.profiles[0].profile = "Выдуманный профиль"; })).toThrow("Invalid referral snapshot");
  });

  it("migrates v3 as unknown and keeps the old operative draft inactive", async () => {
    const { repository, service } = setup();
    await create(service);
    const current = await repository.read((entry) => entry);
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 3;
    const record = (legacy.referrals as Record<string, unknown>[])[0];
    delete record.doctorAssessment; delete record.requirementSnapshotId;
    record.requirementSnapshot = { ...requirements("operative"), profiles: requirements("operative").profiles.filter((entry) => entry.profile === "Хирургический") };
    const migrated = validateReferralDatabase(legacy);
    expect(migrated.schemaVersion).toBe(REFERRAL_DATABASE_SCHEMA_VERSION);
    expect(migrated.referrals[0]).toMatchObject({ doctorAssessment: null, requirementSnapshot: { scope: { treatment: "operative" } } });
    await repository.transaction((draft) => Object.assign(draft, migrated));
    const detail = await service.detail(doctor, migrated.referrals[0].id);
    expect(detail.completeness).toMatchObject({ catalogueAvailable: false, entries: [] });
    expect(patientMemoFromReferral(detail).items).toEqual([]);
  });

  it("keeps v3 patient evidence historical when migrating an active operative package", async () => {
    const { repository, service } = setup();
    let referral = await create(service);
    referral = await service.assess(doctor, referral.id, { expectedRevision: referral.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "operative-v3", reason: "Определён контекст", assessment: assessment({ icd10Code: null }) });
    const access = await service.issuePreparation("session-1", doctor, "doctor-link");
    await service.reportPreparation(access.token, access.accessId, { requirementId: "common", performedOn: "2026-10-01",
      resultAvailable: true, expectedRevision: 0, idempotencyKey: "patient-v3" });
    const report = (await service.detail(doctor, referral.id)).patientReports![0];
    await service.confirmPatientReport(doctor, referral.id, { reportId: report.id, expectedRevision: referral.revision,
      expectedReportRevision: report.revision, idempotencyKey: "confirm-v3" });

    const current = await repository.read((entry) => entry);
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 3;
    const record = (legacy.referrals as Record<string, unknown>[])[0];
    delete record.doctorAssessment; delete record.requirementSnapshotId;
    const events = (record.events as Record<string, unknown>[]).filter((event) => event.type !== "doctor_assessment_changed");
    events.forEach((event, index) => { event.revision = index + 1; });
    record.events = events;
    record.revision = events.length;
    for (const examination of record.examinations as Record<string, unknown>[]) delete examination.requirementSnapshotId;
    for (const event of events) {
      if (event.type !== "examination_recorded") continue;
      if (event.before && typeof event.before === "object") delete (event.before as Record<string, unknown>).requirementSnapshotId;
      if (event.after && typeof event.after === "object") delete (event.after as Record<string, unknown>).requirementSnapshotId;
    }
    for (const patientReport of legacy.patientReports as Record<string, unknown>[]) delete patientReport.requirementSnapshotId;

    const migrated = validateReferralDatabase(legacy);
    const migratedRecord = migrated.referrals[0];
    const migratedReport = migrated.patientReports![0];
    expect(migratedRecord.doctorAssessment).toBeNull();
    expect(migratedRecord.examinations[0]).toMatchObject({ patientReportId: migratedReport.id,
      requirementSnapshotId: migratedReport.requirementSnapshotId });
    expect(migratedRecord.requirementSnapshotId).not.toBe(migratedReport.requirementSnapshotId);
    await repository.transaction((draft) => Object.assign(draft, migrated));
    const detail = await service.detail(doctor, migratedRecord.id);
    expect(detail.completeness).toMatchObject({ catalogueAvailable: false, entries: [] });
    expect(detail.patientReports).toEqual([]);
    expect(patientMemoFromReferral(detail).items).toEqual([]);
  });
});

describe("doctor assessment HTTP boundary", () => {
  it("orders auth/scope checks before strict query and body validation", async () => {
    const { service } = setup();
    const created = await create(service);
    const deps = (actor: ReferralActor): WorkspaceApiDeps => ({ actor: async () => actor, referrals: service });
    const request = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) });
    const valid = { expectedRevision: 1, expectedAssessmentRevision: 0, idempotencyKey: "http", reason: "Проверено", assessment: assessment() };
    expect((await handleDoctorAssessment(request(`/api/referrals/${created.id}/doctor-assessment?x=1`, valid), created.id, deps(doctor))).status).toBe(400);
    expect((await handleDoctorAssessment(request(`/api/referrals/${created.id}/doctor-assessment`, { unexpected: true }), created.id, deps(owner))).status).toBe(403);
    expect((await handleDoctorAssessment(request(`/api/referrals/${created.id}/doctor-assessment`, { unexpected: true }), created.id, deps(colleague))).status).toBe(404);
    expect((await handleDoctorAssessment(request(`/api/referrals/${created.id}/doctor-assessment`, { ...valid, assessment: { ...valid.assessment, extra: true } }), created.id, deps(doctor))).status).toBe(400);
    expect((await handleDoctorAssessment(request(`/api/referrals/${created.id}/doctor-assessment`, valid), created.id, deps(doctor))).status).toBe(200);
  });
});
