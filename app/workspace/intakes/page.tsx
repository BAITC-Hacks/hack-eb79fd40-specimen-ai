"use client";

import Link from "next/link";
import { Fragment, useRef, useState } from "react";
import type { TriageResult } from "@/lib/types";
import { buildPatientLink } from "@/lib/doctor-ui";
import { timestamp, workspaceRequest } from "../client";
import { intakePresentation, useWorkspaceData, type Intake } from "../data";
import { useWorkspaceContext } from "../shell";
import { EmptyState, Icon, PageHeading } from "../ui";
import s from "../dashboard.module.css";

const STATUS = { collecting: "В процессе", completed: "Завершён", aborted: "Прерван" };
const DELIVERY = { pending: "Ожидает подтверждения", sent: "Отправлено врачу", failed: "Ошибка доставки" };
const URGENCY = { emergency: "Неотложно", urgent: "Срочно", planned: "Планово", routine: "Рутинно" };
function Summary({ result }: { result: TriageResult }) {
  const a = result.anamnesis;
  const model = result.model;
  const presentation = intakePresentation(result);
  return <div className={s.details}>
    <div className={s.row}><h3>Сводка для врача</h3><span className={s.tag + (result.urgency === "emergency" ? " " + s.warning : "")}>{URGENCY[result.urgency]}</span></div>
    <p className={s.small}>Источник: {result.source === "rules_only" ? "только правила; аналитический модуль был недоступен" : result.source === "model" ? "обученная модель" : model?.abstained ? "модель воздержалась; гипотеза языковой модели" : "языковая модель"}</p>
    <h3>Жалоба и описание</h3><p>{a.chief_complaint || "Жалоба не указана"}</p>
    <dl><dt>Начало</dt><dd>{a.symptom.onset || "Не указано"}</dd><dt>Локализация / характер</dt><dd>{[a.symptom.location, a.symptom.quality].filter(Boolean).join(" · ") || "Не указаны"}</dd><dt>Выраженность</dt><dd>{presentation.severityLabel}</dd><dt>Что влияет на симптом</dt><dd>{a.symptom.modifiers || "Не указано"}</dd><dt>Сопутствующее</dt><dd>{a.symptom.associated.join(", ") || "Не указано"}</dd></dl>
    <h3>Красные флаги</h3>{result.red_flags.length ? <ul>{result.red_flags.map((flag, index) => <li key={flag.code + index}><strong>{flag.label}</strong> — {flag.evidence_kind === "quote" ? "«" + flag.evidence + "»" : flag.evidence}{flag.elicited_by && <p className={s.small}>В ответ на вопрос: {flag.elicited_by}</p>}</li>)}</ul> : <p>В сводке нет выявленных красных флагов. Это не исключает риски и не заменяет оценку врача.</p>}
    <h3>Основания приоритета</h3><ul>{result.urgency_reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    <h3>Маршрутизация</h3>{presentation.routing.length ? <ul>{presentation.routing.map((route) => <li key={route.specialty}>{route.specialty}{route.confidenceLabel ? " · " + route.confidenceLabel : ""}</li>)}</ul> : <p>Не определена</p>}{presentation.routingHint && <p className={s.small}>{presentation.routingHint}</p>}
    <h3>Предварительная гипотеза</h3><p>{result.hypothesis.text}</p><p className={s.notice}>{result.hypothesis.disclaimer}</p>
    <h3>Анамнез и контекст</h3><dl>{[["Перенесённое", a.past_history], ["Хронические состояния", a.chronic], ["Аллергии", a.allergies], ["Лекарства", a.medications], ["Факторы риска", a.context.risk_factors]].map(([label, values]) => <div key={String(label)}><dt>{label}</dt><dd>{(values as string[]).join(", ") || "Не указано"}</dd></div>)}</dl>
    <p>Возраст: {a.context.age ?? "не указан"} · Пол: {{ m: "мужской", f: "женский", unknown: "не указан" }[a.context.sex]} · Беременность: {{ yes: "указана", no: "отрицается", na: "не применимо" }[a.context.pregnancy]}</p>
    {model && <><h3>Модель</h3><p className={s.small}>Версия: {model.model_version}{model.abstained ? " · воздержалась: " + (model.abstain_reason === "low_confidence" ? "недостаточная уверенность" : "вне области обучения") : ""}</p>{!model.abstained && <><ul>{model.pathologies.slice(0, 3).map((item) => <li key={item.code}>{item.label_ru} · {Math.round(item.prob * 100)}%{item.icd10 ? " · " + item.icd10 : ""}</li>)}</ul><h3>Вклад признаков</h3><ul>{model.top_contributions.map((item) => <li key={item.feature}>{item.label_ru}: {item.contribution >= 0 ? "+" : ""}{item.contribution.toFixed(3)}</li>)}</ul></>}</>}
  </div>;
}

export default function IntakesPage() {
  const { actor } = useWorkspaceContext();
  const allowed = actor.role !== "analyst";
  const resource = useWorkspaceData<{ intakes: Intake[] }>(allowed ? "/api/workspace/intakes" : null, actor.id + actor.role + actor.organizationId);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [patientLink, setPatientLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  if (!allowed) return <EmptyState title="Опросы доступны врачу" description="Аналитику не передаются персональные сводки опросов." />;
  const all = resource.data?.intakes ?? [];
  const filtered = all.filter((intake) => (!status || intake.status === status) && (!query.trim() || (intake.result?.anamnesis.chief_complaint ?? "").toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru"))));
  async function generate() {
    setBusy(true); setLinkError(""); setPatientLink(""); setCopyMessage("");
    try { const { token } = await workspaceRequest<{ token: string }>("/api/link", {}); setPatientLink(buildPatientLink(window.location.origin, token)); }
    catch (reason) { setLinkError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(patientLink); setCopyMessage("Ссылка скопирована"); }
    catch { linkInput.current?.focus(); linkInput.current?.select(); setCopyMessage("Скопируйте выделенную ссылку вручную"); }
  }
  return <div className={s.stack}>
    <PageHeading eyebrow={actor.role === "owner" ? "Опросы организации" : "Мои опросы"} title="Опросы пациентов" description="Первичный сбор жалоб и анамнеза. Сводка помогает врачу подготовить направление." actions={<button className={s.button} onClick={() => void generate()} disabled={busy}><Icon name="plus" size={16} />{busy ? "Создаём…" : "Создать ссылку на опрос"}</button>} />
    {linkError && <p className={s.notice + " " + s.error} role="alert">{linkError}</p>}
    {patientLink && <section className={s.card}><div className={s.head}><h2>Ссылка для пациента готова</h2><button className={s.secondary} onClick={() => void copy()}>Скопировать</button></div><input className={s.linkField} ref={linkInput} value={patientLink} readOnly aria-label="Ссылка на опрос пациента" onFocus={(event) => event.currentTarget.select()} /><p className={s.small}>Сохраните и передайте пациенту. Опрос привязан к вашей учётной записи. Ссылка не хранится в истории этой страницы.</p>{copyMessage && <p className={s.small} role="status">{copyMessage}</p>}</section>}
    <section className={s.card}><div className={s.toolbar}><label className={s.field}>Поиск по жалобе<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Текст из завершённой сводки" /></label><label className={s.field}>Состояние опроса<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Все состояния</option>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className={s.secondary} onClick={resource.reload} disabled={resource.loading}><Icon name="refresh" size={16} />Обновить</button>{(query || status) && <button className={s.secondary} onClick={() => { setQuery(""); setStatus(""); }}>Сбросить</button>}</div><p className={s.small}>Опросы доступны в пределах срока хранения. Сохранённое направление существует отдельно и не удаляется вместе с опросом.</p></section>
    {resource.error && <p role="alert" className={s.notice + " " + s.error}>{resource.error}</p>}
    {resource.loading ? <p role="status" className={s.loading}>Загружаем опросы…</p> : resource.data && <section className={s.card}>{filtered.length ? <div className={s.tableScroll}><table className={s.table}><thead><tr><th>Создан / жалоба</th><th>Состояние</th><th>Доставка сводки</th><th>Действие</th></tr></thead><tbody>{filtered.map((intake) => <Fragment key={intake.sessionId}><tr><td><strong>{timestamp(intake.createdAt)}</strong><p className={s.muted}>{intake.result?.anamnesis.chief_complaint || "Итоговая сводка ещё не сформирована"}</p>{intake.result && <button className={s.secondary} aria-expanded={expanded === intake.sessionId} onClick={() => setExpanded(expanded === intake.sessionId ? null : intake.sessionId)}>{expanded === intake.sessionId ? "Свернуть сводку" : "Открыть сводку"}</button>}</td><td><span className={s.tag}>{STATUS[intake.status]}</span></td><td><span className={s.tag + (intake.deliveryStatus === "failed" ? " " + s.warning : "")}>{DELIVERY[intake.deliveryStatus]}</span></td><td>{intake.status === "completed" && intake.result ? <Link className={s.secondary} href={"/workspace/referrals/new?sourceSessionId=" + encodeURIComponent(intake.sessionId)}>Подготовить направление</Link> : <span className={s.small}>Доступно после завершения</span>}</td></tr>{expanded === intake.sessionId && intake.result && <tr><td colSpan={4}><Summary result={intake.result} /></td></tr>}</Fragment>)}</tbody></table></div> : <EmptyState title={all.length ? "Опросы не найдены" : "Опросов пока нет"} description={all.length ? "Измените поиск или состояние опроса." : "Создайте персональную ссылку и передайте её пациенту."} />}</section>}
  </div>;
}
