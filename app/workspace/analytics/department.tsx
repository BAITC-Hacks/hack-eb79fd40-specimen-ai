"use client";

import { useMemo, useState } from "react";
import type { Case1Analytics, Case1Hospital, Case1Signal } from "@/lib/case1-analytics";
import { EmptyState, Icon, KpiCard, PageHeading } from "../ui";
import { useInsightData } from "../insights-client";
import { selectHospitals, sortRegions, type HospitalSort, type RegionSort, type SignalFilter } from "./view-model";
import styles from "./analytics.module.css";

const PAGE_SIZE = 25;
const number = new Intl.NumberFormat("ru-RU");
const SIGNAL_LABELS: Record<Case1Signal, string> = {
  refusal_above_expected: "Отказы выше ожидаемого",
  long_wait_above_expected: "Долгое ожидание выше ожидаемого",
};

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "Не рассчитано" : number.format(value);
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "Не рассчитано" : `${number.format(value)} %`;
}

function days(value: number | null | undefined): string {
  return value === null || value === undefined || value < 0 ? "Не рассчитано" : `${number.format(value)} дн.`;
}

function ratio(value: number | null | undefined): string {
  return value === null || value === undefined ? "Не рассчитано" : number.format(value);
}

function signalText(signals: readonly Case1Signal[]): string {
  return signals.length ? signals.map((signal) => SIGNAL_LABELS[signal]).join("; ") : "Сигналов нет";
}

function HospitalDetails({ hospital }: { hospital: Case1Hospital }) {
  const longWait = hospital.long_wait_vs_expected;
  const flowEstimate = hospital.march_forecast.from_pending + hospital.march_forecast.from_new;
  return <div className={styles.detailsGrid}>
    <div><h4>Отказы: факт и ожидаемое</h4><p>{count(hospital.refusal_vs_expected.observed)} / {number.format(hospital.refusal_vs_expected.expected)}</p><p className={styles.muted}>Отношение: {ratio(hospital.refusal_vs_expected.ratio)} · 95 % интервал: {hospital.refusal_vs_expected.ci95 ? hospital.refusal_vs_expected.ci95.map(number.format).join("–") : "не рассчитан"}</p></div>
    <div><h4>Долгое ожидание: факт и ожидаемое</h4><p>{longWait ? `${count(longWait.observed)} / ${number.format(longWait.expected)}` : "Не рассчитано"}</p><p className={styles.muted}>Отношение: {ratio(longWait?.ratio)} · 95 % интервал: {longWait?.ci95 ? longWait.ci95.map(number.format).join("–") : "не рассчитан"}</p></div>
    <div><h4>Прогноз на март</h4><dl className={styles.compactFacts}>
      <div><dt>Итоговый усреднённый прогноз</dt><dd>{count(hospital.march_forecast.forecast)}</dd></div>
      <div><dt>Факт</dt><dd>{count(hospital.march_forecast.actual)}</dd></div>
      <div><dt>Модель потока: из очереди</dt><dd>{count(hospital.march_forecast.from_pending)}</dd></div>
      <div><dt>Модель потока: новые направления</dt><dd>{count(hospital.march_forecast.from_new)}</dd></div>
      <div><dt>Оценка модели потока, сумма</dt><dd>{count(flowEstimate)}</dd></div>
    </dl></div>
    <div><h4>Ведущие профили</h4>{hospital.top_profiles.length ? <ul className={styles.cleanList}>{hospital.top_profiles.map((item) => <li key={item.profile}><span>{item.profile}</span><strong>{count(item.referrals)}</strong></li>)}</ul> : <p>Нет опубликованного разреза</p>}</div>
  </div>;
}

