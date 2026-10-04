import { describe, expect, it } from "vitest";
import { patientMemoFromReferral } from "../../lib/patient-memo";
import { evaluateCompleteness } from "../../lib/referrals/requirements";
import { MemoryReferralRepository, ReferralService } from "../../lib/referrals/service";
import type { ExaminationRecord, ReferralActor, RequirementCatalogue } from "../../lib/referrals/types";

const DAY = 86_400_000;
const doctor: ReferralActor = { id: "doctor", displayName: "Врач", role: "doctor", organizationId: "org" };
const owner: ReferralActor = { ...doctor, id: "owner", role: "owner" };
const analyst: ReferralActor = { ...doctor, id: "analyst", role: "analyst" };

const requirement = (id: string, required: boolean, conditional: boolean) => ({
  id,
  label: id,
  required,
  conditional,
  validForDays: null,
});
const catalogue = (requirements: ReturnType<typeof requirement>[]): RequirementCatalogue => ({
  schemaVersion: 1,
  version: "review-test",
  status: "available",
  source: "synthetic-review-fixture",
  validated: true,
  scope: { population: "adult", careSetting: "inpatient", treatment: "operative" },
  profiles: [{ profile: "Хирургический", requirements }],
});
const examination = (requirementId: string, patch: Partial<ExaminationRecord> = {}): ExaminationRecord => ({
  id: `exam-${requirementId}`,
  requirementId,
  label: requirementId,
  resultAvailable: true,
  performedOn: "2026-09-10",
  expiresOn: "2026-09-30",
  applicability: "yes",
  ...patch,
});

