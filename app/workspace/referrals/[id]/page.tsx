"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ExaminationRecord, PatientMemo, ReferralDetail, ReferralFacts } from "@/lib/referrals/types";
import { profileDisplayName, REFERRAL_PROFILES } from "@/lib/referrals/profiles";
import {
  ABSTAIN_HYPOTHESIS,
  DETERMINISTIC_HYPOTHESIS,
  processingModeNotice,
} from "@/lib/clinical-copy";
import { calendarDate, COMPLETENESS_LABELS, EXAM_LABELS, observedDaysLabel, timestamp, WorkspaceError, useWorkspaceCommand, workspaceRequest } from "../../client";
import { useWorkspaceContext } from "../../shell";
import { isOperationallyDelayed, useOperationalDelay } from "../../operational-delay";
import { EmptyState, Icon, PageHeading, StatusBadge } from "../../ui";
import styles from "./detail.module.css";

const TABS = [["overview", "Обзор"], ["facts", "Подтверждения"], ["exams", "Обследования"], ["history", "История"], ["memo", "Памятка"]] as const;
type Tab = typeof TABS[number][0];
type NotifyStatus = { state: "pending" | "success" | "error"; message: string };
const URGENCY_LABELS = { emergency: "Неотложно", urgent: "Срочно", planned: "Планово", routine: "Рутинно" };
const SOURCE_LABELS = { rules_only: "Только правила безопасности; без модельной оценки", llm_fallback: "Резервный аналитический путь LLM", model: "Модель и правила безопасности" };

function boolInput(value: boolean | null) { return value === null ? "unknown" : value ? "yes" : "no"; }
function parseBool(value: FormDataEntryValue | null) { return value === "yes" ? true : value === "no" ? false : null; }
function BoolField({ name, label, value }: { name: string; label: string; value: boolean | null }) {
  return <label className={styles.field}>{label}<select name={name} defaultValue={boolInput(value)}><option value="unknown">Неизвестно</option><option value="yes">Да, подтверждено</option><option value="no">Нет, подтверждено</option></select></label>;
}
const FACT_LABELS: Record<string, string> = { profile: "Профиль", icd10Code: "Код МКБ-10", destinationOrganization: "Организация", specialistReferred: "К узкому специалисту", preparationStarted: "Подготовка начата", sent: "Направление отправлено", queue: "Лист ожидания", scheduledDate: "Назначенная дата", attendance: "Явка", cancelled: "Отменено", label: "Обследование", performedOn: "Дата проведения", expiresOn: "Срок действия", applicability: "Применимость", resultAvailable: "Результат получен" };
function eventValue(value: unknown) { return value === null ? "неизвестно" : value === true ? "да" : value === false ? "нет" : value === "attended" ? "явился" : value === "not_attended" ? "не явился" : value === "unknown" ? "неизвестно" : value === "yes" ? "да" : value === "no" ? "нет" : String(value); }
function eventFieldValue(key: string, value: unknown) {
  return key === "profile" && typeof value === "string" ? profileDisplayName(value) : eventValue(value);
}

export default function ReferralCard() {
  const { id } = useParams<{ id: string }>();
  // A route change unmounts every form and pending UI response from the old record.
  return <ReferralRecord key={id} id={id} />;
}

