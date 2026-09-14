import type { ReferralActor, ReferralAggregates, ReferralDetail } from "@/lib/referrals/types";

export function insightEndpoint(role: ReferralActor["role"], page: "analytics" | "quality"): string {
  return page === "quality" && role !== "analyst" ? "/api/referrals" : "/api/workspace/aggregates";
}

export function aggregateCoverage(value: ReferralAggregates): { total: number; knownTime: number; unknownTime: number } | null {
  if (value.suppressed || value.total === null) return null;
  const knownTime = value.groups.reduce((sum, group) => sum + group.observedTimeCount, 0);
  return { total: value.total, knownTime, unknownTime: value.total - knownTime };
}

export function referralQuality(referrals: readonly Pick<ReferralDetail, "queue" | "scheduledDate" | "attendance" | "completeness" | "observedStageDays">[]) {
  return {
    total: referrals.length,
    queueUnknown: referrals.filter((item) => item.queue === null).length,
    dateUnknown: referrals.filter((item) => item.scheduledDate === null).length,
    attendanceUnknown: referrals.filter((item) => item.attendance === null).length,
    catalogueUnavailable: referrals.filter((item) => !item.completeness.catalogueAvailable).length,
    completenessUnknown: referrals.filter((item) => item.completeness.status === "unknown").length,
    timeUnknown: referrals.filter((item) => item.observedStageDays === null).length,
  };
}

export function barWidth(value: number, maximum: number): string {
  return `${maximum > 0 ? Math.min(100, Math.max(0, value / maximum * 100)) : 0}%`;
}

export function timelinePoints(rows: ReferralAggregates["timeline"], field: "totalCount" | "waitingCount"): string {
  const maximum = Math.max(0, ...rows.map((row) => Math.max(row.totalCount, row.waitingCount)));
  return rows.map((row, index) => `${32 + index * 656 / Math.max(1, rows.length - 1)},${174 - (maximum ? row[field] / maximum * 146 : 0)}`).join(" ");
}
