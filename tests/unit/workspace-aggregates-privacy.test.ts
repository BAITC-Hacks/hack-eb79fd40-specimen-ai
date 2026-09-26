import { describe, expect, it } from "vitest";
import { handleWorkspaceAggregateDashboard } from "../../app/api/workspace/aggregates/handler";
import { MemoryReferralRepository, ReferralService } from "../../lib/referrals/service";
import type { WorkspaceActor } from "../../lib/workspace-auth";
import { handleReferrals, type WorkspaceApiDeps } from "../../lib/workspace-api";

const BASE = "https://workspace.example.test";
const doctorA: WorkspaceActor = { id: "doctor-a", displayName: "Врач А", role: "doctor", organizationId: "clinic-a" };
const doctorB: WorkspaceActor = { ...doctorA, id: "doctor-b", displayName: "Врач Б" };
const owner: WorkspaceActor = { ...doctorA, id: "owner-a", displayName: "Владелец", role: "owner" };
const analyst: WorkspaceActor = { ...doctorA, id: "analyst-a", displayName: "Аналитик", role: "analyst" };
const outsider: WorkspaceActor = { ...doctorA, id: "doctor-c", displayName: "Врач В", organizationId: "clinic-b" };

function request(path = "/api/workspace/aggregates"): Request {
  return new Request(`${BASE}${path}`);
}