describe("review 25.09: referral readiness and privacy", () => {
  it("keeps completeness separate from the seven-phase journey and never invents ready", async () => {
    const service = new ReferralService(new MemoryReferralRepository(), {
      now: () => Date.parse("2026-09-13T12:00:00Z"),
      catalogue: catalogue([requirement("core", true, false)]),
    });
    let created = await service.create(doctor, { patientLabel: "Эпизод", profile: "Хирургический", idempotencyKey: "create" });
    created = await service.assess(doctor, created.id, { expectedRevision: created.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "assessment", reason: "Тестовый operative контекст",
      assessment: { hypothesis: null, profile: created.profile, icd10Code: created.icd10Code ?? null, careContext: "operative" } });
    const scheduled = await service.update(doctor, created.id, {
      expectedRevision: created.revision,
      idempotencyKey: "schedule",
      patch: { scheduledDate: "2026-09-20" },
    });
    expect(scheduled.flow).toBe("scheduled");
    const { id: _id, ...coreResult } = examination("core");
    void _id;
    const complete = await service.examination(doctor, created.id, {
      expectedRevision: scheduled.revision,
      idempotencyKey: "core-result",
      record: coreResult,
    });
    expect(complete.completeness.status).toBe("complete");
    expect(complete.sent).toBeNull();
    expect(complete.flow).toBe("scheduled");
    expect(complete.events.flatMap((event) => event.transition ? [event.transition.to] : [])).toEqual(["preparing", "scheduled"]);
  });

  it("does not block on a truly optional item but blocks an applicable conditional item", () => {
    const coreReferral = { profile: "Хирургический", scheduledDate: "2026-09-20", examinations: [examination("core")] };
    const optional = evaluateCompleteness({ ...coreReferral, examinations: [
      examination("core"),
      examination("optional", { expiresOn: "2026-09-19" }),
    ] }, catalogue([
      requirement("core", true, false),
      requirement("optional", false, false),
    ]), Date.parse("2026-09-13T12:00:00Z"));
    expect(optional.status).toBe("complete");

    const conditionalCatalogue = catalogue([
      requirement("core", true, false),
      requirement("conditional", false, true),
    ]);
    expect(evaluateCompleteness(coreReferral, conditionalCatalogue).status).toBe("unknown");
    const applicable = evaluateCompleteness({ ...coreReferral, examinations: [
      examination("core"),
      examination("conditional", { resultAvailable: false }),
    ] }, conditionalCatalogue);
    expect(applicable.status).toBe("incomplete");
    expect(applicable.entries.find((entry) => entry.requirementId === "conditional")?.status).toBe("missing");

    const applicableAndPresent = evaluateCompleteness({ ...coreReferral, examinations: [
      examination("core"),
      examination("conditional"),
    ] }, conditionalCatalogue);
    expect(applicableAndPresent.status).toBe("complete");
    expect(applicableAndPresent.entries.find((entry) => entry.requirementId === "conditional")?.status).toBe("present");

    const notApplicable = evaluateCompleteness({ ...coreReferral, examinations: [
      examination("core"),
      examination("conditional", { applicability: "no", resultAvailable: false, performedOn: null, expiresOn: null }),
    ] }, conditionalCatalogue);
    expect(notApplicable.status).toBe("complete");
    expect(notApplicable.entries.find((entry) => entry.requirementId === "conditional")?.status).toBe("not_applicable");
  });

  it("distinguishes full, missing, expired and unvalidated package states", () => {
    const checked = catalogue([requirement("core", true, false)]);
    const base = { profile: "Хирургический", scheduledDate: "2026-09-20" };

    expect(evaluateCompleteness({ ...base, examinations: [examination("core")] }, checked).status).toBe("complete");
    expect(evaluateCompleteness({ ...base, examinations: [] }, checked).status).toBe("incomplete");
    expect(evaluateCompleteness({ ...base, examinations: [examination("core", { expiresOn: "2026-09-19" })] }, checked).status).toBe("expired");

    const unvalidated = evaluateCompleteness(
      { ...base, examinations: [examination("core")] },
      { ...checked, validated: false },
    );
    expect(unvalidated).toMatchObject({ status: "unknown", catalogueAvailable: false, catalogueValidated: false });
    expect(unvalidated.entries).toEqual([expect.objectContaining({ requirementId: "core", status: "unknown" })]);
  });

  it("keeps former-profile examinations only in audit data after a profile correction", async () => {
    const multiProfile: RequirementCatalogue = {
      ...catalogue([requirement("old-profile", true, false)]),
      profiles: [
        { profile: "Хирургический", requirements: [requirement("old-profile", true, false)] },
        { profile: "Урологический", requirements: [requirement("current-profile", true, false)] },
      ],
    };
    const service = new ReferralService(new MemoryReferralRepository(), {
      now: () => Date.parse("2026-09-20T12:00:00Z"),
      catalogue: multiProfile,
    });
    let referral = await service.create(doctor, {
      patientLabel: "Смена профиля",
      profile: "Хирургический",
      idempotencyKey: "profile-create",
    });
    referral = await service.assess(doctor, referral.id, { expectedRevision: referral.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "profile-assessment", reason: "Тестовый operative контекст",
      assessment: { hypothesis: null, profile: referral.profile, icd10Code: referral.icd10Code ?? null, careContext: "operative" } });
    referral = await service.update(doctor, referral.id, {
      expectedRevision: referral.revision,
      idempotencyKey: "profile-date",
      patch: { scheduledDate: "2026-09-20" },
    });
    const { id: _oldId, ...oldRecord } = examination("old-profile", { expiresOn: "2026-09-19" });
    void _oldId;
    referral = await service.examination(doctor, referral.id, {
      expectedRevision: referral.revision,
      idempotencyKey: "old-profile-exam",
      record: oldRecord,
    });
    referral = await service.update(doctor, referral.id, {
      expectedRevision: referral.revision,
      idempotencyKey: "profile-correction",
      patch: { profile: "Урологический" },
      reason: "Исправлен профиль госпитализации",
    });
    const { id: _currentId, ...currentRecord } = examination("current-profile");
    void _currentId;
    referral = await service.examination(doctor, referral.id, {
      expectedRevision: referral.revision,
      idempotencyKey: "current-profile-exam",
      record: currentRecord,
    });

    expect(referral.examinations.map((entry) => entry.requirementId).sort()).toEqual(["current-profile", "old-profile"]);
    expect(referral.completeness).toMatchObject({ status: "complete", catalogueVersion: "review-test" });
    expect(referral.completeness.entries.map((entry) => entry.requirementId)).toEqual(["current-profile"]);
    expect(patientMemoFromReferral(referral).items).toEqual([
      expect.objectContaining({ label: "current-profile", status: "present" }),
    ]);
    expect((await service.memo(doctor, referral.id)).items).toEqual([
      expect.objectContaining({ label: "current-profile", status: "present" }),
    ]);

    const uncheckedService = new ReferralService(new MemoryReferralRepository(), {
      now: () => Date.parse("2026-09-20T12:00:00Z"),
      catalogue: { ...multiProfile, validated: false },
    });
    let unchecked = await uncheckedService.create(doctor, {
      patientLabel: "Смена профиля без валидации",
      profile: "Хирургический",
      idempotencyKey: "unchecked-profile-create",
    });
    unchecked = await uncheckedService.assess(doctor, unchecked.id, { expectedRevision: unchecked.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "unchecked-assessment", reason: "Тестовый operative контекст",
      assessment: { hypothesis: null, profile: unchecked.profile, icd10Code: unchecked.icd10Code ?? null, careContext: "operative" } });
    const { id: _uncheckedOldId, ...uncheckedOldRecord } = examination("old-profile");
    void _uncheckedOldId;
    unchecked = await uncheckedService.examination(doctor, unchecked.id, {
      expectedRevision: unchecked.revision,
      idempotencyKey: "unchecked-old-profile-exam",
      record: uncheckedOldRecord,
    });
    unchecked = await uncheckedService.update(doctor, unchecked.id, {
      expectedRevision: unchecked.revision,
      idempotencyKey: "unchecked-profile-correction",
      patch: { profile: "Урологический" },
      reason: "Исправлен профиль госпитализации",
    });
    expect(unchecked.completeness).toMatchObject({ status: "unknown", catalogueValidated: false });
    expect(unchecked.completeness.entries.map((entry) => entry.requirementId)).toEqual(["current-profile"]);
    expect((await uncheckedService.memo(doctor, unchecked.id)).items).toEqual([
      expect.objectContaining({ label: "current-profile", status: "unknown" }),
    ]);
  });

  it("keeps analyst aggregates on a stable release until five distinct referrals change", async () => {
    let clock = Date.parse("2026-08-01T12:00:00Z");
    let serial = 0;
    const service = new ReferralService(new MemoryReferralRepository(), { now: () => clock, id: () => `id-${++serial}` });
    const created = [];
    for (let index = 0; index < 5; index++) {
      created.push(await service.create(doctor, { patientLabel: `Эпизод ${index}`, profile: "Хирургический", idempotencyKey: `create-${index}` }));
      clock += DAY;
    }
    const released = await service.aggregates(analyst);
    expect(released).toMatchObject({ suppressed: false, total: 5, groups: [{ flow: "preparing", count: 5 }] });

    await service.create(doctor, { patientLabel: "Шестой эпизод", profile: "Хирургический", idempotencyKey: "create-5" });
    clock += DAY;
    await service.update(doctor, created[0].id, {
      expectedRevision: 1,
      idempotencyKey: "one-record-change",
      patch: { queue: true },
    });
    const withheld = await service.aggregates(analyst);
    expect(withheld).toEqual(released);
    expect(withheld.groups.some((group) => group.count === 6)).toBe(false);

    const current = await service.aggregates(owner);
    expect(current.total).toBe(6);
    expect(current.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ flow: "preparing", count: 5 }),
      expect.objectContaining({ flow: "waiting", count: 1 }),
    ]));
  });
});