export function DepartmentAnalytics() {
  const { data, loading, error, refresh } = useInsightData<Case1Analytics>("/api/analytics/case1");
  const [query, setQuery] = useState("");
  const [regionCode, setRegionCode] = useState("");
  const [signal, setSignal] = useState<SignalFilter>("all");
  const [hospitalSort, setHospitalSort] = useState<HospitalSort>("excess");
  const [regionSort, setRegionSort] = useState<RegionSort>("refusal");
  const [page, setPage] = useState(1);
  const hospitals = useMemo(() => data ? selectHospitals(data.hospitals, { query, regionCode, signal, sort: hospitalSort }) : [], [data, hospitalSort, query, regionCode, signal]);
  const regions = useMemo(() => data ? sortRegions(data.regions, regionSort) : [], [data, regionSort]);
  const pageCount = Math.max(1, Math.ceil(hospitals.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleHospitals = hospitals.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const maximumLift = Math.max(1, ...data?.factors.map((factor) => factor.lift) ?? []);
  const updateFilter = (change: () => void) => { change(); setPage(1); };

  return <div className={styles.stack}>
    <PageHeading eyebrow="Аналитика и данные" title="Аналитика ведомства" description="Офлайн-срез открытых данных ИС «Бюро госпитализации»: регионы, организации, косвенные сигналы и ретроспективный прогноз." actions={<button className={styles.button} disabled={loading} onClick={refresh}><Icon name="refresh" size={16} />Обновить</button>} />
    {loading && <p className={styles.loading} role="status">Загружаем ведомственный срез…</p>}
    {error && <div className={styles.error} role="alert"><p>{error}</p><button className={styles.button} onClick={refresh}>Повторить</button></div>}
    {data && <>
      <section className={styles.provenance}>
        <Icon name="data-quality" size={21} />
        <div><strong>{data.source.publisher}: {data.source.dataset}</strong><p>{data.source.registration_period[0]} — {data.source.registration_period[1]} · исходы наблюдались до {data.source.outcomes_observed_until} · сформировано {new Date(data.generated_at).toLocaleString("ru-RU")}</p><span>Офлайн-срез, пересчитывается воспроизводимым скриптом</span></div>
      </section>

      <section aria-labelledby="national-heading">
        <div className={styles.sectionHead}><div><h2 id="national-heading">Страна: внешние направления на круглосуточную койку</h2><p>Направляющая организация отличается от принимающей. Показатели рассчитаны по опубликованным строкам.</p></div></div>
        <div className={styles.kpis}>
          <KpiCard label="Направления" value={count(data.national.external_24h.referrals)} hint="Внешние, круглосуточная койка" icon="referrals" />
          <KpiCard label="Отказы" value={percent(data.national.external_24h.refusal_pct)} hint={`${count(data.national.external_24h.hospitalized)} госпитализаций`} icon="activity" />
          <KpiCard label="Медиана ожидания" value={days(data.national.external_24h.wait_median_days)} hint="От регистрации до госпитализации" icon="clock" />
          <KpiCard label="90-й перцентиль" value={days(data.national.external_24h.wait_p90_days)} hint={`${percent(data.national.external_24h.wait_over_30_pct)} дольше 30 дней`} icon="analytics" />
        </div>
      </section>

      <section className={styles.card} aria-labelledby="regions-heading">
        <div className={styles.sectionHead}><div><h2 id="regions-heading">Регионы направляющих организаций</h2><p>Регион определён по коду КАТО направляющей организации. Это другой разрез, чем расположение принимающего стационара.</p></div><label className={styles.inlineControl}>Сортировка<select aria-label="Сортировка регионов" value={regionSort} onChange={(event) => setRegionSort(event.target.value as RegionSort)}><option value="refusal">По отказам</option><option value="long_wait">По ожиданию более 30 дней</option><option value="referrals">По направлениям</option><option value="name">По названию</option></select></label></div>
        <div className={styles.tablewrap}><table className={styles.table}><caption>Внешние направления на круглосуточную койку по региону направляющей организации</caption><thead><tr><th scope="col">Регион</th><th scope="col">Направления</th><th scope="col">Отказы</th><th scope="col">Медиана</th><th scope="col">Более 30 дней</th></tr></thead><tbody>{regions.map((region) => <tr key={region.code}><th scope="row">{region.name}</th><td>{count(region.external_24h.referrals)}</td><td>{percent(region.external_24h.refusal_pct)}</td><td>{days(region.external_24h.wait_median_days)}</td><td>{percent(region.external_24h.wait_over_30_pct)}</td></tr>)}</tbody></table></div>
      </section>

      <section className={styles.card} aria-labelledby="hospitals-heading">
        <div className={styles.sectionHead}><div><h2 id="hospitals-heading">Принимающие организации</h2><p>{data.definitions.hospital_region} Доли в строках — внешние направления на круглосуточную койку; сигнал отказов использует все сопоставимые направления, сигнал ожидания более 30 дней — сопоставимые госпитализации. Порог сигнала применяется до округления интервала, поэтому показанная нижняя граница может округлиться до 1,50. Сигналы косвенные и не доказывают причину отклонения.</p></div><span className={styles.tag}>{count(data.signals_summary.hospitals_checked)} проверено</span></div>
        <div className={styles.filters}>
          <label>Поиск организации<input type="search" value={query} onChange={(event) => updateFilter(() => setQuery(event.target.value))} /></label>
          <label>Регион<select aria-label="Регион" value={regionCode} onChange={(event) => updateFilter(() => setRegionCode(event.target.value))}><option value="">Все регионы</option>{data.regions.map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}</select></label>
          <label>Сигнал<select aria-label="Сигнал" value={signal} onChange={(event) => updateFilter(() => setSignal(event.target.value as SignalFilter))}><option value="all">Все</option><option value="any">Любой сигнал</option><option value="both">Оба сигнала</option><option value="refusal_above_expected">Отказы выше ожидаемого</option><option value="long_wait_above_expected">Долгое ожидание</option></select></label>
          <label>Сортировка<select aria-label="Сортировка организаций" value={hospitalSort} onChange={(event) => updateFilter(() => setHospitalSort(event.target.value as HospitalSort))}><option value="excess">По лишним отказам</option><option value="refusal">По доле отказов</option><option value="long_wait">По ожиданию более 30 дней</option><option value="referrals">По направлениям</option><option value="name">По названию</option></select></label>
        </div>
        <p className={styles.resultCount} aria-live="polite">Найдено организаций: {count(hospitals.length)}</p>
        {!visibleHospitals.length ? <EmptyState title="Организации не найдены" description="Измените поиск или фильтры." /> : <div className={styles.hospitalList}>{visibleHospitals.map((hospital) => <details className={styles.hospital} key={`${hospital.region_code}:${hospital.name}`}><summary><span><strong>{hospital.name}</strong><small>{hospital.region}</small></span><span className={styles.hospitalMetrics}><span>{percent(hospital.external_24h?.refusal_pct)} отказов</span><span>{percent(hospital.external_24h?.wait_over_30_pct)} более 30 дней</span><span>{signalText(hospital.signals)}</span></span></summary><HospitalDetails hospital={hospital} /></details>)}</div>}
        {pageCount > 1 && <nav className={styles.pagination} aria-label="Страницы организаций"><button className={styles.button} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Назад</button><span>Страница {currentPage} из {pageCount}</span><button className={styles.button} disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Далее</button></nav>}
      </section>

      <section className={styles.card} aria-labelledby="forecast-heading">
        <div className={styles.sectionHead}><div><h2 id="forecast-heading">Ретроспективный прогноз поступлений за март 2025</h2><p>{data.forecast.target}</p></div><span className={styles.tag}>{data.forecast.horizon_days} дней</span></div>
        <div className={styles.forecastGrid}><div><div className={styles.tablewrap}><table className={styles.table}><caption>Сравнение вариантов по {count(data.forecast.hospitals)} организациям</caption><thead><tr><th scope="col">Вариант</th><th scope="col">WAPE</th><th scope="col">MAE</th></tr></thead><tbody>
          <tr><th scope="row">Итоговый усреднённый</th><td>{percent(data.forecast.model.wape_pct)}</td><td>{count(data.forecast.model.mae_admissions)}</td></tr>
          <tr><th scope="row">Модель потока</th><td>{percent(data.forecast.flow_only.wape_pct)}</td><td>{count(data.forecast.flow_only.mae_admissions)}</td></tr>
          <tr><th scope="row">Февраль по рабочим дням</th><td>{percent(data.forecast.naive.wape_pct)}</td><td>{count(data.forecast.naive.mae_admissions)}</td></tr>
          <tr><th scope="row">Февраль по календарным дням</th><td>{percent(data.forecast.naive_calendar.wape_pct)}</td><td>{count(data.forecast.naive_calendar.mae_admissions)}</td></tr>
        </tbody></table></div></div><div className={styles.forecastFacts}><h3>Итог по стране</h3><dl className={styles.compactFacts}><div><dt>Прогноз</dt><dd>{count(data.forecast.national.forecast)}</dd></div><div><dt>Факт</dt><dd>{count(data.forecast.national.actual)}</dd></div><div><dt>Рабочие дни: февраль / март</dt><dd>{data.forecast.working_days.february} / {data.forecast.working_days.march}</dd></div></dl></div></div>
        <div className={styles.warning}><Icon name="warning" size={19} /><div><strong>Ограничение оценки</strong><p>{data.forecast.selection_note} Итоговый вариант выбран после сравнения на марте; март не является независимым отложенным периодом.</p></div></div>
      </section>

      <section className={styles.card} aria-labelledby="factors-heading">
        <div className={styles.sectionHead}><div><h2 id="factors-heading">Факторы, связанные с долей отказов</h2><p>Lift — отношение доли в группе к средней по стране. Это описательная связь, а не причинный вывод.</p></div></div>
        <ul className={styles.factorList}>{data.factors.map((factor) => <li key={`${factor.factor}:${factor.value}`}><div className={styles.factorText}><strong>{factor.value}</strong><span>{factor.factor} · {count(factor.referrals)} направлений · {percent(factor.refusal_pct)}</span><span className={styles.factorTrack} aria-hidden="true"><i style={{ width: `${factor.lift / maximumLift * 100}%` }} /></span></div><span className={styles.lift}>{number.format(factor.lift)}×</span></li>)}</ul>
      </section>

      <section className={styles.card} aria-labelledby="limits-heading">
        <div className={styles.sectionHead}><div><h2 id="limits-heading">Ограничения и определения</h2><p>Читайте их вместе с показателями и сигналами.</p></div></div>
        <ul className={styles.limitations}>{data.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        <details className={styles.definitions}><summary>Показать определения расчётов</summary><dl>{Object.entries(data.definitions).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>
      </section>
    </>}
  </div>;
}
