"use client";

import Link from "next/link";
import { Fragment, useRef, useState } from "react";
import { buildPatientLink } from "@/lib/doctor-ui";
import { timestamp, workspaceRequest } from "../client";
import { useWorkspaceData, type Intake } from "../data";
import { useWorkspaceContext } from "../shell";
import { EmptyState, Icon, PageHeading } from "../ui";
import s from "../dashboard.module.css";
import { IntakeSummary } from "./summary";

const STATUS = { collecting: "В процессе", completed: "Завершён", aborted: "Прерван" };
const DELIVERY = { pending: "Ожидает подтверждения", sent: "Отправлено врачу", failed: "Ошибка доставки" };

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
    <PageHeading eyebrow={actor.role === "owner" ? "Опросы организации" : "Мои опросы"} title="Опросы пациентов" description="Первичный сбор жалоб и анамнеза. Сводка помогает врачу подготовить направление." actions={actor.role === "doctor" ? <button className={s.button} onClick={() => void generate()} disabled={busy}><Icon name="plus" size={16} />{busy ? "Создаём…" : "Создать ссылку на опрос"}</button> : undefined} />
    {actor.role === "owner" && <p className={s.notice}>Ссылку на опрос создаёт врач из своего кабинета. Так у пациентского пакета есть назначенный врач, который проверяет результаты.</p>}
    {linkError && <p className={s.notice + " " + s.error} role="alert">{linkError}</p>}
    {patientLink && <section className={s.card}><div className={s.head}><h2>Ссылка для пациента готова</h2><button className={s.secondary} onClick={() => void copy()}>Скопировать</button></div><input className={s.linkField} ref={linkInput} value={patientLink} readOnly aria-label="Ссылка на опрос пациента" onFocus={(event) => event.currentTarget.select()} /><p className={s.small}>Сохраните и передайте пациенту. Опрос привязан к вашей учётной записи. Ссылка не хранится в истории этой страницы.</p>{copyMessage && <p className={s.small} role="status">{copyMessage}</p>}</section>}
    <section className={s.card}><div className={s.toolbar}><label className={s.field}>Поиск по жалобе<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Текст из завершённой сводки" /></label><label className={s.field}>Состояние опроса<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Все состояния</option>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className={s.secondary} onClick={resource.reload} disabled={resource.loading}><Icon name="refresh" size={16} />Обновить</button>{(query || status) && <button className={s.secondary} onClick={() => { setQuery(""); setStatus(""); }}>Сбросить</button>}</div><p className={s.small}>Опросы доступны в пределах срока хранения. Сохранённое направление существует отдельно и не удаляется вместе с опросом.</p></section>
    {resource.error && <p role="alert" className={s.notice + " " + s.error}>{resource.error}</p>}
    {resource.loading ? <p role="status" className={s.loading}>Загружаем опросы…</p> : resource.data && <section className={s.card}>{filtered.length ? <div className={s.tableScroll}><table className={s.table}><thead><tr><th>Создан / жалоба</th><th>Состояние</th><th>Доставка сводки</th><th>Действие</th></tr></thead><tbody>{filtered.map((intake) => <Fragment key={intake.sessionId}><tr><td><strong>{timestamp(intake.createdAt)}</strong><p className={s.muted}>{intake.result?.anamnesis.chief_complaint || "Итоговая сводка ещё не сформирована"}</p>{intake.result && <button className={s.secondary} aria-expanded={expanded === intake.sessionId} onClick={() => setExpanded(expanded === intake.sessionId ? null : intake.sessionId)}>{expanded === intake.sessionId ? "Свернуть сводку" : "Открыть сводку"}</button>}</td><td><span className={s.tag}>{STATUS[intake.status]}</span></td><td><span className={s.tag + (intake.deliveryStatus === "failed" ? " " + s.warning : "")}>{DELIVERY[intake.deliveryStatus]}</span></td><td>{intake.referralId ? <Link className={s.secondary} href={"/workspace/referrals/" + encodeURIComponent(intake.referralId)}>Открыть направление</Link> : intake.status === "completed" && intake.result ? <Link className={s.secondary} href={"/workspace/referrals/new?sourceSessionId=" + encodeURIComponent(intake.sessionId)}>Подготовить направление</Link> : <span className={s.small}>Доступно после завершения</span>}</td></tr>{expanded === intake.sessionId && intake.result && <tr><td colSpan={4}><IntakeSummary result={intake.result} /></td></tr>}</Fragment>)}</tbody></table></div> : <EmptyState title={all.length ? "Опросы не найдены" : "Опросов пока нет"} description={all.length ? "Измените поиск или состояние опроса." : "Создайте персональную ссылку и передайте её пациенту."} />}</section>}
  </div>;
}
