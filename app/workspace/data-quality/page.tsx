"use client";

import type { ReferralAggregates, ReferralDetail } from "@/lib/referrals/types";
import { FLOW_LABELS } from "../client";
import { useWorkspaceContext } from "../shell";
import { EmptyState, Icon, KpiCard, PageHeading } from "../ui";
import { aggregateCoverage, insightEndpoint, referralQuality } from "../insights";
import { useInsightData } from "../insights-client";
import styles from "../insights.module.css";

export default function DataQualityPage() {
  const { actor } = useWorkspaceContext();
  const analyst = actor.role === "analyst";
  const { data, loading, error, refresh } = useInsightData<{ referrals?: ReferralDetail[]; aggregates?: ReferralAggregates }>(insightEndpoint(actor.role, "quality"));
  const quality = !analyst && data?.referrals ? referralQuality(data.referrals) : null;
  const aggregates = analyst ? data?.aggregates : undefined;
  const coverage = aggregates ? aggregateCoverage(aggregates) : null;
  const scope = actor.role === "doctor" ? "Ваши направления" : "Направления вашей организации";
  const rows = quality ? [
    { label: "Лист ожидания", count: quality.queueUnknown, note: "Не подтверждено, находится ли пациент в листе ожидания." },
    { label: "Назначенная дата", count: quality.dateUnknown, note: "Дата госпитализации не указана. Она может быть ещё не назначена." },
    { label: "Явка", count: quality.attendanceUnknown, note: "Явка или неявка не подтверждена врачом. Прошедшая дата не заменяет подтверждение." },
    { label: "Комплектность пакета", count: quality.completenessUnknown, note: "Не хватает сведений либо проверенного перечня обследований для оценки." },
    { label: "Время на текущем этапе", count: quality.timeUnknown, note: "По истории записей нельзя надёжно определить начало текущего этапа." },
  ] : [];

  return <div className={styles.stack}>
    <PageHeading eyebrow="Аналитика и данные" title="Качество данных" description="Что известно из записей, а что ещё предстоит подтвердить." actions={<button className={styles.button} disabled={loading} onClick={refresh}><Icon name="refresh" size={16} />Обновить</button>} />
    <div className={styles.notice}><Icon name="info" size={19} /><div><strong>{scope}</strong>Неизвестное значение — не ошибка врача и не признак медицинского риска. Полнота сведений зависит от этапа направления.</div></div>
    {loading && <p className={styles.loading} role="status">Проверяем доступные сведения…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {data && <>
      <div className={styles.kpis}>
        <KpiCard label="Записей в области доступа" value={quality?.total ?? coverage?.total ?? "—"} hint={analyst ? "Из безопасного агрегированного среза" : "Основа подсчётов на этой странице"} icon="referrals" />
        <KpiCard label={analyst ? "Известно время на этапе" : "Без подтверждения явки"} value={quality ? `${quality.attendanceUnknown} из ${quality.total}` : coverage ? `${coverage.knownTime} из ${coverage.total}` : "—"} hint={analyst ? "Число наблюдений для расчёта среднего" : "Неизвестность не означает неявку"} icon="clock" />
        <KpiCard label={analyst ? "Время на этапе неизвестно" : "Без проверенного перечня"} value={quality ? `${quality.catalogueUnavailable} из ${quality.total}` : coverage ? `${coverage.unknownTime} из ${coverage.total}` : "—"} hint={analyst ? "Такие записи не входят в среднее время" : "Комплектность не может быть подтверждена"} icon="data-quality" />
      </div>
      <section className={styles.card}>
        <div className={styles.sectionHead}><div><h2>{analyst ? "Покрытие сводных показателей" : "Сведения, которые остаются неизвестными"}</h2><p className={styles.muted}>{analyst ? "Только разрешённые агрегаты, без загрузки карточек пациентов" : "Каждый показатель считается отдельно; строки могут относиться к одним и тем же направлениям"}</p></div></div>
        {analyst ? aggregates?.groups.length ? <>
          {aggregates.suppressed && <div className={styles.notice}><Icon name="lock" size={19} /><div><strong>Показаны только разрешённые группы</strong>Малые группы, восстановимый общий итог и отдельные показатели времени скрыты по тому же правилу, что на странице аналитики.</div></div>}
          <div className={styles.tablewrap}><table className={styles.table}><caption>Доступное покрытие сводных показателей по этапам.</caption><thead><tr><th scope="col">Этап</th><th scope="col">Записей</th><th scope="col">Известно время</th><th scope="col">Как читать показатель</th></tr></thead><tbody>{aggregates.groups.map((group) => <tr key={group.flow}><th scope="row">{FLOW_LABELS[group.flow]}</th><td className={styles.number}>{group.count}</td><td className={styles.number}>{group.observedTimeCount === null ? "Скрыто" : `${group.observedTimeCount} из ${group.count}`}</td><td className={styles.muted}>Время относится к истории записей текущего этапа в кабинете.</td></tr>)}</tbody></table></div>
        </> : <EmptyState title="Пока нет групп для показа" description="В каждом этапе недостаточно записей для безопасного отображения. Это не нулевой результат." /> : quality?.total === 0 ? <EmptyState title="Пока нечего проверять" description="После создания направлений здесь появятся показатели полноты сведений." /> : quality && <div className={styles.tablewrap}><table className={styles.table}><caption>Неизвестные сведения: число направлений из {quality.total} доступных записей.</caption><thead><tr><th scope="col">Сведение</th><th scope="col">Неизвестно</th><th scope="col">Как читать показатель</th></tr></thead><tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td className={styles.number}>{row.count} из {quality.total}</td><td className={styles.muted}>{row.note}</td></tr>)}</tbody></table></div>}
      </section>
    </>}
    <div className={styles.columns}>
      <section className={styles.card}><h2>Источники и доступность</h2><p className={styles.muted}>Только то, что можно установить из текущего интерфейса.</p><dl className={styles.sourceList}>
        <div><dt>Подтверждения врача</dt><dd>Источник фактов о направлении — записи в Demeu. Изменения сохраняют автора и историю подтверждений.</dd></div>
        <div><dt>Справочник обследований</dt><dd>{quality ? `Для ${quality.catalogueUnavailable} из ${quality.total} направлений проверенный перечень недоступен.` : analyst ? "Доступность проверяется отдельно для каждого направления. Роли аналитика эти сведения по карточкам не предоставляются." : "Доступность проверенного перечня оценивается отдельно для каждого направления после загрузки данных."} Пустой или непроверенный перечень не означает полный пакет.</dd></div>
        <div><dt>Портал госпитализации</dt><dd>В этом потоке очередь, дату и явку подтверждает врач вручную. Автоматическое подтверждение из Портала не используется.</dd></div>
      </dl></section>
      <section className={styles.card}><h2>Границы этих показателей</h2><dl className={styles.sourceList}>
        <div><dt>Не медицинская оценка</dt><dd>Полнота записей не оценивает состояние пациента, качество лечения или работу врача.</dd></div>
        <div><dt>Не мониторинг интеграций</dt><dd>Состояние Telegram и внешних подключений этот API не сообщает. Здесь нельзя подтвердить их доступность или доставку конкретного сообщения.</dd></div>
        <div><dt>Прогнозы</dt><dd>Недоступны до проверки исходных данных и качества отдельных моделей.</dd></div>
      </dl></section>
    </div>
  </div>;
}
