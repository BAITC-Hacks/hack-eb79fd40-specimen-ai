"use client";

import { calendarDate, FLOW_LABELS } from "../client";
import { useWorkspaceContext } from "../shell";
import { EmptyState, Icon, KpiCard, PageHeading } from "../ui";
import { aggregateCoverage, barWidth, DEMO_ORGANIZATION_COMPARISON, insightEndpoint, MODEL_EVIDENCE, timelinePoints, type InsightAggregate } from "../insights";
import { useInsightData } from "../insights-client";
import styles from "../insights.module.css";

export default function AnalyticsPage() {
  const { actor } = useWorkspaceContext();
  const { data, loading, error, refresh } = useInsightData<{ aggregates: InsightAggregate }>(insightEndpoint(actor.role, "analytics"));
  const aggregates = data?.aggregates;
  const coverage = aggregates ? aggregateCoverage(aggregates) : null;
  const personal = actor.role !== "analyst";
  const scope = actor.role === "doctor" ? "Только ваши направления" : "В пределах вашей организации";
  const maximum = Math.max(0, ...aggregates?.groups.map((group) => group.count) ?? []);
  const profiles = personal ? aggregates?.perProfile ?? [] : [];
  const timeline = personal ? aggregates?.timeline ?? [] : [];
  const profileMaximum = Math.max(0, ...profiles.map((group) => group.count));
  const partial = aggregates?.suppressed ?? false;
  const hiddenGroups = aggregates?.total === null;

  return <div className={styles.stack}>
    <PageHeading eyebrow="Аналитика и данные" title="Аналитика направлений" description="Движение направлений по записям врачей. Без предположений о внешней очереди." actions={<button className={styles.button} disabled={loading} onClick={refresh}><Icon name="refresh" size={16} />Обновить</button>} />
    <div className={styles.notice}><Icon name="building" size={19} /><div><strong>{scope}</strong>Источник: подтверждения в кабинете Demeu. Это не статистика Портала госпитализации.</div></div>
    {loading && <p className={styles.loading} role="status">Загружаем сводные показатели…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {aggregates && <>
      <div className={styles.kpis}>
        <KpiCard label="Направлений в кабинете" value={aggregates.total ?? "—"} hint={hiddenGroups ? "Общее число скрыто для защиты малых групп" : scope} icon="referrals" />
        <KpiCard label="Показано этапов" value={hiddenGroups && !aggregates.groups.length ? "—" : aggregates.groups.length} hint={hiddenGroups ? "Только этапы с достаточным числом записей" : "Текущее состояние направлений"} icon="analytics" />
        <KpiCard label="Известно время на этапе" value={coverage ? `${coverage.knownTime} из ${coverage.total}` : "—"} hint={hiddenGroups ? "Итог скрыт для защиты малых групп" : "По времени записи этапа в кабинете"} icon="clock" />
      </div>
      {partial && <div className={styles.notice}><Icon name="lock" size={19} /><div><strong>Часть данных скрыта</strong>{hiddenGroups ? "Малые группы и некоторые показатели времени не показаны. Общий итог скрыт, чтобы нельзя было восстановить число в малой группе." : "Некоторые показатели времени скрыты из-за малого числа наблюдений."}</div></div>}
      {hiddenGroups && !aggregates.groups.length ? <section className={styles.card}><EmptyState title="Пока нет групп для показа" description="В каждом наблюдаемом этапе недостаточно записей для безопасного отображения. Это не нулевой результат." /></section> : <>
        <div className={styles.columns}>
          <section className={styles.card}>
            <div className={styles.sectionHead}><div><h2>Текущее распределение</h2><p className={styles.muted}>Количество направлений на каждом наблюдаемом этапе</p></div><span className={styles.tag}>По записям врачей</span></div>
            {!aggregates.groups.length ? <EmptyState title="Пока нет направлений" description="Показатели появятся после создания записей в вашей области доступа." /> : <>
              <ul className={styles.bars}>{aggregates.groups.map((group) => <li key={group.flow}><div className={styles.barLabel}><span>{FLOW_LABELS[group.flow]}</span><strong>{group.count}</strong></div><div className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: barWidth(group.count, maximum) }} /></div></li>)}</ul>
              <div className={styles.tablewrap}><table className={styles.table}><caption>Время — дни с момента записи текущего этапа, не фактическое ожидание госпитализации.</caption><thead><tr><th scope="col">Этап</th><th scope="col">Записей</th><th scope="col">Среднее, дни</th><th scope="col">Известно время</th></tr></thead><tbody>{aggregates.groups.map((group) => <tr key={group.flow}><th scope="row">{FLOW_LABELS[group.flow]}</th><td className={styles.number}>{group.count}</td><td className={styles.number}>{group.observedTimeCount === null ? "Скрыто" : group.meanObservedDays === null ? "Неизвестно" : group.meanObservedDays.toFixed(1)}</td><td className={styles.number}>{group.observedTimeCount === null ? "Скрыто" : `${group.observedTimeCount} из ${group.count}`}</td></tr>)}</tbody></table></div>
            </>}
          </section>
          <section className={styles.card}>
            {personal ? <><div className={styles.sectionHead}><div><h2>По профилям</h2><p className={styles.muted}>Профили, указанные при создании направлений</p></div></div>{profiles.length ? <ul className={styles.bars}>{profiles.map((group) => <li key={group.profile}><div className={styles.barLabel}><span>{group.profile}</span><strong>{group.count}</strong></div><div className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: barWidth(group.count, profileMaximum) }} /></div></li>)}</ul> : <EmptyState title="Профилей пока нет" description="Распределение появится вместе с направлениями." />}</> : <><Icon name="lock" size={24} /><h2>Только обезличенные агрегаты</h2><p className={styles.muted}>Роли аналитика доступны только группы, прошедшие порог публикации. Поля профилей и дневной динамики в ответе API недоступны этой роли и возвращаются пустыми; карточки пациентов не загружаются.</p></>}
          </section>
        </div>
        {personal && <section className={styles.card}>
          <div className={styles.sectionHead}><div><h2>Динамика локальных записей</h2><p className={styles.muted}>{calendarDate(aggregates.period.from)} — {calendarDate(aggregates.period.to)} · 30 календарных дней</p></div><span className={styles.tag}><Icon name="calendar" size={14} />История наблюдений</span></div>
          {timeline.length ? <>
            <svg className={styles.chart} viewBox="0 0 720 204" role="img" aria-label="Всего локальных записей и записей на этапе ожидания по дням. Точные значения в таблице ниже.">
              {[28, 101, 174].map((y) => <line key={y} x1="32" x2="688" y1={y} y2={y} />)}
              <text x="32" y="17">{Math.max(0, ...timeline.map((row) => row.totalCount))}</text><text x="16" y="179">0</text>
              <polyline points={timelinePoints(timeline, "totalCount")} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
              <polyline points={timelinePoints(timeline, "waitingCount")} fill="none" stroke="#8a77ba" strokeWidth="2.5" strokeDasharray="6 5" strokeLinejoin="round" />
              <text x="32" y="200">{calendarDate(aggregates.period.from)}</text><text x="688" y="200" textAnchor="end">{calendarDate(aggregates.period.to)}</text>
            </svg>
            <div className={styles.legend}><span><i />Всего записей</span><span><i className={styles.dashed} />На этапе ожидания</span></div>
            <p className={styles.muted}>Состояние на конец дня по времени записи в кабинете; сегодня — на момент запроса. Не отражает фактическую очередь внешней системы.</p>
            <details className={styles.disclosure}><summary>Точные значения по дням</summary><div className={styles.tablewrap}><table className={styles.table}><caption>История локальных записей</caption><thead><tr><th scope="col">Дата</th><th scope="col">Создано</th><th scope="col">Всего</th><th scope="col">На этапе ожидания</th></tr></thead><tbody>{timeline.map((row) => <tr key={row.date}><th scope="row">{calendarDate(row.date)}</th><td>{row.createdCount}</td><td>{row.totalCount}</td><td>{row.waitingCount}</td></tr>)}</tbody></table></div></details>
          </> : <EmptyState title="История пока недоступна" description="Данные для ежедневной динамики ещё не получены." />}
        </section>}
      </>}
    </>}
    <section className={`${styles.card} ${styles.demoCard}`} data-data-origin="synthetic-demo">
      <div className={styles.sectionHead}><div><h2>Демонстрационное сравнение двух организаций</h2><p className={styles.muted}>Fallback для показа макета, пока в кабинете нет проверенного среза по двум реальным организациям.</p></div><span className={styles.demoTag}>Синтетический пример</span></div>
      <div className={styles.notice}><Icon name="info" size={19} /><div><strong>{DEMO_ORGANIZATION_COMPARISON.label}</strong>Значения ниже не получены из live API, не входят в показатели выше и не используются в рабочем процессе.</div></div>
      <div className={styles.demoOrganizations}>{DEMO_ORGANIZATION_COMPARISON.organizations.map((organization) => {
        const maximum = Math.max(...organization.profiles.map((profile) => profile.count));
        return <article key={organization.id}><h3>{organization.name}</h3><ul className={styles.bars}>{organization.profiles.map((profile) => <li key={profile.profile}><div className={styles.barLabel}><span>{profile.profile}</span><strong>{profile.count}</strong></div><div className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: barWidth(profile.count, maximum) }} /></div></li>)}</ul></article>;
      })}</div>
      <div className={styles.tablewrap}><table className={styles.table}><caption>{DEMO_ORGANIZATION_COMPARISON.period}. Недельная динамика новых направлений в синтетическом примере.</caption><thead><tr><th scope="col">Неделя</th>{DEMO_ORGANIZATION_COMPARISON.organizations.map((organization) => <th scope="col" key={organization.id}>{organization.name}</th>)}</tr></thead><tbody>{DEMO_ORGANIZATION_COMPARISON.timeline.map((row) => <tr key={row.period}><th scope="row">{row.period}</th>{DEMO_ORGANIZATION_COMPARISON.organizations.map((organization) => <td className={styles.number} key={organization.id}>{row.values[organization.id]}</td>)}</tr>)}</tbody></table></div>
    </section>
    <section className={styles.card}>
      <div className={styles.sectionHead}><div><h2>Исследовательские оценки и ограничения</h2><p className={styles.muted}>Справочные результаты офлайн-проверки. Они не запускаются для пациентов, не влияют на маршрут и не являются рабочими прогнозами.</p></div><span className={styles.tag}>Не операционные</span></div>
      <div className={styles.modelGrid}>{MODEL_EVIDENCE.map((model) => <article className={styles.modelCard} key={model.id}>
        <div className={styles.modelHead}><span>{model.id}</span><strong>{model.statusLabel}</strong></div>
        <h3>{model.title}</h3>
        <dl className={styles.modelFacts}>
          <div><dt>Статус</dt><dd>{model.statusLabel}</dd></div>
          <div><dt>Ошибка на отложенном периоде</dt><dd>{model.heldOutMetric}</dd></div>
          <div><dt>Baseline</dt><dd>{model.baseline}</dd></div>
          <div><dt>Период оценки</dt><dd>{model.evaluationPeriod}</dd></div>
        </dl>
        <p className={styles.muted}>{model.note}</p>
      </article>)}</div>
      <p className={styles.muted}>Рабочее сравнение организаций не показано: текущий кабинет не содержит проверенного многоорганизационного среза. Отдельный демо-блок выше не заменяет такие данные.</p>
    </section>
  </div>;
}
