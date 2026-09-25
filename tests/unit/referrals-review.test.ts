import { describe, expect, it } from "vitest";
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
  it("reaches ready after a complete package instead of being shadowed by scheduled", async () => {
    const service = new ReferralService(new MemoryReferralRepository(), {
      now: () => Date.parse("2026-09-13T12:00:00Z"),
      catalogue: catalogue([requirement("core", true, false)]),
    });
    const created = await service.create(doctor, { patientLabel: "Эпизод", profile: "Хирургический", idempotencyKey: "create" });
    const scheduled = await service.update(doctor, created.id, {
      expectedRevision: 1,
      idempotencyKey: "schedule",
      patch: { scheduledDate: "2026-09-20" },
    });
    expect(scheduled.flow).toBe("scheduled");
    const { id: _id, ...coreResult } = examination("core");
    void _id;
    const ready = await service.examination(doctor, created.id, {
      expectedRevision: 2,
      idempotencyKey: "core-result",
      record: coreResult,
    });
    expect(ready.completeness.status).toBe("complete");
    expect(ready.flow).toBe("ready");
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
    expect(withheld.suppressed).toBe(true);
    expect(withheld.total).toBeNull();
    expect(withheld.groups).toEqual(released.groups);
    expect(withheld.groups.some((group) => group.count === 6)).toBe(false);

    const current = await service.aggregates(owner);
    expect(current.total).toBe(6);
    expect(current.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ flow: "preparing", count: 5 }),
      expect.objectContaining({ flow: "waiting", count: 1 }),
    ]));
  });
});
