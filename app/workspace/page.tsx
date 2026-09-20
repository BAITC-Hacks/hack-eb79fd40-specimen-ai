"use client";

import Link from "next/link";
import type { ReferralAggregates, ReferralDetail, ReferralFlow } from "@/lib/referrals/types";
import { calendarDate, FLOW_LABELS, timestamp } from "./client";
import { aggregateView, attentionReason, attentionReferrals, dashboardCounts, EVENT_LABELS, referralActivity, upcomingReferrals, useToday, useWorkspaceData } from "./data";
import { isOperationallyDelayed, useOperationalDelay } from "./operational-delay";
import { useWorkspaceContext } from "./shell";
import { EmptyState, Icon, KpiCard, PageHeading, StatusBadge } from "./ui";
import s from "./dashboard.module.css";

function StageBars({ groups }: { groups: { flow: ReferralFlow; count: number }[] }) {
  const maximum = Math.max(1, ...groups.map((group) => group.count));
  return <div>{groups.map((group) => <div className={s.barRow} key={group.flow}><span>{FLOW_LABELS[group.flow]}</span><div className={s.barTrack}><span className={s.barFill} style={{ width: (group.count / maximum * 100) + "%" }} /></div><strong>{group.count}</strong></div>)}</div>;
}

export default function Overview() {
  const { actor } = useWorkspaceContext();
  const [delayThreshold, setDelayThreshold] = useOperationalDelay(actor.organizationId, actor.id);
  const analyst = actor.role === "analyst";
  const scope = actor.organizationId + ":" + actor.id + ":" + actor.role;
  const records = useWorkspaceData<{ referrals: ReferralDetail[] }>(analyst ? null : "/api/referrals", scope);
  const summary = useWorkspaceData<{ aggregates: ReferralAggregates }>(analyst ? "/api/workspace/aggregates" : null, scope);
  const today = useToday();
  const loading = analyst ? summary.loading : records.loading;
  const error = analyst ? summary.error : records.error;
  const refresh = analyst ? summary.reload : records.reload;
  const referrals = records.data?.referrals ?? [];
  const counts = today && records.data ? dashboardCounts(referrals, today) : null;
  const groups = Object.keys(FLOW_LABELS).flatMap((flow) => {
    const count = referrals.filter((record) => record.flow === flow).length;
    return count ? [{ flow: flow as ReferralFlow, count }] : [];
  });
  const upcoming = today ? upcomingReferrals(referrals, today).slice(0, 3) : [];
  const attention = today ? attentionReferrals(referrals, today).slice(0, 3) : [];
  const delayed = referrals.filter((record) => isOperationallyDelayed(record, delayThreshold))
    .sort((a, b) => (b.observedStageDays ?? 0) - (a.observedStageDays ?? 0));
  const activity = referralActivity(referrals).slice(0, 3);
  const aggregate = summary.data ? aggregateView(summary.data.aggregates) : null;

  return <div className={s.stack}>
    <PageHeading eyebrow={analyst ? "Сводные показатели" : actor.role === "owner" ? "Обзор организации" : "Мой рабочий день"} title={analyst ? "Обзор направлений" : "Рабочий обзор"}
      description={analyst ? "Обезличенные показатели по подтверждениям врачей вашей организации." : actor.role === "owner" ? "Направления и подтверждения в пределах вашей организации." : "Ваши направления, назначенные даты и вопросы для проверки."}
      actions={<><button className={s.secondary} onClick={refresh} disabled={loading}><Icon name="refresh" size={16} />Обновить</button>{!analyst && <Link className={s.button} href="/workspace/referrals/new"><Icon name="plus" size={16} />Новое направление</Link>}</>} />
    {error && <p className={s.notice + " " + s.error} role="alert">{error}</p>}
    {loading && <p className={s.loading} role="status">Загружаем актуальные данные…</p>}
    {analyst ? <>
      {summary.data?.aggregates.suppressed ? <section className={s.card}><EmptyState title="Пока недостаточно данных" description="Показатели скрыты целиком, если группа или число известных времён слишком малы. Это защищает сведения о пациентах." /></section> : aggregate && <>
        <div className={s.kpis}><KpiCard label="Направлений" value={aggregate.total ?? "—"} hint="Записи, не уникальные пациенты" icon="referrals" /><KpiCard label="Представлено этапов" value={aggregate.groups.length} hint="Текущее распределение" icon="analytics" /><KpiCard label="Известно время этапа" value={aggregate.knownTimes ?? "—"} hint="Количество наблюдений" icon="clock" /><KpiCard label="Источник" value="Кабинет" hint="Подтверждения врачей" icon="data-quality" /></div>
        <section className={s.card}><div className={s.head}><h2>Распределение по этапам</h2><Link className={s.sectionLink} href="/workspace/analytics">Подробнее →</Link></div><StageBars groups={aggregate.groups} /><p className={s.muted}>Это текущие состояния записей, не конверсионная воронка и не фактическая очередь Портала.</p></section>
      </>}
      <section className={s.notice}>Персональные карточки, профили и ежедневная история недоступны этой роли. Прогноз ожидания не рассчитывается.</section>
    </> : !loading && records.data && <>
      <div className={s.kpis}><KpiCard label="Всего направлений" value={counts?.total ?? "—"} hint="В вашей области доступа" icon="referrals" /><KpiCard label="На этапе ожидания" value={counts?.waiting ?? "—"} hint="Подтверждено врачом" icon="clock" /><KpiCard label="Предстоящие даты" value={counts?.upcoming ?? "—"} hint="Без подтверждённой явки" icon="calendar" /><KpiCard label="Для проверки" value={counts?.attention ?? "—"} hint="Данные, а не оценка срочности" icon="warning" /></div>
      <div className={s.grid}>
        <div className={s.stack}>
        <section className={s.card}><div className={s.head}><h2>Направления по этапам</h2><Link className={s.sectionLink} href="/workspace/referrals">Все направления →</Link></div>{groups.length ? <StageBars groups={groups} /> : <EmptyState title="Начните с первого направления" description="Можно создать запись вручную или связать её с завершённым опросом." action={<Link className={s.button} href="/workspace/referrals/new">Создать направление</Link>} />}<p className={s.muted}>Текущие состояния по записям кабинета. Этапы не означают последовательную конверсию.</p></section>
        <section className={s.card}><div className={s.head}><h2>Обратить внимание на данные</h2><Icon name="warning" size={18} /></div>{attention.length ? <ul className={s.rows}>{attention.map((r) => <li key={r.id}><div className={s.row}><Link className={s.record} href={"/workspace/referrals/" + encodeURIComponent(r.id)}>{r.patientLabel}</Link><StatusBadge flow={r.flow} /></div><p className={s.muted}>{attentionReason(r, today!)}</p></li>)}</ul> : <EmptyState title="Вопросов для проверки нет" description="Это не клиническая оценка: здесь учитываются только комплектность и подтверждения." />}</section>
        <section className={s.card}><div className={s.head}><h2>Рабочие задержки</h2><span className={s.tag}>{delayed.length}</span></div>
          <label className={s.field}>Рабочий порог, дней<input type="number" min="0" step="0.1" value={delayThreshold} onChange={(event) => setDelayThreshold(event.target.value)} placeholder="Не задан" /></label>
          <p className={s.small}>Порог сохраняется в этом браузере. Он показывает задержку на этапе, а не медицинскую срочность.</p>
          {delayed.length ? <ul className={s.rows}>{delayed.slice(0, 3).map((record) => <li key={record.id} className={s.delayRow}><div className={s.row}><Link className={s.record} href={"/workspace/referrals/" + encodeURIComponent(record.id)}>{record.patientLabel}</Link><span className={s.delayTag}>{record.observedStageDays!.toFixed(1)} дн.</span></div><p className={s.muted}>{FLOW_LABELS[record.flow]} · Рабочий порог превышен</p></li>)}</ul>
            : <p className={s.muted}>{delayThreshold === "" ? "Задайте порог, чтобы видеть задержки." : "Направлений выше выбранного порога нет."}</p>}
          {delayed.length > 3 && <Link className={s.sectionLink} href="/workspace/referrals">Показать все в списке →</Link>}
        </section>
        </div><div className={s.stack}>
        <section className={s.card}><div className={s.head}><h2>Назначенные даты</h2><Link className={s.sectionLink} href="/workspace/calendar">Календарь →</Link></div>{upcoming.length ? <ul className={s.rows}>{upcoming.map((r) => <li key={r.id}><div className={s.row}><Link className={s.record} href={"/workspace/referrals/" + encodeURIComponent(r.id)}>{r.patientLabel}</Link><span className={s.tag}>{calendarDate(r.scheduledDate)}</span></div><p className={s.muted}>{r.profile} · {r.destinationOrganization || "Организация не указана"}</p></li>)}</ul> : <EmptyState title="Предстоящих дат нет" description="Здесь появятся даты, которые подтвердит врач." />}</section>
        <section className={s.card}><div className={s.head}><h2>Последние подтверждения</h2><Link className={s.sectionLink} href="/workspace/activity">Вся история →</Link></div>{activity.length ? <ul className={s.rows}>{activity.map(({ referralId, patientLabel, event }) => <li key={event.id}><Link className={s.record} href={"/workspace/referrals/" + encodeURIComponent(referralId)}>{patientLabel}</Link><p className={s.muted}>{EVENT_LABELS[event.type]} · {event.actorName}</p><span className={s.small}>Записано {timestamp(event.recordedAt)}</span></li>)}</ul> : <EmptyState title="История ещё не началась" description="Создание и каждое подтверждение сохраняются вместе с автором." />}</section>
        </div>
      </div>
      <div className={s.notice}>Неизвестные данные не считаются подтверждёнными. Дата сама по себе не означает явку. Данные Портала госпитализации не подключены.</div>
    </>}
  </div>;
}
