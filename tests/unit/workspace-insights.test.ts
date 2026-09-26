import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReferralAggregates, ReferralDetail } from "../../lib/referrals/types";
import waitTimeReport from "../../reports/wait-time-baseline-v0.json";
import refusalReport from "../../reports/referral-refusal-baseline-v0.json";
import labLoadReport from "../../reports/lab-load-v1.json";
import { aggregateCoverage, barWidth, DEMO_ORGANIZATION_COMPARISON, insightEndpoint, MODEL_EVIDENCE, referralQuality, timelinePoints } from "../../app/workspace/insights";

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
  const grouped = (value: number) => value.toLocaleString("ru-RU").replace(/\s/gu, " ");
  it("uses only unfiltered aggregate API for every analyst page and all analytics roles", () => {
    for (const role of ["doctor", "owner", "analyst"] as const) expect(insightEndpoint(role, "analytics")).toBe("/api/workspace/aggregates");
    expect(insightEndpoint("analyst", "quality")).toBe("/api/workspace/aggregates");
    expect(insightEndpoint("doctor", "quality")).toBe("/api/referrals");
    expect(insightEndpoint("owner", "quality")).toBe("/api/referrals");
  });
  it("uses explicitly allowed totals during partial suppression but never reconstructs hidden cells", () => {
    expect(aggregateCoverage(aggregate({ suppressed: true }))).toEqual({ total: 10, knownTime: 5, unknownTime: 5 });
    expect(aggregateCoverage(aggregate({ suppressed: true, total: null, groups: [
      { flow: "preparing", count: 6, meanObservedDays: null, observedTimeCount: null },
    ] }))).toBeNull();
    expect(aggregateCoverage(aggregate({ total: null }))).toBeNull();
    expect(aggregateCoverage(aggregate({ groups: [
      { flow: "preparing", count: 10, meanObservedDays: null, observedTimeCount: null },
    ] }))).toBeNull();
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

  it("shows only honest research evidence with status, held-out error, baseline and period", () => {
    expect(MODEL_EVIDENCE.map((entry) => entry.id)).toEqual(["D1", "B3", "D2"]);
    for (const entry of MODEL_EVIDENCE) {
      expect(entry.statusLabel).not.toBe("");
      expect(entry.heldOutMetric).not.toBe("");
      expect(entry.baseline).not.toBe("");
      expect(entry.evaluationPeriod).not.toBe("");
      expect(entry.status).not.toBe("operational");
    }
    expect(MODEL_EVIDENCE[0]).toMatchObject({
      status: "research_only",
      heldOutMetric: `MAE ${waitTimeReport.test.model.mae_days.toFixed(3).replace(".", ",")} дня на календарном test`,
      baseline: `Иерархическая медиана: MAE ${waitTimeReport.test.hierarchical_median_baseline.mae_days.toFixed(3).replace(".", ",")} дня`,
      evaluationPeriod: `Test: март 2025 · ${grouped(waitTimeReport.split.test.rows)} записи`,
    });
    expect(MODEL_EVIDENCE[1]).toMatchObject({
      status: "research_only",
      heldOutMetric: `Brier ${refusalReport.test.one_hot_logistic_regression.metrics.brier.toFixed(6).replace(".", ",")} на календарном test`,
      baseline: `Сглаженный профильный baseline: Brier ${refusalReport.test.smoothed_pair_baseline.metrics.brier.toFixed(6).replace(".", ",")}`,
      evaluationPeriod: `Test: март 2025 · ${grouped(refusalReport.split.test.rows)} записи`,
    });
    expect(MODEL_EVIDENCE[0].note).toContain("Март ранее изучался в исходной передаче данных");
    expect(MODEL_EVIDENCE[1].note).toContain("Март ранее изучался в исходной передаче данных");
    expect(MODEL_EVIDENCE[2]).toMatchObject({ status: "unavailable_data" });
    expect(MODEL_EVIDENCE[2].heldOutMetric).toContain("Не рассчитана");
    expect(MODEL_EVIDENCE[2].baseline).toContain("Не рассчитан");
  });

  it("binds the D2 unavailable card to the tracked lab-load blocker report", () => {
    const d2 = MODEL_EVIDENCE.find((entry) => entry.id === "D2")!;
    expect(labLoadReport).toMatchObject({
      task: "D2_laboratory_load_forecast",
      status: "blocked_missing_laboratory_demand_target",
      runtime_activation: "blocked",
      publication: { metrics_claim_allowed: false },
      source: { calendar_months: ["2025-01", "2025-02", "2025-03"], laboratory_event_rows: null },
      target: { available: false, proxy_allowed: false, missing_groups: ["event_time", "examination_identity", "load_measure", "laboratory_identity"] },
      temporal_benchmark: { executed: false, held_out_metrics: { mae: null, peak_recall: null, rmse: null }, seasonal_baseline: null },
    });
    expect(d2).toMatchObject({
      status: "unavailable_data",
      evaluationPeriod: "Аудит источника: январь — март 2025",
    });
    expect(d2.heldOutMetric).toContain("нет наблюдаемых лабораторных событий");
    expect(d2.baseline).toContain("нормативный перечень не заменяет фактическую нагрузку");
  });

  it("keeps the two-organization fallback internally coherent and unmistakably synthetic", () => {
    expect(DEMO_ORGANIZATION_COMPARISON).toMatchObject({
      status: "synthetic_demo_not_operational",
      label: expect.stringMatching(/Синтетический.*не данные организаций/iu),
    });
    expect(DEMO_ORGANIZATION_COMPARISON.organizations).toHaveLength(2);
    expect(new Set(DEMO_ORGANIZATION_COMPARISON.organizations.map((item) => item.id)).size).toBe(2);
    for (const organization of DEMO_ORGANIZATION_COMPARISON.organizations) {
      const profileTotal = organization.profiles.reduce((sum, profile) => sum + profile.count, 0);
      const timelineTotal = DEMO_ORGANIZATION_COMPARISON.timeline.reduce((sum, row) => sum + row.values[organization.id], 0);
      expect(timelineTotal).toBe(profileTotal);
    }
    const apiSource = readFileSync(resolve(process.cwd(), "app/api/workspace/aggregates/handler.ts"), "utf8");
    expect(apiSource).not.toContain("DEMO_ORGANIZATION_COMPARISON");
  });

  it("omits the cancelled prediction and does not present a real regional comparison", () => {
    const source = readFileSync(resolve(process.cwd(), "app/workspace/analytics/page.tsx"), "utf8");
    expect(source).not.toMatch(/D[4]|no[-]show|риск\s+неявки/iu);
    expect(source).not.toMatch(/региональн[^<]*сравнен/iu);
    expect(source).toContain("Рабочее сравнение организаций не показано");
    expect(source).toContain("data-data-origin=\"synthetic-demo\"");
    expect(source).toContain("Синтетический пример");
  });
});
