"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReferralDetail } from "@/lib/referrals/types";
import { calendarDate } from "../client";
import { calendarRecords, monthDays, shiftMonth, useToday, useWorkspaceData } from "../data";
import { useWorkspaceContext } from "../shell";
import { EmptyState, Icon, PageHeading } from "../ui";
import s from "../dashboard.module.css";

const ATTENDANCE = { attended: "Явка подтверждена", not_attended: "Неявка подтверждена" };
function Agenda({ records }: { records: ReferralDetail[] }) {
  return records.length ? <div className={s.tableScroll}><table className={s.table}><thead><tr><th>Дата</th><th>Направление</th><th>Принимающая организация</th><th>Явка</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{calendarDate(record.scheduledDate)}</td><td><Link className={s.record} href={"/workspace/referrals/" + encodeURIComponent(record.id)}>{record.patientLabel}</Link><div className={s.muted}>{record.profile}</div></td><td>{record.destinationOrganization || "Не указана"}</td><td><span className={s.tag}>{record.attendance === null ? "Явка неизвестна" : ATTENDANCE[record.attendance]}</span></td></tr>)}</tbody></table></div> : <EmptyState title="Подтверждённых дат нет" description="Дата появится после явного подтверждения в карточке направления." />;
}
export default function CalendarPage() {
  const { actor } = useWorkspaceContext();
  const allowed = actor.role !== "analyst";
  const resource = useWorkspaceData<{ referrals: ReferralDetail[] }>(allowed ? "/api/referrals" : null, actor.id + actor.role + actor.organizationId);
  const today = useToday();
  const [chosenMonth, setMonth] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [mode, setMode] = useState<"month" | "agenda">("month");
  if (!allowed) return <EmptyState title="Календарь содержит персональные записи" description="Аналитику доступны только сводные показатели." />;
  const month = chosenMonth ?? today?.slice(0, 7);
  const selected = selectedDate ?? today;
  const records = resource.data?.referrals ?? [];
  const monthly = month ? records.filter((r) => !r.cancelled && r.scheduledDate?.startsWith(month)).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!)) : [];
  const unknown = records.filter((r) => !r.cancelled && r.scheduledDate === null).length;
  function move(offset: number) { if (month) { const next = shiftMonth(month, offset); setMonth(next); setSelectedDate(next + "-01"); } }
  return <div className={s.stack}>
    <PageHeading eyebrow={actor.role === "owner" ? "Даты организации" : "Мои даты"} title="Календарь направлений" description="Только даты, подтверждённые врачом. Это не расписание приёмов и не бронирование мест." actions={<button className={s.secondary} onClick={resource.reload} disabled={resource.loading}><Icon name="refresh" size={16} />Обновить</button>} />
    {resource.error && <p role="alert" className={s.notice + " " + s.error}>{resource.error}</p>}
    {resource.loading || !month ? <p role="status" className={s.loading}>Загружаем календарь…</p> : resource.data && <>
      <section className={s.card}>
        <div className={s.monthHeader}><h2 className={s.monthTitle}>{new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(month + "-01T00:00:00Z"))}</h2><div className={s.actions}><button className={s.secondary} onClick={() => move(-1)} aria-label="Предыдущий месяц">←</button><button className={s.secondary} onClick={() => { setMonth(null); setSelectedDate(null); }}>Сегодня</button><button className={s.secondary} onClick={() => move(1)} aria-label="Следующий месяц">→</button><button className={mode === "month" ? s.button : s.secondary} aria-pressed={mode === "month"} onClick={() => setMode("month")}>Месяц</button><button className={mode === "agenda" ? s.button : s.secondary} aria-pressed={mode === "agenda"} onClick={() => setMode("agenda")}>Список</button></div></div>
        {mode === "month" ? <div className={s.calendar} aria-label="Даты подтверждений за месяц">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => <div key={day} className={s.weekday}>{day}</div>)}{monthDays(month).map((date) => {
          const count = calendarRecords(records, date).length;
          return <button key={date} type="button" className={[s.day, !date.startsWith(month) ? s.outside : "", date === selected ? s.selected : ""].join(" ")} aria-pressed={date === selected} aria-label={calendarDate(date) + ": направлений " + count} onClick={() => { setSelectedDate(date); if (!date.startsWith(month)) setMonth(date.slice(0, 7)); }}><span className={date === today ? s.today : ""}>{Number(date.slice(-2))}</span>{count > 0 && <span className={s.dateCount}>{count} напр.</span>}</button>;
        })}</div> : <Agenda records={monthly} />}
        <p className={s.muted}>{monthly.length} направлений с назначенной датой в этом месяце. Без даты: {unknown}. Отменённые направления не включены.</p>
      </section>
      {mode === "month" && selected && <section className={s.card}><div className={s.head}><h2>На {calendarDate(selected)}</h2><Icon name="calendar" size={20} /></div><Agenda records={calendarRecords(records, selected)} /></section>}
      <div className={s.notice}>Если назначенная дата прошла, явка всё равно остаётся неизвестной до подтверждения врача. Перенос даты и исправление выполняются в карточке с записью в историю.</div>
    </>}
  </div>;
}
