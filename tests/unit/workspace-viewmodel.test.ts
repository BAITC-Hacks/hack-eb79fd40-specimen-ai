import { describe, expect, it } from "vitest";
import type { ReferralAggregates, ReferralDetail, ReferralFacts } from "../../lib/referrals/types";
import { aggregateView, almatyDate, attentionReason, attentionReferrals, calendarRecords, dashboardCounts, EMPTY_FILTERS, filterReferrals, intakePresentation, monthDays, referralActivity, shiftMonth, upcomingReferrals } from "../../app/workspace/data";
import { FRONTEND_RESULT } from "../fixtures/frontend-result";

function referral(patch: Partial<ReferralDetail> = {}): ReferralDetail {
  return {
    id: "r1", organizationId: "org", doctorId: "doctor", patientLabel: "Эпизод А", profile: "Терапия",
    sourceSessionId: null, triageSnapshot: null, createdAt: 100, updatedAt: 100, revision: 1, events: [], examinations: [],
    specialistReferred: null, preparationStarted: true, destinationOrganization: null, sent: null, queue: null,
    scheduledDate: null, attendance: null, cancelled: false, flow: "preparing", observedStageDays: null,
    completeness: { status: "unknown", evaluatedOn: "2026-09-13", basis: "today", catalogueVersion: "unverified-1", catalogueAvailable: false, entries: [] },
    ...patch,
  };
}
function aggregates(patch: Partial<ReferralAggregates> = {}): ReferralAggregates {
  return { suppressed: false, total: 0, groups: [], scope: "organization", dataSource: "doctor_confirmed_local_records", forecast: null, perProfile: [], period: { from: "2026-08-15", to: "2026-09-13" }, timeline: [], timelineSource: "observed_snapshot", timelineUnavailableReason: "not_available_for_analyst", ...patch };
}
describe("workspace view models", () => {
  it("shows routing numbers only for model output and distinguishes unknown severity from zero", () => {
    const result = structuredClone(FRONTEND_RESULT);
    result.routing = [{ specialty: "Терапия", confidence: 0.4 }];
    result.anamnesis.symptom.severity = null;
    result.source = "rules_only";
    expect(intakePresentation(result)).toEqual({ severityLabel: "Не указана", routing: [], routingHint: null });
    result.source = "llm_fallback";
    expect(intakePresentation(result).routing).toEqual([{ specialty: "Терапия", confidenceLabel: null }]);
    expect(intakePresentation(result).routingHint).toBe("Ориентировочный маршрут, без числовой оценки");
    result.source = "model"; result.anamnesis.symptom.severity = 0;
    expect(intakePresentation(result)).toEqual({ severityLabel: "0 / 10", routing: [{ specialty: "Терапия", confidenceLabel: "40%" }], routingHint: null });
  });
  it("preserves zero counts and unknown ages without inventing an observation", () => {
    expect(dashboardCounts([], "2026-09-13")).toEqual({ total: 0, waiting: 0, upcoming: 0, attention: 0 });
    const records = [referral(), referral({ id: "zero", observedStageDays: 0 })];
    expect(filterReferrals(records, { ...EMPTY_FILTERS, minDays: "0" }).map((record) => record.id)).toEqual(["zero"]);
    expect(filterReferrals(records, { ...EMPTY_FILTERS, minDays: "not-a-number" })).toEqual([]);
    expect(records[0].observedStageDays).toBeNull();
  });
  it("combines search, stage, profile, completeness, inclusive age and date filters", () => {
    const record = referral({ scheduledDate: "2026-09-13", observedStageDays: 3, flow: "scheduled", destinationOrganization: "Центр" });
    expect(filterReferrals([record], { query: " центр ", flow: "scheduled", profile: "тера", completeness: "unknown", minDays: "3", dateFrom: "2026-09-13", dateTo: "2026-09-13" })).toEqual([record]);
    expect(filterReferrals([record], { ...EMPTY_FILTERS, minDays: "3.1" })).toEqual([]);
    expect(filterReferrals([referral()], { ...EMPTY_FILTERS, dateTo: "2026-09-20" })).toEqual([]);
  });
  it("does not manufacture non-attendance when a date passes", () => {
    const past = referral({ scheduledDate: "2026-09-12" });
    expect(attentionReason(past, "2026-09-13")).toBe("Дата прошла · явка ещё не подтверждена");
    expect(past.attendance).toBeNull();
    expect(attentionReason(referral({ attendance: "attended" }), "2026-09-13")).toBeNull();
    expect(attentionReason(referral({ cancelled: true }), "2026-09-13")).toBeNull();
  });
  it("prioritizes a past unconfirmed date over many unavailable catalogues", () => {
    const unknown = Array.from({ length: 10 }, (_, index) => referral({ id: "unknown-" + index }));
    const past = referral({ id: "past", scheduledDate: "2026-09-12" });
    expect(attentionReferrals([...unknown, past], "2026-09-13")[0].id).toBe("past");
  });
  it("upcoming dates are explicit, sorted, not cancelled and not already attended", () => {
    const today = referral({ id: "today", scheduledDate: "2026-09-13" });
    const later = referral({ id: "later", scheduledDate: "2026-09-20" });
    expect(upcomingReferrals([later, referral(), today, referral({ scheduledDate: "2026-09-12" }), referral({ scheduledDate: "2026-09-14", cancelled: true }), referral({ scheduledDate: "2026-09-14", attendance: "attended" })], "2026-09-13")).toEqual([today, later]);
  });
  it("suppression dominates any accidental attached counts or rows", () => {
    expect(aggregateView(aggregates({ suppressed: true, total: 3, groups: [{ flow: "waiting", count: 3, meanObservedDays: 1, observedTimeCount: 3 }] }))).toEqual({ total: null, groups: [], knownTimes: null });
    expect(aggregateView(aggregates()).total).toBe(0);
    expect(aggregateView(aggregates({ total: null })).total).toBeNull();
  });
  it("calendar respects Almaty midnight, leap years, Mondays and year rollover", () => {
    expect(almatyDate(Date.parse("2026-09-13T18:59:59Z"))).toBe("2026-09-13");
    expect(almatyDate(Date.parse("2026-09-13T19:00:00Z"))).toBe("2026-09-14");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    const days = monthDays("2024-02");
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2024-01-29");
    expect(days).toContain("2024-02-29");
    expect(new Set(days).size).toBe(42);
  });
  it("calendar does not add unknown dates and keeps explicit attendance", () => {
    const known = referral({ scheduledDate: "2026-09-13", attendance: "not_attended" });
    expect(calendarRecords([known, referral(), referral({ scheduledDate: "2026-09-13", cancelled: true })], "2026-09-13")).toEqual([known]);
  });
  it("activity sorts by recorded time, preserving unknown actual time and searches author", () => {
    const facts = { profile: "Терапия", specialistReferred: null, preparationStarted: true, destinationOrganization: null, sent: null, queue: null, scheduledDate: null, attendance: null, cancelled: false } satisfies ReferralFacts;
    const first = referral({ events: [{ id: "e1", type: "created", actorId: "doctor", actorName: "Врач А", source: "doctor_confirmation", occurredAt: null, recordedAt: 100, reason: null, before: null, after: facts, revision: 1 }] });
    const second = referral({ id: "r2", events: [{ ...first.events[0], id: "e2", actorName: "Врач Б", recordedAt: 200, occurredAt: 50 }] });
    expect(referralActivity([first, second]).map((item) => item.event.id)).toEqual(["e2", "e1"]);
    expect(referralActivity([first, second], "врач а")[0].event.occurredAt).toBeNull();
    expect(referralActivity([first, second], "несуществующий")).toEqual([]);
  });
});
