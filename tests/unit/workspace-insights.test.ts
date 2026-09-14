import { describe, expect, it } from "vitest";
import type { ReferralAggregates, ReferralDetail } from "../../lib/referrals/types";
import { aggregateCoverage, barWidth, insightEndpoint, referralQuality, timelinePoints } from "../../app/workspace/insights";

const aggregate = (patch: Partial<ReferralAggregates> = {}): ReferralAggregates => ({
  suppressed: false, total: 10,
  groups: [{ flow: "preparing", count: 10, meanObservedDays: 2, observedTimeCount: 5 }],
  scope: "organization", dataSource: "doctor_confirmed_local_records", forecast: null,
  perProfile: [], period: { from: "2026-09-01", to: "2026-09-30" }, timeline: [], timelineSource: "observed_snapshot", timelineUnavailableReason: null, ...patch,
});
const item = (patch: Partial<ReferralDetail> = {}) => ({
  queue: null, scheduledDate: null, attendance: null, observedStageDays: null,
  completeness: { status: "unknown", evaluatedOn: "2026-09-13", basis: "today", catalogueVersion: "unknown", catalogueAvailable: false, entries: [] },
  ...patch,
}) as Pick<ReferralDetail, "queue" | "scheduledDate" | "attendance" | "observedStageDays" | "completeness">;

describe("workspace insights: scoped data and honest quantities", () => {
  it("uses only unfiltered aggregate API for every analyst page and all analytics roles", () => {
    for (const role of ["doctor", "owner", "analyst"] as const) expect(insightEndpoint(role, "analytics")).toBe("/api/workspace/aggregates");
    expect(insightEndpoint("analyst", "quality")).toBe("/api/workspace/aggregates");
    expect(insightEndpoint("doctor", "quality")).toBe("/api/referrals");
    expect(insightEndpoint("owner", "quality")).toBe("/api/referrals");
  });
  it("never derives a count from suppressed groups, even if fields contain residual values", () => {
    expect(aggregateCoverage(aggregate({ suppressed: true }))).toBeNull();
    expect(aggregateCoverage(aggregate({ total: null }))).toBeNull();
    expect(aggregateCoverage(aggregate())).toEqual({ total: 10, knownTime: 5, unknownTime: 5 });
    expect(aggregateCoverage(aggregate({ total: 0, groups: [] }))).toEqual({ total: 0, knownTime: 0, unknownTime: 0 });
  });
  it("counts null separately from explicit false, zero time, and confirmed nonattendance", () => {
    const result = referralQuality([item(), item({ queue: false, scheduledDate: "2026-01-01", attendance: "not_attended", observedStageDays: 0 })]);
    expect(result).toEqual({ total: 2, queueUnknown: 1, dateUnknown: 1, attendanceUnknown: 1, catalogueUnavailable: 2, completenessUnknown: 2, timeUnknown: 1 });
  });
  it("does not infer attendance from a past scheduled date or readiness from an empty catalogue", () => {
    expect(referralQuality([item({ scheduledDate: "2020-01-01" })])).toMatchObject({ attendanceUnknown: 1, catalogueUnavailable: 1, completenessUnknown: 1 });
    expect(referralQuality([])).toEqual({ total: 0, queueUnknown: 0, dateUnknown: 0, attendanceUnknown: 0, catalogueUnavailable: 0, completenessUnknown: 0, timeUnknown: 0 });
  });
  it("draws no phantom minimum bars for zero and uses a shared timeline scale", () => {
    expect(barWidth(0, 10)).toBe("0%");
    expect(barWidth(0, 0)).toBe("0%");
    expect(barWidth(5, 10)).toBe("50%");
    const rows = [{ date: "2026-09-13", totalCount: 10, createdCount: 5, waitingCount: 5 }];
    expect(timelinePoints(rows, "totalCount")).toBe("32,28");
    expect(timelinePoints(rows, "waitingCount")).toBe("32,101");
    expect(timelinePoints([], "totalCount")).toBe("");
    expect(timelinePoints([{ ...rows[0], totalCount: 0, waitingCount: 0 }], "totalCount")).toBe("32,174");
  });
});
