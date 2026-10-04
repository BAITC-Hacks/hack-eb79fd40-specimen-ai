import type { ReferralActor, ReferralAggregates, ReferralDetail } from "@/lib/referrals/types";

export type InsightAggregate = ReferralAggregates;

export interface ModelEvidenceCard {
  id: "D1" | "D2" | "B3";
  title: string;
  status: "research_only" | "unavailable_data";
  statusLabel: string;
  heldOutMetric: string;
  baseline: string;
  evaluationPeriod: string;
  note: string;
}

export const DEMO_ORGANIZATION_COMPARISON = {
  status: "synthetic_demo_not_operational",
  label: "Синтетический демо-пример — не данные организаций",
  period: "Демо-период: 2–29 сентября 2026",
  organizations: [
    {
      id: "demo-north",
      name: "Демо-клиника «Север»",
      profiles: [
        { profile: "Хирургический", count: 12 },
        { profile: "Кардиологический", count: 7 },
      ],
    },
    {
      id: "demo-center",
      name: "Демо-клиника «Центр»",
      profiles: [
        { profile: "Хирургический", count: 9 },
        { profile: "Кардиологический", count: 11 },
      ],
    },
  ],
  timeline: [
    { period: "2–8 сен", values: { "demo-north": 4, "demo-center": 5 } },
    { period: "9–15 сен", values: { "demo-north": 5, "demo-center": 4 } },
    { period: "16–22 сен", values: { "demo-north": 3, "demo-center": 6 } },
    { period: "23–29 сен", values: { "demo-north": 7, "demo-center": 5 } },
  ],
} as const;

// Values are a deliberately small, non-operational projection of the tracked
// offline reports. No scorer, patient feature or recommendation is exposed.
export const MODEL_EVIDENCE: readonly ModelEvidenceCard[] = [
  {
    id: "D1",
    title: "Срок до госпитализации",
    status: "research_only",
    statusLabel: "Только исследование",
    heldOutMetric: "MAE 3,577 дня на календарном test",
    baseline: "Иерархическая медиана: MAE 3,621 дня",
    evaluationPeriod: "Test: март 2025 · 191 573 записи",
    note: "Март ранее изучался в исходной передаче данных, поэтому это не новый нетронутый holdout. Модель не подключена к рабочему процессу.",
  },
  {
    id: "B3",
    title: "Факт отказа в направлении",
    status: "research_only",
    statusLabel: "Только исследование",
    heldOutMetric: "Brier 0,084677 на календарном test",
    baseline: "Сглаженный профильный baseline: Brier 0,087125",
    evaluationPeriod: "Test: март 2025 · 223 353 записи",
    note: "Март ранее изучался в исходной передаче данных, поэтому это не новый нетронутый holdout. PR-AUC модели — 0,348210 против 0,312687 у baseline. Исследовательская оценка доступна в карточке только по отдельно подтверждённому снимку семи полей на момент регистрации и не влияет на решение врача.",
  },
  {
    id: "D2",
    title: "Нагрузка лабораторий",
    status: "unavailable_data",
    statusLabel: "Недоступно: нет целевого ряда",
    heldOutMetric: "Не рассчитана: нет наблюдаемых лабораторных событий",
    baseline: "Не рассчитан: нормативный перечень не заменяет фактическую нагрузку",
    evaluationPeriod: "Аудит источника: январь — март 2025",
    note: "В источнике нет идентификатора исследования, времени лабораторного события и числа выполненных единиц. Рабочая оценка невозможна.",
  },
] as const;

export function insightEndpoint(role: ReferralActor["role"], page: "analytics" | "quality"): string {
  return page === "quality" && role !== "analyst" ? "/api/referrals" : "/api/workspace/aggregates";
}

export function aggregateCoverage(value: InsightAggregate): { total: number; knownTime: number; unknownTime: number } | null {
  if (value.total === null) return null;
  let knownTime = 0;
  for (const group of value.groups) {
    if (group.observedTimeCount === null) return null;
    knownTime += group.observedTimeCount;
  }
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

export function bottleneckNotes(
  value: InsightAggregate,
  flowLabel: (flow: ReferralAggregates["groups"][number]["flow"]) => string = (flow) => flow,
): string[] {
  if (value.groups.length === 0) return [];
  const notes: string[] = [];
  const largest = value.groups.reduce((left, right) => right.count > left.count ? right : left);
  notes.push(`Больше всего записей сейчас на этапе «${flowLabel(largest.flow)}»: ${largest.count}.`);
  const timed = value.groups.filter((group) => group.meanObservedDays !== null && (group.observedTimeCount ?? 0) > 0);
  if (timed.length > 0) {
    const longest = timed.reduce((left, right) => (right.meanObservedDays ?? 0) > (left.meanObservedDays ?? 0) ? right : left);
    notes.push(`Наибольшее наблюдаемое среднее время у этапа «${flowLabel(longest.flow)}»: ${longest.meanObservedDays!.toFixed(1)} дн. по ${longest.observedTimeCount} записям.`);
  }
  const coverage = aggregateCoverage(value);
  if (coverage && coverage.knownTime < coverage.total) {
    notes.push(`Время этапа известно для ${coverage.knownTime} из ${coverage.total} записей; остальные не включены в среднее.`);
  }
  return notes;
}

export function timelinePoints(rows: ReferralAggregates["timeline"], field: "totalCount" | "waitingCount"): string {
  const maximum = Math.max(0, ...rows.map((row) => Math.max(row.totalCount, row.waitingCount)));
  return rows.map((row, index) => `${32 + index * 656 / Math.max(1, rows.length - 1)},${174 - (maximum ? row[field] / maximum * 146 : 0)}`).join(" ");
}
