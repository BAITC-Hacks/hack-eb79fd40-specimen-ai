"use client";

import { useEffect, useState } from "react";
import type { ReferralAggregates, ReferralDetail, ReferralEvent } from "@/lib/referrals/types";
import type { TriageResult } from "@/lib/types";
import { workspaceRequest } from "./client";

export interface Intake { sessionId: string; createdAt: number; status: "collecting" | "completed" | "aborted"; deliveryStatus: "pending" | "sent" | "failed"; referralId: string | null; result?: TriageResult }
export function intakePresentation(result: TriageResult) {
  return {
    severityLabel: result.anamnesis.symptom.severity === null ? "Не указана" : result.anamnesis.symptom.severity + " / 10",
    routing: result.source === "rules_only" ? [] : result.routing.map((route) => ({
      specialty: route.specialty, confidenceLabel: result.source === "model" ? Math.round(route.confidence * 100) + "%" : null,
    })),
    routingHint: result.source === "llm_fallback" && result.routing.length > 0 ? "Ориентировочный маршрут, без числовой оценки" : null,
  };
}

export function useWorkspaceData<T>(url: string | null, scope: string) {
  const [version, setVersion] = useState(0);
  const key = `${scope}:${url}:${version}`;
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({ key: "", data: null, error: "" });
  useEffect(() => {
    if (!url) return;
    let active = true;
    workspaceRequest<T>(url).then((data) => { if (active) setState({ key, data, error: "" }); })
      .catch((error: Error) => { if (active) setState({ key, data: null, error: error.message }); });
    return () => { active = false; };
  }, [url, key]);
  const current = state.key === key && url !== null;
  return { data: current ? state.data : null, error: current ? state.error : "", loading: url !== null && !current, reload: () => setVersion((value) => value + 1) };
}

export function almatyDate(now: number): string { return new Date(now + 5 * 3_600_000).toISOString().slice(0, 10); }
export function useToday(): string | null {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setToday(almatyDate(Date.now()));
    update();
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); };
  }, []);
  return today;
}

export interface ReferralFilters { query: string; flow: string; profile: string; completeness: string; minDays: string; dateFrom: string; dateTo: string }
export const EMPTY_FILTERS: ReferralFilters = { query: "", flow: "", profile: "", completeness: "", minDays: "", dateFrom: "", dateTo: "" };
export function filterReferrals(records: readonly ReferralDetail[], filters: ReferralFilters): ReferralDetail[] {
  const query = filters.query.trim().toLocaleLowerCase("ru");
  const profile = filters.profile.trim().toLocaleLowerCase("ru");
  const days = filters.minDays.trim() === "" ? null : Number(filters.minDays);
  return records.filter((record) => (!query || `${record.patientLabel} ${record.profile} ${record.destinationOrganization ?? ""}`.toLocaleLowerCase("ru").includes(query))
    && (!filters.flow || record.flow === filters.flow)
    && (!profile || record.profile.toLocaleLowerCase("ru").includes(profile))
    && (!filters.completeness || record.completeness.status === filters.completeness)
    && (days === null || (Number.isFinite(days) && days >= 0 && record.observedStageDays !== null && record.observedStageDays >= days))
    && (!filters.dateFrom || (record.scheduledDate !== null && record.scheduledDate >= filters.dateFrom))
    && (!filters.dateTo || (record.scheduledDate !== null && record.scheduledDate <= filters.dateTo)));
}
export function upcomingReferrals(records: readonly ReferralDetail[], today: string): ReferralDetail[] {
  return records.filter((record) => !record.cancelled && record.attendance === null && record.scheduledDate !== null && record.scheduledDate >= today)
    .sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!) || a.patientLabel.localeCompare(b.patientLabel));
}
export function attentionReason(record: ReferralDetail, today: string): string | null {
  if (record.cancelled || record.attendance !== null) return null;
  if (record.scheduledDate && record.scheduledDate < today) return "Дата прошла · явка ещё не подтверждена";
  if (record.completeness.status === "expired") return "Проверить сроки обследований";
  if (record.completeness.status === "unknown") return "Комплектность пока не проверена";
  if (record.completeness.status === "incomplete") return "Уточнить недостающие обследования";
  return null;
}
export function attentionReferrals(records: readonly ReferralDetail[], today: string): ReferralDetail[] {
  const rank = (record: ReferralDetail) => record.scheduledDate !== null && record.scheduledDate < today ? 0
    : record.completeness.status === "expired" ? 1 : record.completeness.status === "incomplete" ? 2 : 3;
  return records.filter((record) => attentionReason(record, today) !== null)
    .sort((a, b) => rank(a) - rank(b) || (a.scheduledDate ?? "9999").localeCompare(b.scheduledDate ?? "9999") || b.updatedAt - a.updatedAt);
}
export interface ActivityItem { referralId: string; patientLabel: string; profile: string; event: ReferralEvent }
export function referralActivity(records: readonly ReferralDetail[], query = ""): ActivityItem[] {
  const search = query.trim().toLocaleLowerCase("ru");
  return records.flatMap((record) => record.events.map((event) => ({ referralId: record.id, patientLabel: record.patientLabel, profile: record.profile, event })))
    .filter((item) => !search || `${item.patientLabel} ${item.profile} ${item.event.actorName} ${item.event.reason ?? ""}`.toLocaleLowerCase("ru").includes(search))
    .sort((a, b) => b.event.recordedAt - a.event.recordedAt || b.event.revision - a.event.revision || a.event.id.localeCompare(b.event.id));
}
export function dashboardCounts(records: readonly ReferralDetail[], today: string) {
  return { total: records.length, waiting: records.filter((r) => r.flow === "waiting").length,
    upcoming: upcomingReferrals(records, today).length, attention: records.filter((r) => attentionReason(r, today) !== null).length };
}
export function aggregateView(value: ReferralAggregates) {
  const visible = value.suppressed ? value.groups.filter((group) => group.count >= 5) : value.groups;
  return {
    total: value.total,
    groups: visible,
    knownTimes: value.suppressed || visible.some((group) => group.observedTimeCount === null)
      ? null : visible.reduce((sum, group) => sum + (group.observedTimeCount ?? 0), 0),
  };
}
export function shiftMonth(month: string, offset: number): string {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1 + offset, 1)).toISOString().slice(0, 7);
}
export function monthDays(month: string): string[] {
  const [year, index] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, index - 1, 1));
  const start = first.getTime() - ((first.getUTCDay() + 6) % 7) * 86_400_000;
  return Array.from({ length: 42 }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}
export function calendarRecords(records: readonly ReferralDetail[], date: string): ReferralDetail[] {
  return records.filter((record) => !record.cancelled && record.scheduledDate === date);
}
export const EVENT_LABELS = { created: "Направление создано", facts_changed: "Факты подтверждены", examination_recorded: "Обследование записано", registration_snapshot_recorded: "Снимок при регистрации подтверждён" };
