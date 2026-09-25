"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReferralDetail } from "@/lib/referrals/types";
import { profileDisplayName } from "@/lib/referrals/profiles";
import { calendarDate, COMPLETENESS_LABELS, FLOW_LABELS } from "../client";
import { EMPTY_FILTERS, filterReferrals, useWorkspaceData, type ReferralFilters } from "../data";
import { isOperationallyDelayed, useOperationalDelay } from "../operational-delay";
import { useWorkspaceContext } from "../shell";
import { EmptyState, Icon, PageHeading, StatusBadge } from "../ui";
import s from "../dashboard.module.css";

export default function ReferralsPage() {
  const { actor } = useWorkspaceContext();
  const allowed = actor.role !== "analyst";
  const resource = useWorkspaceData<{ referrals: ReferralDetail[] }>(allowed ? "/api/referrals" : null, actor.id + actor.role + actor.organizationId);
  const [filters, setFilters] = useState<ReferralFilters>({ ...EMPTY_FILTERS });
  const [delayThreshold, setDelayThreshold] = useOperationalDelay(actor.organizationId, actor.id);
  const change = (key: keyof ReferralFilters, value: string) => setFilters((previous) => ({ ...previous, [key]: value }));
  if (!allowed) return <EmptyState title="Здесь персональные направления" description="Вашей роли доступны только сводные показатели." action={<Link href="/workspace/analytics">Перейти к аналитике</Link>} />;
  const records = resource.data?.referrals ?? [];
  const filtered = filterReferrals(records, filters);
  const filtering = Object.values(filters).some(Boolean);
  return <div className={s.stack}>
    <PageHeading eyebrow={actor.role === "owner" ? "Организация" : "Мои записи"} title="Направления" description="Подтверждённые факты, комплектность пакетов и история каждого направления." actions={<Link className={s.button} href="/workspace/referrals/new"><Icon name="plus" size={16} />Создать направление</Link>} />
    <section className={s.card}>
      <div className={s.toolbar}>
        <label className={s.field}>Поиск<input type="search" value={filters.query} onChange={(e) => change("query", e.target.value)} placeholder="Метка, профиль, организация" /></label>
        <label className={s.field}>Этап<select value={filters.flow} onChange={(e) => change("flow", e.target.value)}><option value="">Все этапы</option>{Object.entries(FLOW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className={s.field}>Комплектность<select value={filters.completeness} onChange={(e) => change("completeness", e.target.value)}><option value="">Все значения</option>{Object.entries(COMPLETENESS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className={s.field}>Рабочий порог, дней<input type="number" min="0" step="0.1" value={delayThreshold} onChange={(e) => setDelayThreshold(e.target.value)} placeholder="Не задан" /></label>
        <button className={s.secondary} onClick={resource.reload} disabled={resource.loading} aria-label="Обновить направления"><Icon name="refresh" size={17} /></button>
      </div>
      <details style={{ marginTop: 16 }}><summary className={s.sectionLink}>Дополнительные фильтры</summary><div className={s.toolbar} style={{ marginTop: 16 }}>
        <label className={s.field}>Профиль<input value={filters.profile} onChange={(e) => change("profile", e.target.value)} placeholder="Название профиля" /></label>
        <label className={s.field}>На этапе не менее, дней<input type="number" min="0" step="0.1" value={filters.minDays} onChange={(e) => change("minDays", e.target.value)} placeholder="Без порога" /></label>
        <label className={s.field}>Назначенная дата с<input type="date" value={filters.dateFrom} onChange={(e) => change("dateFrom", e.target.value)} /></label>
        <label className={s.field}>Назначенная дата по<input type="date" value={filters.dateTo} onChange={(e) => change("dateTo", e.target.value)} /></label>
      </div><p className={s.small}>«На этапе не менее» — фильтр списка. Записи с неизвестным временем или датой не попадают в соответствующий фильтр.</p></details>
      <p className={s.small}>Рабочий порог сохраняется в этом браузере и подсвечивает задержки в списке, карточке и обзоре. Это не нормативный срок и не оценка медицинской срочности.</p>
      {filtering && <div className={s.actions} style={{ marginTop: 16 }}><span className={s.small}>Найдено {filtered.length} из {records.length}</span><button className={s.secondary} onClick={() => setFilters({ ...EMPTY_FILTERS })}>Сбросить фильтры</button></div>}
    </section>
    {resource.error && <p role="alert" className={s.notice + " " + s.error}>{resource.error}</p>}
    {resource.loading ? <p role="status" className={s.loading}>Загружаем направления…</p> : resource.data && <section className={s.card}>
      {filtered.length ? <><p className={s.mobileScrollHint}>Проведите таблицу в сторону, чтобы увидеть все столбцы.</p><div className={s.tableScroll}><table className={s.table}><thead><tr><th scope="col">Направление</th><th scope="col">Текущий этап</th><th scope="col">Комплектность</th><th scope="col">На этапе</th><th scope="col">Назначенная дата</th><th scope="col">Организация</th></tr></thead><tbody>{filtered.map((record) => {
        const delayed = isOperationallyDelayed(record, delayThreshold);
        return <tr key={record.id} className={delayed ? s.delayRow : undefined}>
          <td><Link className={s.record} href={"/workspace/referrals/" + encodeURIComponent(record.id)}>{record.patientLabel}</Link><div className={s.muted}>{profileDisplayName(record.profile)}</div><span className={s.mobileCompleteness} aria-hidden="true">Комплектность: {COMPLETENESS_LABELS[record.completeness.status]}</span></td>
          <td><StatusBadge flow={record.flow} /></td>
          <td><span className={s.tag + (record.completeness.status === "expired" ? " " + s.warning : "")}>{COMPLETENESS_LABELS[record.completeness.status]}</span></td>
          <td>{record.observedStageDays === null ? "Неизвестно" : record.observedStageDays.toFixed(1) + " дн."}{delayed && <span className={s.delayTag}>Рабочий порог превышен</span>}</td>
          <td>{calendarDate(record.scheduledDate)}</td><td>{record.destinationOrganization || "Не указана"}</td>
        </tr>;
      })}</tbody></table></div></> : <EmptyState title={records.length ? "Ничего не найдено" : "Направлений пока нет"} description={records.length ? "Измените поиск или сбросьте фильтры." : "Создайте направление вручную или на основе завершённого опроса."} action={records.length ? <button className={s.secondary} onClick={() => setFilters({ ...EMPTY_FILTERS })}>Сбросить фильтры</button> : <Link className={s.button} href="/workspace/referrals/new">Создать направление</Link>} />}
      <p className={s.small}>Время — с момента записи текущего этапа в кабинете. Это не срок ожидания по Порталу.</p>
    </section>}
  </div>;
}