describe("workspace aggregate boundary", () => {
  it("separates organization, own-patient and aggregate-only scopes at the API response", async () => {
    let clock = Date.parse("2026-09-01T12:00:00Z");
    let serial = 0;
    const referrals = new ReferralService(new MemoryReferralRepository(), {
      now: () => clock,
      id: () => `private-id-${++serial}`,
    });
    const doctorARecords: { id: string; revision: number }[] = [];
    for (const actor of [doctorA, doctorB]) {
      for (let index = 0; index < 5; index++) {
        const created = await referrals.create(actor, {
          patientLabel: `Секретный пациент ${actor.id} ${index}`,
          profile: "Хирургический",
          idempotencyKey: `create-${actor.id}-${index}`,
        });
        if (actor.id === doctorA.id) doctorARecords.push(created);
        clock += 86_400_000;
      }
    }
    await referrals.create(outsider, {
      patientLabel: "Пациент другой организации",
      profile: "Хирургический",
      idempotencyKey: "create-outsider",
    });

    const deps = (actor: WorkspaceActor): WorkspaceApiDeps => ({ actor: async () => actor, referrals });
    const ownerList = await handleReferrals(request("/api/referrals"), deps(owner));
    const doctorList = await handleReferrals(request("/api/referrals"), deps(doctorA));
    const analystList = await handleReferrals(request("/api/referrals"), deps(analyst));
    expect((await ownerList.json()).referrals).toHaveLength(10);
    expect((await doctorList.json()).referrals).toHaveLength(5);
    expect(analystList.status).toBe(403);

    const ownerResponse = await handleWorkspaceAggregateDashboard(request(), deps(owner));
    const doctorResponse = await handleWorkspaceAggregateDashboard(request(), deps(doctorA));
    const analystResponse = await handleWorkspaceAggregateDashboard(request(), deps(analyst));
    const ownerPayload = await ownerResponse.json();
    const doctorPayload = await doctorResponse.json();
    const analystPayload = await analystResponse.json();

    expect(ownerPayload.access).toEqual({ personalRecords: "organization", aggregateRecords: "organization", aggregatePrivacy: "direct" });
    expect(ownerPayload.aggregates).toMatchObject({ total: 10, scope: "organization", perProfile: [{ profile: "Хирургический", count: 10 }] });
    expect(ownerPayload.aggregates.timeline).toHaveLength(30);
    expect(doctorPayload.access).toEqual({ personalRecords: "own", aggregateRecords: "own", aggregatePrivacy: "direct" });
    expect(doctorPayload.aggregates).toMatchObject({ total: 5, scope: "own", perProfile: [{ profile: "Хирургический", count: 5 }] });
    expect(doctorPayload.aggregates.timeline).toHaveLength(30);

    expect(analystPayload.access).toEqual({ personalRecords: "none", aggregateRecords: "organization", aggregatePrivacy: "thresholded" });
    expect(analystPayload.aggregates).toMatchObject({ suppressed: false, total: 10, scope: "organization" });
    expect(analystPayload.aggregates.perProfile).toEqual([{
      profile: "Хирургический",
      count: 10,
      waitingCount: 0,
      meanObservedWaitingDays: null,
      observedWaitingTimeCount: 0,
    }]);
    expect(analystPayload.aggregates.timeline).toEqual([]);
    const aggregateJson = JSON.stringify(analystPayload);
    for (const privateText of ["patientLabel", "doctorId", "private-id-", "Секретный пациент", "Пациент другой организации"]) {
      expect(aggregateJson).not.toContain(privateText);
    }

    const releasedGroups = analystPayload.aggregates.groups;
    await referrals.create(doctorA, {
      patientLabel: "Новая закрытая запись",
      profile: "Хирургический",
      idempotencyKey: "create-unpublished",
    });
    const withheld = await handleWorkspaceAggregateDashboard(request(), deps(analyst));
    const withheldPayload = await withheld.json();
    expect(withheldPayload.aggregates).toMatchObject({ suppressed: true, total: null, groups: releasedGroups });
    expect(await (await handleWorkspaceAggregateDashboard(request(), deps(analyst))).json()).toEqual(withheldPayload);

    for (const [index, referral] of doctorARecords.slice(0, 4).entries()) {
      clock += 86_400_000;
      await referrals.update(doctorA, referral.id, {
        expectedRevision: referral.revision,
        idempotencyKey: `waiting-${index}`,
        patch: { queue: true },
      });
    }
    const smallCellPayload = await (await handleWorkspaceAggregateDashboard(request(), deps(analyst))).json();
    expect(smallCellPayload.aggregates).toMatchObject({ suppressed: true, total: null, groups: releasedGroups });
    expect(await (await handleWorkspaceAggregateDashboard(request(), deps(analyst))).json()).toEqual(smallCellPayload);

    const filtered = await handleWorkspaceAggregateDashboard(request("/api/workspace/aggregates?profile=Хирургический"), deps(analyst));
    expect(filtered.status).toBe(400);
    expect(filtered.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the published 10/10/10 snapshot when the next release would expose 9/7/14", async () => {
    let clock = Date.parse("2026-09-01T12:00:00Z");
    let serial = 0;
    const referrals = new ReferralService(new MemoryReferralRepository(), {
      now: () => clock,
      id: () => `difference-id-${++serial}`,
    });
    const records: { id: string; revision: number }[] = [];
    for (let index = 0; index < 30; index++) {
      records.push(await referrals.create(doctorA, {
        patientLabel: `Синтетический эпизод ${index}`,
        profile: "Хирургический",
        idempotencyKey: `difference-create-${index}`,
      }));
      clock += 1_000;
    }
    for (let index = 10; index < 20; index++) {
      records[index] = await referrals.update(doctorA, records[index].id, {
        expectedRevision: records[index].revision,
        idempotencyKey: `difference-waiting-${index}`,
        patch: { queue: true },
      });
      clock += 1_000;
    }
    for (let index = 20; index < 30; index++) {
      records[index] = await referrals.update(doctorA, records[index].id, {
        expectedRevision: records[index].revision,
        idempotencyKey: `difference-scheduled-${index}`,
        patch: { scheduledDate: "2026-09-01" },
      });
      clock += 1_000;
    }

    const baseline = await referrals.aggregates(analyst);
    expect(baseline).toMatchObject({ suppressed: false, total: 30 });
    expect(Object.fromEntries(baseline.groups.map((group) => [group.flow, group.count]))).toMatchObject({
      preparing: 10,
      waiting: 10,
      scheduled: 10,
    });

    records[0] = await referrals.update(doctorA, records[0].id, {
      expectedRevision: records[0].revision,
      idempotencyKey: "difference-one-to-waiting",
      patch: { queue: true },
    });
    clock += 1_000;
    for (let index = 10; index < 14; index++) {
      records[index] = await referrals.update(doctorA, records[index].id, {
        expectedRevision: records[index].revision,
        idempotencyKey: `difference-four-to-scheduled-${index}`,
        patch: { scheduledDate: "2026-09-01" },
      });
      clock += 1_000;
    }

    const withheld = await referrals.aggregates(analyst);
    expect(withheld).toMatchObject({ suppressed: true, total: null, groups: baseline.groups });
    expect(await referrals.aggregates(analyst)).toEqual(withheld);

    const actual = await referrals.aggregates(owner);
    expect(Object.fromEntries(actual.groups.map((group) => [group.flow, group.count]))).toMatchObject({
      preparing: 9,
      waiting: 7,
      scheduled: 14,
    });
  });
});
