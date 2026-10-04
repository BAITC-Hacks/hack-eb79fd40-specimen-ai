"use client";

import Link from "next/link";
import { useState } from "react";
import { profileDisplayName } from "@/lib/referrals/profiles";
import type { ReferralDetail } from "@/lib/referrals/types";
import { timestamp } from "../client";
import { EVENT_LABELS, referralActivity, useWorkspaceData } from "../data";
import { useWorkspaceContext } from "../shell";
import { EmptyState, Icon, PageHeading } from "../ui";
import s from "../dashboard.module.css";

const ACTIVITY_EVENT_LABELS = { ...EVENT_LABELS, doctor_assessment_changed: "Заключение врача" } as const;
const LABELS: Record<string, string> = { profile: "Профиль", destinationOrganization: "Принимающая организация", specialistReferred: "К узкому специалисту", preparationStarted: "Подготовка начата", sent: "Направление отправлено", queue: "Лист ожидания", scheduledDate: "Назначенная дата", attendance: "Явка", cancelled: "Отмена", requirementId: "Идентификатор обследования", label: "Обследование", resultAvailable: "Результат получен", performedOn: "Дата проведения", expiresOn: "Действует до", applicability: "Применимость" };
function display(value: unknown, key?: string): string {
  if (key === "profile" && typeof value === "string") return profileDisplayName(value);
  if (value === null) return "неизвестно";
  if (typeof value === "boolean") return value ? "да" : "нет";
  const values: Record<string, string> = { unknown: "неизвестно", yes: "да", no: "нет", attended: "явка подтверждена", not_attended: "неявка подтверждена" };
  return values[String(value)] ?? String(value);
}
export default function ActivityPage() {
  const { actor } = useWorkspaceContext();
  const allowed = actor.role !== "analyst";
  const resource = useWorkspaceData<{ referrals: ReferralDetail[] }>(allowed ? "/api/referrals" : null, actor.id + actor.role + actor.organizationId);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  if (!allowed) return <EmptyState title="История содержит персональные сведения" description="Аналитику доступны только сводные показатели." />;
  const items = referralActivity(resource.data?.referrals ?? [], query).filter((item) => !kind || item.event.type === kind);
  return <div className={s.stack}>
    <PageHeading eyebrow={actor.role === "owner" ? "История организации" : "Мои направления"} title="История подтверждений" description="Кто, когда и на каком основании изменил факты направления. История не перезаписывается." />
    <section className={s.card}><div className={s.toolbar}><label className={s.field}>Поиск<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Метка, профиль, автор, основание" /></label><label className={s.field}>Событие<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Все события</option>{Object.entries(ACTIVITY_EVENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className={s.secondary} onClick={resource.reload} disabled={resource.loading}><Icon name="refresh" size={16} />Обновить</button>{(query || kind) && <button className={s.secondary} onClick={() => { setQuery(""); setKind(""); }}>Сбросить</button>}</div></section>
    {resource.error && <p className={s.notice + " " + s.error} role="alert">{resource.error}</p>}
    {resource.loading ? <p className={s.loading} role="status">Загружаем историю…</p> : resource.data && <section className={s.card}>
      {items.length ? <ol className={s.timeline}>{items.map(({ referralId, patientLabel, profile, event }) => {
        const before = event.before as Record<string, unknown> | null;
        return <li key={event.id}><div className={s.row}><Link className={s.record} href={"/workspace/referrals/" + encodeURIComponent(referralId)}>{patientLabel}</Link><span className={s.tag}>Ревизия {event.revision}</span></div><p>{ACTIVITY_EVENT_LABELS[event.type]} · {profileDisplayName(profile)}</p><p className={s.muted}>{event.actorName} · источник: подтверждение врача</p><p className={s.small}>Записано: {timestamp(event.recordedAt)} · Событие: {timestamp(event.occurredAt)}</p>{event.reason && <p className={s.notice}>{event.reason}</p>}<details><summary className={s.sectionLink}>Что изменилось</summary><div className={s.details}>{Object.entries(event.after).filter(([key, value]) => LABELS[key] && (!before || before[key] !== value)).map(([key, value]) => <p key={key}><strong>{LABELS[key]}:</strong> {before && key in before ? display(before[key], key) + " → " : ""}{display(value, key)}</p>)}</div></details></li>;
      })}</ol> : <EmptyState title={query || kind ? "Подтверждения не найдены" : "История пока пуста"} description={query || kind ? "Попробуйте другой поиск или сбросьте фильтры." : "Здесь появятся создание направления, подтверждения фактов и записи обследований."} />}
    </section>}
    <p className={s.muted}>Показаны события доступных вам направлений. Это не журнал входов, внешних систем или доставки сообщений. Время записи и время самого события могут отличаться.</p>
  </div>;
}