function ReferralRecord({ id }: { id: string }) {
  const { actor } = useWorkspaceContext();
  const [referral, setReferral] = useState<ReferralDetail | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [conflict, setConflict] = useState(false);
  const [retainedIntent, setRetainedIntent] = useState<string[]>([]);
  const generation = useRef(0);
  const activeOperation = useRef(false);
  const [error, setError] = useState("");
  const [dateError, setDateError] = useState("");
  const [message, setMessage] = useState("");
  const [notifyStatus, setNotifyStatus] = useState<NotifyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [memo, setMemo] = useState<PatientMemo | null>(null);
  const [editingExam, setEditingExam] = useState<ExaminationRecord | null>(null);
  const [delayThreshold, setDelayThreshold] = useOperationalDelay(actor.organizationId, actor.id);
  useEffect(() => {
    if (!editingExam || tab !== "exams") return;
    const form = document.getElementById("examination-form");
    form?.querySelector<HTMLInputElement>('input[name="label"]')?.focus({ preventScroll: true });
    form?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  }, [editingExam, tab]);
  const command = useWorkspaceCommand();
  const base = `/api/referrals/${encodeURIComponent(id)}`;
  const ready = loadedId === id && referral?.id === id && !loading;
  const disabled = !ready || busy || conflict;

  useEffect(() => {
    if (!actor || actor.role === "analyst") return;
    const requestGeneration = ++generation.current;
    let active = true;
    setLoading(true); setLoadedId(null); setError(""); setMemo(null); setMessage(""); setNotifyStatus(null); setEditingExam(null);
    workspaceRequest<{ referral: ReferralDetail }>(base).then((value) => {
      if (!active || requestGeneration !== generation.current) return;
      if (value.referral.id !== id) throw new Error("Не удалось проверить карточку. Обновите страницу.");
      setReferral(value.referral); setLoadedId(id); setConflict(false);
    })
      .catch((reason: Error) => { if (active) { setError(reason.message); setReferral(null); setLoadedId(null); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; generation.current = requestGeneration + 1; };
  }, [actor, base, id, version]);

  function beginOperation() {
    if (disabled || activeOperation.current) return null;
    activeOperation.current = true; setBusy(true); setError(""); setMessage(""); setNotifyStatus(null);
    return generation.current;
  }
  function finishOperation(requestGeneration: number) {
    if (requestGeneration !== generation.current) return;
    activeOperation.current = false; setBusy(false);
  }
  function failOperation(reason: unknown, intent: string[] = []) {
    setError(reason instanceof Error ? reason.message : "Не удалось выполнить действие.");
    if (reason instanceof WorkspaceError && reason.status === 409) {
      setConflict(true); setRetainedIntent(intent);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>, kind: "facts" | "examination") {
    event.preventDefault(); if (!ready || disabled || !referral) return;
    const data = new FormData(event.currentTarget);
    const occurred = String(data.get("occurredAt") || "");
    const common = {
      expectedRevision: referral.revision,
      reason: String(data.get("reason") || "").trim() || null,
      occurredAt: occurred ? Date.parse(`${occurred}:00+05:00`) : null,
    };
    const patch = {
      profile: String(data.get("profile")).trim(),
      icd10Code: String(data.get("icd10Code") || "").trim() || null,
      destinationOrganization: String(data.get("destinationOrganization")).trim() || null,
      specialistReferred: parseBool(data.get("specialistReferred")),
      preparationStarted: data.get("preparationStarted") === "yes",
      sent: parseBool(data.get("sent")), queue: parseBool(data.get("queue")),
      scheduledDate: String(data.get("scheduledDate") || "") || null,
      attendance: data.get("attendance") === "unknown" ? null : data.get("attendance"),
      cancelled: data.get("cancelled") === "yes",
    };
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => referral[key as keyof ReferralFacts] !== value));
    if (kind === "facts" && !Object.keys(changed).length) { setMessage("Изменений нет. Текущие факты уже сохранены."); return; }
    const body = kind === "facts" ? { ...common, patch: changed } : { ...common, record: {
      ...(editingExam ? { id: editingExam.id } : {}),
      requirementId: String(data.get("requirementId")).trim(),
      label: String(data.get("label")).trim(),
      performedOn: String(data.get("performedOn") || "") || null,
      expiresOn: String(data.get("expiresOn") || "") || null,
      applicability: data.get("applicability"),
      resultAvailable: parseBool(data.get("resultAvailable")),
    }};
    if (kind === "examination" && "record" in body && body.record.performedOn && body.record.expiresOn && body.record.expiresOn < body.record.performedOn) {
      setError("");
      setDateError("«Действует до» должно быть не раньше даты проведения.");
      event.currentTarget.querySelector<HTMLInputElement>('input[name="expiresOn"]')?.focus();
      return;
    }
    setDateError("");
    const requestGeneration = beginOperation(); if (requestGeneration === null) return;
    const intent = Object.entries("record" in body ? body.record : changed).filter(([key]) => key in FACT_LABELS).map(([key, value]) => `${FACT_LABELS[key]}: ${eventFieldValue(key, value)}`);
    if (common.reason) intent.push(`Основание: ${common.reason}`);
    if (common.occurredAt !== null) intent.push(`Время события: ${timestamp(common.occurredAt)}`);
    try {
      const result = await command<{ referral: ReferralDetail }>(`${base}/${kind === "facts" ? "events" : "examinations"}`, body);
      if (requestGeneration !== generation.current) return;
      if (result.referral.id !== id) throw new Error("Не удалось проверить ответ. Обновите карточку перед повтором.");
      setReferral(result.referral); setMemo(null); setEditingExam(null); setRetainedIntent([]); setMessage("Подтверждение сохранено в истории.");
    } catch (reason) { if (requestGeneration === generation.current) failOperation(reason, intent); }
    finally { finishOperation(requestGeneration); }
  }

  async function getMemo() {
    const requestGeneration = beginOperation(); if (requestGeneration === null) return;
    try { const result = await workspaceRequest<{ memo: PatientMemo }>(`${base}/patient-memo`); if (requestGeneration === generation.current) setMemo(result.memo); }
    catch (reason) { if (requestGeneration === generation.current) failOperation(reason); }
    finally { finishOperation(requestGeneration); }
  }

  async function notify() {
    if (!ready || !referral) return;
    const requestGeneration = beginOperation(); if (requestGeneration === null) return;
    setNotifyStatus({ state: "pending", message: "Отправляем памятку врачу…" });
    try { await command(`${base}/notify`, { expectedRevision: referral.revision }); if (requestGeneration === generation.current) setNotifyStatus({ state: "success", message: "Памятка отправлена в Telegram врача." }); }
    catch (reason) {
      if (requestGeneration === generation.current) {
        if (reason instanceof WorkspaceError && reason.code === "REVISION_CONFLICT") { setConflict(true); setError(reason.message); }
        setNotifyStatus({ state: "error", message: reason instanceof Error ? reason.message : "Не удалось подтвердить доставку памятки." });
      }
    }
    finally { finishOperation(requestGeneration); }
  }

  const facts = referral;
  return <div className={styles.wrap}>
    <Link className={styles.back} href="/workspace/referrals"><span aria-hidden="true">←</span> Все направления</Link>
    {error && <div className={`${styles.notice} ${styles.error}`} role="alert">{error}<button className="btn subtle" disabled={busy || loading} onClick={() => setVersion((value) => value + 1)}>Обновить карточку</button></div>}
    {message && <p className={styles.notice} role="status">{message}</p>}
    {retainedIntent.length > 0 && <section className={styles.notice}><strong>Ваше неподтверждённое изменение</strong><p>Сохранено здесь для сверки. После обновления проверьте новые данные и заполните форму заново. Изменение не применяется автоматически.</p><ul>{retainedIntent.map((line, index) => <li key={index}>{line}</li>)}</ul></section>}
    {loading && <div className={styles.loading} role="status"><Icon name="refresh" /> Загружаем карточку направления…</div>}
    {!loading && !ready && !error && <EmptyState title="Карточка недоступна" description="Вернитесь к списку направлений или обновите страницу." />}
    {actor?.role === "analyst" && <p className={styles.notice}>Аналитику доступны только сводные показатели. <Link href="/workspace">Перейти к сводке</Link></p>}
    {actor && actor.role !== "analyst" && ready && referral && facts && <>
      <PageHeading eyebrow="Карточка направления" title={referral.patientLabel} description={`${profileDisplayName(referral.profile)}${referral.icd10Code ? ` · МКБ-10 ${referral.icd10Code}` : ""} · ${referral.destinationOrganization || "Организация не указана"}`} actions={<StatusBadge flow={referral.flow} />} />
      <p className={styles.metadata}>Обновлено {timestamp(referral.updatedAt)} · Версия {referral.revision}</p>
      {referral.triageSnapshot?.urgency === "emergency" && <div className={styles.emergency} role="alert"><Icon name="warning" /><div><strong>Неотложный приоритет по результатам опроса</strong><p>В сохранённой сводке отмечены признаки, требующие внимания врача. Организационный этап направления не заменяет оценку срочности.</p></div></div>}
      <dl className={styles.factStrip}><div><dt>Лист ожидания</dt><dd>{eventValue(referral.queue)}</dd></div><div><dt>Назначенная дата</dt><dd>{calendarDate(referral.scheduledDate)}</dd></div><div><dt>Явка</dt><dd>{eventValue(referral.attendance)}</dd></div><div><dt>Пакет обследований</dt><dd>{COMPLETENESS_LABELS[referral.completeness.status]}</dd></div></dl>
      <div className={styles.tabs} role="tablist" aria-label="Разделы направления">{TABS.map(([key, label], index) => <button key={key} id={`tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={(event) => { const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null; if (next !== null) { event.preventDefault(); setTab(TABS[next][0]); document.getElementById(`tab-${TABS[next][0]}`)?.focus(); } }}>{label}{key === "history" && <span>{referral.events.length}</span>}</button>)}</div>
      <div className={styles.panel} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      <div className={tab === "overview" || tab === "exams" ? styles.grid : styles.single}><div className={styles.stack}>
        {tab === "overview" && <>
        {referral.triageSnapshot && <section className={styles.card}>
          <div className={styles.cardHeading}><h2>Сводка первичного опроса</h2><span className={styles.urgency} data-urgency={referral.triageSnapshot.urgency}>{URGENCY_LABELS[referral.triageSnapshot.urgency]}</span></div>
          <p>{referral.triageSnapshot.anamnesis.chief_complaint || "Жалоба не указана"}</p>
          <h3>Основания срочности</h3>{referral.triageSnapshot.urgency_reasons.length > 0 ? <ul className={styles.reasons}>{referral.triageSnapshot.urgency_reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p className={styles.small}>В сохранённой сводке основания не указаны.</p>}
          <h3>Предлагаемая маршрутизация</h3><p>{referral.triageSnapshot.routing.length > 0 ? referral.triageSnapshot.routing.map((route) => route.specialty).join(" · ") : "Специальность не определена — требуется решение врача."}</p>
          <h3>{referral.triageSnapshot.processing_mode === "deterministic" ? "Гипотеза не формировалась" : referral.triageSnapshot.hypothesis.text === ABSTAIN_HYPOTHESIS ? "Гипотеза не сформирована" : "Предварительная гипотеза"}</h3><p>{referral.triageSnapshot.processing_mode === "deterministic" ? DETERMINISTIC_HYPOTHESIS : referral.triageSnapshot.hypothesis.text}</p><p className={styles.notice}>{referral.triageSnapshot.hypothesis.disclaimer}</p>
          {referral.triageSnapshot.red_flags.length > 0 && <><h3>Отмеченные признаки</h3><ul className={styles.list}>{referral.triageSnapshot.red_flags.map((flag) => <li key={flag.code} className={flag.emergency ? styles.emergencyFlag : undefined}><strong>{flag.emergency && <Icon name="warning" size={15} />} {flag.label}</strong><p>{flag.evidence_kind === "quote" ? `«${flag.evidence}»` : flag.evidence}</p></li>)}</ul></>}
          <div className={styles.source}><strong>Источник: {referral.triageSnapshot.processing_mode === "deterministic" ? "Детерминированный опросник и правила безопасности" : referral.triageSnapshot.hypothesis.text === ABSTAIN_HYPOTHESIS ? "Модель воздержалась; гипотеза не сформирована" : SOURCE_LABELS[referral.triageSnapshot.source]}</strong><p className={styles.small}>{processingModeNotice(referral.triageSnapshot.processing_mode)}</p><p className={styles.small}>Сокращённая сводка не содержит полного аудита модели; числовые оценки здесь не показаны. Сводка сохранена из завершённого опроса. Подтверждение направления — отдельное решение врача.</p></div>
        </section>}
        {!referral.triageSnapshot && <section className={styles.card}><EmptyState title="Сводка опроса не прикреплена" description="Направление ведётся по подтверждённым врачом фактам. Отсутствие сводки не подтверждает отсутствие жалоб." /></section>}
        <section className={styles.card}><div className={styles.cardHeading}><h2>Подтверждённые факты</h2><button className="btn subtle" onClick={() => setTab("facts")}>Уточнить <Icon name="arrow" size={16} /></button></div><dl className={styles.factList}>{["specialistReferred", "preparationStarted", "sent", "queue", "cancelled"].map((key) => <div key={key}><dt>{FACT_LABELS[key]}</dt><dd>{eventValue(referral[key as keyof ReferralFacts] ?? null)}</dd></div>)}</dl><p className={styles.small}>Очередь, назначенная дата и явка подтверждаются независимо друг от друга.</p></section>
        </>}
        {tab === "facts" && <section className={styles.card}><h2>Подтвердить факты</h2><p className={styles.small}>Указывайте только известные факты. Назначенная дата сама по себе не подтверждает явку.</p>
          <form className={styles.form} key={`facts-${referral.revision}`} onSubmit={(event) => void save(event, "facts")}>
            <fieldset disabled={disabled}>
            <div className={styles.fields}><label className={styles.field}>Профиль госпитализации<select name="profile" defaultValue={referral.profile} required>{!REFERRAL_PROFILES.some((profile) => profile === referral.profile) && <option value={referral.profile}>{profileDisplayName(referral.profile)}</option>}{REFERRAL_PROFILES.map((profile) => <option key={profile} value={profile}>{profile}</option>)}</select><span className={styles.small}>Перечень профилей ожидает проверки врачом больницы.</span></label><label className={styles.field}>Код МКБ-10<input name="icd10Code" defaultValue={referral.icd10Code || ""} maxLength={8} pattern="[A-Za-z][0-9]{2}(\.[0-9A-Za-z]{1,4})?" placeholder="Например, I20.9" /><span className={styles.small}>Для аналитики; перечень обследований выбирается по профилю.</span></label></div>
            <label className={styles.field}>Принимающая организация<input name="destinationOrganization" defaultValue={referral.destinationOrganization || ""} maxLength={160} /></label>
            <div className={styles.fields}><BoolField name="specialistReferred" label="Направлен к узкому специалисту" value={facts.specialistReferred ?? null} /><label className={styles.field}>Подготовка пакета<select name="preparationStarted" defaultValue={facts.preparationStarted ? "yes" : "no"}><option value="no">Не начата</option><option value="yes">Начата врачом</option></select></label><BoolField name="sent" label="Направление отправлено" value={referral.sent} /><BoolField name="queue" label="В листе ожидания" value={referral.queue} /></div>
            <div className={styles.fields}><label className={styles.field}>Назначенная дата<input name="scheduledDate" type="date" defaultValue={referral.scheduledDate || ""} /></label><label className={styles.field}>Явка<select name="attendance" defaultValue={referral.attendance ?? "unknown"}><option value="unknown">Неизвестно</option><option value="attended">Явился — подтверждено</option><option value="not_attended">Не явился — подтверждено</option></select></label></div>
            <label className={styles.field}>Отмена направления<select name="cancelled" defaultValue={referral.cancelled ? "yes" : "no"}><option value="no">Не отменено</option><option value="yes">Отмена подтверждена</option></select></label>
            <label className={styles.field}>Когда произошло событие, время Алматы<input name="occurredAt" type="datetime-local" /><span className={styles.small}>Можно оставить пустым: время события останется неизвестным.</span></label>
            <label className={styles.field}>Основание или причина исправления<textarea name="reason" maxLength={500} placeholder="Что подтвердили или почему исправляете прежнюю запись" /></label>
            <button className="btn" disabled={disabled}>{busy ? "Сохраняем…" : "Подтвердить изменения"}</button>
            </fieldset>
          </form>
        </section>}
        {tab === "history" && <section className={styles.card}><h2>История подтверждений</h2><p className={styles.small}>Неизменяемый журнал. Исправление добавляет новую запись, а не удаляет предыдущую. Время указано по Алматы.</p><ol className={styles.timeline}>{[...referral.events].reverse().map((event) => {
          const previous = event.before as Partial<ReferralFacts> | null;
          return <li key={event.id}><p><strong>{event.actorName}</strong> · {event.type === "created" ? "Создал направление" : event.type === "facts_changed" ? "Подтвердил факты" : "Записал обследование"}</p><p className={styles.small}>Записано: {timestamp(event.recordedAt)} · Событие: {timestamp(event.occurredAt)}</p>{Object.entries(event.after).filter(([key, value]) => key in FACT_LABELS && (!previous || (previous as Record<string, unknown>)[key] !== value)).map(([key, value]) => <p className={styles.small} key={key}>{FACT_LABELS[key]}: {previous && key in previous ? `${eventFieldValue(key, (previous as Record<string, unknown>)[key])} → ` : ""}{eventFieldValue(key, value)}</p>)}{event.reason && <p>{event.reason}</p>}</li>;
        })}</ol></section>}
        {tab === "exams" && <section className={styles.card}><h2>Комплектность пакета</h2><span className={styles.badge}>{COMPLETENESS_LABELS[referral.completeness.status]}</span><p className={styles.small}>На {calendarDate(referral.completeness.evaluatedOn)} · {referral.completeness.basis === "scheduled_date" ? "к назначенной дате" : "на сегодня"}</p>
          {!referral.completeness.catalogueAvailable && <p className={styles.notice}>{referral.completeness.catalogueStatus === "available" && !referral.completeness.catalogueValidated ? `Перечень ${referral.completeness.catalogueVersion} получен, но ещё не проверен врачом больницы.` : "Проверенный перечень для этого профиля недоступен."} Комплектность не подтверждена.</p>}
          <ul className={styles.list}>{referral.completeness.entries.map((entry) => <li key={entry.requirementId}><strong>{entry.label}</strong><p>{EXAM_LABELS[entry.status]}{entry.expiresOn ? ` · до ${calendarDate(entry.expiresOn)}` : ""}</p></li>)}</ul>
          <h3>Записанные обследования</h3>{!referral.examinations.length && <p className={styles.small}>Пока не добавлены.</p>}<ul className={styles.list}>{referral.examinations.map((exam) => <li key={exam.id}><strong>{exam.label}</strong><p className={styles.small}>Проведено: {calendarDate(exam.performedOn)} · Действует до: {calendarDate(exam.expiresOn)}</p><p className={styles.small}>Наличие результата: {eventValue(exam.resultAvailable)}</p><button className="btn subtle" disabled={disabled} onClick={() => { setDateError(""); setEditingExam({ ...exam }); }}>Исправить</button></li>)}</ul>
        </section>}
        {tab === "memo" && <section className={styles.card}><div className={styles.cardHeading}><h2>Памятка пациенту</h2><Icon name="referrals" /></div><p className={styles.small}>Проверьте список перед передачей пациенту. Передача — через врача. Если доставка не подтверждена, проверьте Telegram: автоматически повторять отправку нельзя.</p><div className={styles.row}><button className="btn ghost" disabled={disabled} onClick={() => void getMemo()}>Посмотреть памятку</button>{disabled ? <button className="btn subtle" disabled><Icon name="download" size={16} /> Скачать PDF</button> : <a className="btn subtle" href={`${base}/patient-memo?format=pdf`} target="_blank" rel="noreferrer"><Icon name="download" size={16} /> Скачать PDF</a>}<button className="btn subtle" disabled={disabled} onClick={() => void notify()}>{notifyStatus?.state === "pending" ? "Отправляем…" : "Отправить врачу в Telegram"}</button></div>
          {notifyStatus && <p className={`${styles.notifyStatus} ${notifyStatus.state === "error" ? styles.notifyError : ""}`} role={notifyStatus.state === "error" ? "alert" : "status"}>{notifyStatus.message}</p>}
          {memo ? <div className={styles.memo}><p className={styles.eyebrow}>Памятка для передачи пациенту</p><h3>{memo.patientLabel}</h3><p>{memo.destinationOrganization || "Организацию нужно уточнить"}</p><p>Назначенная дата: {calendarDate(memo.scheduledDate)}</p>{!memo.catalogueAvailable && <p className={styles.notice}>Состав обязательных обследований нужно уточнить у врача.</p>}<ul className={styles.list}>{memo.items.map((item, index) => <li key={index}>{item.label}: {EXAM_LABELS[item.status]}{item.expiresOn ? `, до ${calendarDate(item.expiresOn)}` : ""}</li>)}</ul></div> : <EmptyState title="Предпросмотр памятки" description="Нажмите «Посмотреть памятку», чтобы проверить актуальный состав перед передачей." />}
        </section>}
      </div>{(tab === "overview" || tab === "exams") && <aside className={styles.stack}>
          {tab === "overview" && <><section className={`${styles.card} ${isOperationallyDelayed(referral, delayThreshold) ? styles.delay : ""}`}><div className={styles.cardHeading}><h2>Время на этапе</h2><Icon name="clock" /></div><p className={styles.stageTime}>{referral.observedStageDays === null ? "Неизвестно" : `${referral.observedStageDays.toFixed(1)} дн.`}</p><p className={styles.small}>{observedDaysLabel(referral.observedStageDays)}</p><label className={styles.field}>Рабочий порог, дней<input type="number" min="0" step="0.1" value={delayThreshold} onChange={(event) => setDelayThreshold(event.target.value)} placeholder="Не задан" /></label><p className={styles.small}>Порог сохраняется в этом браузере и применяется в списке и обзоре. Это не нормативный срок и не оценка срочности.</p>{isOperationallyDelayed(referral, delayThreshold) && <p className={styles.delayLabel}>Превышен выбранный рабочий порог</p>}</section><section className={styles.card}><h2>Пакет обследований</h2><span className={styles.badge}>{COMPLETENESS_LABELS[referral.completeness.status]}</span><p className={styles.small}>{referral.completeness.catalogueAvailable ? "Проверка по подтверждённому перечню." : referral.completeness.catalogueStatus === "available" && !referral.completeness.catalogueValidated ? `Перечень ${referral.completeness.catalogueVersion} ожидает проверки врачом больницы. Комплектность не подтверждена.` : "Проверенный перечень недоступен. Комплектность не подтверждена."}</p><button className="btn subtle" onClick={() => setTab("exams")}>Перейти к обследованиям <Icon name="arrow" size={16} /></button></section></>}
        {tab === "exams" && <section className={styles.card} id="examination-form"><h2>{editingExam ? "Исправить обследование" : "Добавить обследование"}</h2>{editingExam && <button className="btn subtle" disabled={disabled} onClick={() => { setDateError(""); setEditingExam(null); }}>Отменить исправление</button>}<form className={styles.form} key={`exam-${referral.revision}-${editingExam?.id ?? "new"}`} onSubmit={(event) => void save(event, "examination")}>
          <fieldset disabled={disabled}><label className={styles.field}>Название<input name="label" defaultValue={editingExam?.label ?? ""} required maxLength={160} /></label>
          <label className={styles.field}>{referral.completeness.entries.length ? "Код исследования из перечня" : "Внутренний идентификатор обследования"}<input name="requirementId" defaultValue={editingExam?.requirementId ?? ""} required maxLength={100} list="requirements" /><datalist id="requirements">{referral.completeness.entries.map((entry) => <option key={entry.requirementId} value={entry.requirementId}>{entry.label}</option>)}</datalist><span className={styles.small}>{referral.completeness.catalogueAvailable ? "Выберите код из проверенного перечня." : referral.completeness.entries.length ? "Можно выбрать код из полученного перечня, но он ещё не проверен врачом больницы." : "Задайте свой постоянный идентификатор для учёта, например exam-1."} Запись без проверенного перечня не подтверждает комплектность.</span></label>
          <label className={styles.field}>Дата проведения<input name="performedOn" defaultValue={editingExam?.performedOn ?? ""} type="date" onChange={() => setDateError("")} /></label><label className={styles.field}>Действует до<input name="expiresOn" defaultValue={editingExam?.expiresOn ?? ""} type="date" aria-invalid={Boolean(dateError)} aria-describedby={dateError ? "expires-on-error" : undefined} onChange={() => setDateError("")} />{dateError && <span id="expires-on-error" className={styles.fieldError} role="alert">{dateError}</span>}</label><BoolField name="resultAvailable" label="Результат получен" value={editingExam?.resultAvailable ?? null} />
          <label className={styles.field}>Применимость<select name="applicability" defaultValue={editingExam?.applicability ?? "unknown"}><option value="unknown">Неизвестно</option><option value="yes">Применимо</option><option value="no">Не применимо — подтверждено врачом</option></select></label>
          <label className={styles.field}>Основание{editingExam ? " исправления (обязательно)" : ""}<textarea name="reason" required={Boolean(editingExam)} maxLength={500} /></label><button className="btn ghost" disabled={disabled}>Подтвердить обследование</button></fieldset>
        </form></section>}
      </aside>}</div></div>
    </>}
  </div>;
}
