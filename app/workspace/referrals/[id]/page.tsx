"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DoctorAssessmentEventState, ExaminationRecord, PatientMemo, ReferralDetail, ReferralFacts, PatientReport, RegistrationFeatures } from "@/lib/referrals/types";
import { profileDisplayName, REFERRAL_PROFILES } from "@/lib/referrals/profiles";
import {
  ABSTAIN_HYPOTHESIS,
  DETERMINISTIC_HYPOTHESIS,
  processingModeNotice,
} from "@/lib/clinical-copy";
import { calendarDate, EXAM_LABELS, FLOW_LABELS, observedDaysLabel, timestamp, WorkspaceError, useWorkspaceCommand, workspaceRequest } from "../../client";
import { useWorkspaceContext } from "../../shell";
import { isOperationallyDelayed, useOperationalDelay } from "../../operational-delay";
import { EmptyState, Icon, PageHeading, StatusBadge } from "../../ui";
import styles from "./detail.module.css";

const TABS = [["overview", "Обзор"], ["facts", "Подтверждения"], ["exams", "Обследования"], ["risk", "Исследование B3"], ["history", "История"], ["memo", "Памятка"]] as const;
type Tab = typeof TABS[number][0];
type NotifyStatus = { state: "pending" | "success" | "error"; message: string };
const URGENCY_LABELS = { emergency: "Неотложно", urgent: "Срочно", planned: "Планово", routine: "Рутинно" };
const SOURCE_LABELS = { rules_only: "Только правила безопасности; без модельной оценки", llm_fallback: "Резервный аналитический путь LLM", model: "Модель и правила безопасности" };
const INTAKE_STATUS = { collecting: "Опрос продолжается", completed: "Опрос завершён", aborted: "Опрос прерван" };
const DELIVERY_STATUS = { pending: "Доставка ожидает подтверждения", sent: "Сводка отправлена врачу", failed: "Доставка не подтверждена" };
const CARE_CONTEXT_LABELS = { operative: "С вмешательством", conservative: "Без вмешательства", unknown: "Не уточнён" } as const;
const REGISTRATION_FIELDS: readonly [keyof RegistrationFeatures, string][] = [
  ["bed_profile", "Профиль койки"], ["icd10_ref_diag_code", "Код МКБ-10 направления"],
  ["referring_mo", "Направляющая медорганизация"], ["hospital_mo", "Принимающая медорганизация"],
  ["territorial_type", "Территориальный тип"], ["finance_source", "Источник финансирования"],
  ["referral_purpose", "Цель направления"],
];
const COVERAGE_LABELS: Record<string, string> = {
  frequent: "достаточно представлено в обучающей выборке",
  fallback_infrequent_or_unseen: "редкое или ранее не встречавшееся значение; применён резервный коэффициент",
  unknown_all_zero: "ранее не встречавшееся значение; вклад поля принят равным нулю",
  missing: "пропуск был предусмотрен при обучении",
};
type RiskView = { status: "unavailable"; reason: string; missingInputs: string[]; inputRevision: number | null; researchOnly: true }
  | { status: "available"; researchOnly: true; refusalProbabilityAmongMatureOutcomes: number; workingThreshold: number;
    riskBand: "below_working_threshold" | "at_or_above_working_threshold"; inputRevision: number; inputCoverage: Record<string, string>;
    warnings: string[]; limitations: string[]; modelVersion: string };

function boolInput(value: boolean | null) { return value === null ? "unknown" : value ? "yes" : "no"; }
function parseBool(value: FormDataEntryValue | null) { return value === "yes" ? true : value === "no" ? false : null; }
function BoolField({ name, label, value }: { name: string; label: string; value: boolean | null }) {
  return <label className={styles.field}>{label}<select name={name} defaultValue={boolInput(value)}><option value="unknown">Неизвестно</option><option value="yes">Да, подтверждено</option><option value="no">Нет, подтверждено</option></select></label>;
}
const FACT_LABELS: Record<string, string> = { profile: "Профиль", icd10Code: "Код МКБ-10", hypothesis: "Заключение врача", careContext: "Контекст лечения", destinationOrganization: "Организация", specialistReferred: "К узкому специалисту", preparationStarted: "Подготовка начата", sent: "Направление отправлено", queue: "Лист ожидания", scheduledDate: "Назначенная дата", attendance: "Явка", cancelled: "Отменено", label: "Обследование", performedOn: "Дата проведения", expiresOn: "Срок действия", applicability: "Применимость", resultAvailable: "Результат получен" };
function eventValue(value: unknown) { return value === null ? "неизвестно" : value === true ? "да" : value === false ? "нет" : value === "attended" ? "явился" : value === "not_attended" ? "не явился" : value === "unknown" ? "неизвестно" : value === "yes" ? "да" : value === "no" ? "нет" : String(value); }
function eventFieldValue(key: string, value: unknown) {
  if (key === "profile" && typeof value === "string") return profileDisplayName(value);
  if (key === "careContext" && typeof value === "string" && value in CARE_CONTEXT_LABELS) return CARE_CONTEXT_LABELS[value as keyof typeof CARE_CONTEXT_LABELS];
  return eventValue(value);
}
function packageState(referral: ReferralDetail) {
  if (referral.completeness.catalogueStatus === "available" && !referral.completeness.catalogueValidated) return "Справочник не проверен";
  return { complete: "Полный пакет", incomplete: "Не хватает результатов", expired: "Есть истёкшие результаты", unknown: "Комплектность не подтверждена" }[referral.completeness.status];
}
function requirementDefinition(referral: ReferralDetail, requirementId: string) {
  return referral.requirementSnapshot?.profiles
    .find((profile) => profile.profile === referral.profile)?.requirements
    .find((requirement) => requirement.id === requirementId);
}
function requirementPosition(referral: ReferralDetail, requirementId: string, required: boolean | null) {
  const definition = requirementDefinition(referral, requirementId);
  if (definition?.conditional) return "По показаниям";
  if (required === true) return "Обязательное";
  if (required === false) return "Необязательное";
  return "Вне перечня";
}
function freshnessLabel(referral: ReferralDetail, requirementId: string, expiresOn: string | null) {
  if (expiresOn) return `срок до ${calendarDate(expiresOn)}`;
  const days = requirementDefinition(referral, requirementId)?.validForDays;
  if (days !== undefined && days !== null) return `срок действия результата — ${days} дн.`;
  return days === null ? "календарный срок не задан" : "срок уточняется врачом";
}
function memoAction(status: PatientMemo["items"][number]["status"]) {
  return { present: "взять актуальный результат", missing: "получить и взять результат", expired: "обновить и взять результат", unknown: "уточнить у врача", not_applicable: "не требуется" }[status];
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
  const [preparationMeta, setPreparationMeta] = useState<{ accessRevision: number; active: boolean; expiresAt: number | null } | null>(null);
  const [preparationUrl, setPreparationUrl] = useState<string | null>(null);
  const [editingExam, setEditingExam] = useState<ExaminationRecord | null>(null);
  const [risk, setRisk] = useState<RiskView | null>(null);
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
    setPreparationMeta(null); setPreparationUrl(null); setLoading(true); setLoadedId(null); setError(""); setMemo(null); setRisk(null); setMessage(""); setNotifyStatus(null); setEditingExam(null);
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
    if (reason instanceof WorkspaceError && reason.code === "DOCTOR_ASSIGNMENT_REQUIRED") {
      setError("Личную ссылку можно выдать только направлению с назначенным врачом. Подготовьте направление из опроса врача.");
      return;
    }
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

  async function saveAssessment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || disabled || !referral || actor.role !== "doctor" || actor.id !== referral.doctorId) return;
    const data = new FormData(event.currentTarget);
    const reason = String(data.get("reason") || "").trim();
    const assessment = {
      hypothesis: String(data.get("hypothesis") || "").trim() || null,
      profile: String(data.get("profile") || "").trim(),
      icd10Code: String(data.get("icd10Code") || "").trim() || null,
      careContext: String(data.get("careContext") || "unknown"),
    };
    const requestGeneration = beginOperation(); if (requestGeneration === null) return;
    const intent = Object.entries(assessment).map(([key, value]) => `${FACT_LABELS[key]}: ${eventFieldValue(key, value)}`);
    intent.push(`Основание: ${reason}`);
    try {
      const result = await command<{ referral: ReferralDetail }>(`${base}/doctor-assessment`, {
        expectedRevision: referral.revision,
        expectedAssessmentRevision: referral.doctorAssessment?.revision ?? 0,
        reason,
        assessment,
      });
      if (requestGeneration !== generation.current) return;
      if (result.referral.id !== id) throw new Error("Не удалось проверить ответ. Обновите карточку перед повтором.");
      setReferral(result.referral); setMemo(null); setRetainedIntent([]); setMessage("Заключение врача сохранено в отдельной истории.");
    } catch (reasonCaught) { if (requestGeneration === generation.current) failOperation(reasonCaught, intent); }
    finally { finishOperation(requestGeneration); }
  }

  async function saveRegistrationSnapshot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || disabled || !referral || referral.registrationSnapshot || actor.role !== "doctor" || actor.id !== referral.doctorId) return;
    const data = new FormData(event.currentTarget);
    const features = Object.fromEntries(REGISTRATION_FIELDS.map(([name]) => {
      const value = String(data.get(name) ?? "");
      return [name, value === "" ? null : value];
    })) as unknown as RegistrationFeatures;
    const requestGeneration = beginOperation(); if (requestGeneration === null) return;
    try {
      const result = await command<{ referral: ReferralDetail }>(`${base}/registration-snapshot`, {
        expectedRevision: referral.revision, attestedAtRegistration: true, features,
      });
      if (requestGeneration !== generation.current) return;
      setReferral(result.referral); setRisk(null); setMessage("Снимок входных данных сохранён и больше не изменяется.");
    } catch (reason) { if (requestGeneration === generation.current) failOperation(reason); }
    finally { finishOperation(requestGeneration); }
  }

  async function loadRisk() {
    const requestGeneration = beginOperation(); if (requestGeneration === null) return;
    try {
      const result = await workspaceRequest<{ risk: RiskView }>(`${base}/risk`);
      if (requestGeneration === generation.current) setRisk(result.risk);
    } catch (reason) { if (requestGeneration === generation.current) failOperation(reason); }
    finally { finishOperation(requestGeneration); }
  }

  async function managePreparation(action: "reissue" | "revoke") {
    const requestGeneration = beginOperation(); if (requestGeneration === null) return;
    try {
      const meta = preparationMeta ?? await workspaceRequest<{ accessRevision: number; active: boolean; expiresAt: number | null }>(`${base}/patient-access`);
      if (requestGeneration !== generation.current) return;
      setPreparationMeta(meta);
      const result = await command<{ preparationUrl: string | null }>(`${base}/patient-access`, { action, expectedAccessRevision: meta.accessRevision });
      if (requestGeneration !== generation.current) return;
      setPreparationUrl(result.preparationUrl ? new URL(result.preparationUrl, window.location.origin).href : null);
      const nextMeta = await workspaceRequest<{ accessRevision: number; active: boolean; expiresAt: number | null }>(`${base}/patient-access`);
      if (requestGeneration !== generation.current) return;
      setPreparationMeta(nextMeta);
      setMessage(action === "revoke" ? "Доступ пациента отозван. Прежние ссылки больше не работают." : "Новая ссылка создана на 30 дней. Прежние ссылки отозваны; передайте новую пациенту.");
    } catch (reason) { if (requestGeneration === generation.current) failOperation(reason); }
    finally { finishOperation(requestGeneration); }
  }
  async function confirmReport(report: PatientReport) {
    if (!referral) return;
    const requestGeneration = beginOperation(); if (requestGeneration === null) return;
    try {
      const result = await command<{ referral: ReferralDetail }>(`${base}/patient-reports/confirm`, { reportId: report.id, expectedRevision: referral.revision, expectedReportRevision: report.revision });
      if (requestGeneration !== generation.current) return;
      setReferral(result.referral); setMemo(null); setMessage("Проверка результата сохранена в истории врача.");
    } catch (reason) { if (requestGeneration === generation.current) failOperation(reason); }
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
      <dl className={styles.factStrip}><div><dt>Лист ожидания</dt><dd>{eventValue(referral.queue)}</dd></div><div><dt>Назначенная дата</dt><dd>{calendarDate(referral.scheduledDate)}</dd></div><div><dt>Явка</dt><dd>{eventValue(referral.attendance)}</dd></div><div><dt>Пакет обследований</dt><dd>{packageState(referral)}</dd></div></dl>
      <div className={styles.tabs} role="tablist" aria-label="Разделы направления">{TABS.map(([key, label], index) => <button key={key} id={`tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={(event) => { const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null; if (next !== null) { event.preventDefault(); setTab(TABS[next][0]); document.getElementById(`tab-${TABS[next][0]}`)?.focus(); } }}>{label}{key === "history" && <span>{referral.events.length}</span>}</button>)}</div>
      <div className={styles.panel} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      <div className={tab === "overview" || tab === "exams" ? styles.grid : styles.single}><div className={styles.stack}>
        {tab === "overview" && <>
        <section className={styles.card}><div className={styles.cardHeading}><h2>Связанный опрос</h2>{referral.intake && <Link className="btn subtle" href={`/workspace/intakes/${encodeURIComponent(referral.intake.sessionId)}`}>Открыть опрос</Link>}</div>
          {referral.intake ? <><p>{INTAKE_STATUS[referral.intake.status]} · {DELIVERY_STATUS[referral.intake.deliveryStatus]}</p><p className={styles.small}>Создан {timestamp(referral.intake.createdAt)}. Связь и владелец подтверждены сервером в текущей области доступа.</p></>
            : <p className={styles.small}>{referral.sourceSessionId ? "Исходный опрос больше не доступен по сроку хранения; сохранённая ниже сводка остаётся частью направления." : "Направление создано без исходного опроса."}</p>}
        </section>
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
        <section className={styles.card}><div className={styles.cardHeading}><h2>Заключение врача</h2><button className="btn subtle" onClick={() => setTab("facts")}>Открыть <Icon name="arrow" size={16} /></button></div>
          {referral.doctorAssessment ? <><p>{referral.doctorAssessment.hypothesis || "Текст не указан"}</p><dl className={styles.factList}><div><dt>Профиль</dt><dd>{profileDisplayName(referral.doctorAssessment.profile)}</dd></div><div><dt>Код МКБ-10</dt><dd>{referral.doctorAssessment.icd10Code || "не указан"}</dd></div><div><dt>Контекст лечения</dt><dd>{CARE_CONTEXT_LABELS[referral.doctorAssessment.careContext]}</dd></div><div><dt>Автор и время</dt><dd>{referral.doctorAssessment.authorName} · {timestamp(referral.doctorAssessment.recordedAt)}</dd></div></dl></>
            : <p className={styles.notice}>Заключение врача ещё не сохранено. Активный перечень подготовки недоступен.</p>}
          <p className={styles.small}>Сводка первичного опроса выше остаётся неизменной. Каждое исправление заключения записывается отдельно.</p>
        </section>
        <section className={styles.card}><div className={styles.cardHeading}><h2>Подтверждённые факты</h2><button className="btn subtle" onClick={() => setTab("facts")}>Уточнить <Icon name="arrow" size={16} /></button></div><dl className={styles.factList}>{["specialistReferred", "preparationStarted", "sent", "queue", "cancelled"].map((key) => <div key={key}><dt>{FACT_LABELS[key]}</dt><dd>{eventValue(referral[key as keyof ReferralFacts] ?? null)}</dd></div>)}</dl><p className={styles.small}>Очередь, назначенная дата и явка подтверждаются независимо друг от друга.</p></section>
        </>}
        {tab === "facts" && <><section className={styles.card}><h2>Заключение врача</h2><p className={styles.small}>Заключение хранится отдельно от неизменной сводки опроса. Изменение профиля или контекста создаёт новый снимок перечня; прежние записи остаются в истории.</p>
          {actor.role === "doctor" && actor.id === referral.doctorId ? <form className={styles.form} key={`assessment-${referral.revision}`} onSubmit={(event) => void saveAssessment(event)}><fieldset disabled={disabled}>
            <label className={styles.field}>Текст заключения<textarea name="hypothesis" defaultValue={referral.doctorAssessment?.hypothesis ?? ""} maxLength={4000} /></label>
            <div className={styles.fields}><label className={styles.field}>Профиль госпитализации<select name="profile" defaultValue={referral.doctorAssessment?.profile ?? referral.profile} required>{!REFERRAL_PROFILES.some((profile) => profile === referral.profile) && <option value={referral.profile}>{profileDisplayName(referral.profile)}</option>}{REFERRAL_PROFILES.map((profile) => <option key={profile} value={profile}>{profile}</option>)}</select><span className={styles.small}>Справочник и пилотное сопоставление ожидают проверки врачом больницы.</span></label><label className={styles.field}>Код МКБ-10<input name="icd10Code" defaultValue={referral.doctorAssessment?.icd10Code ?? referral.icd10Code ?? ""} maxLength={8} pattern="[A-Za-z][0-9]{2}(\.[0-9A-Za-z]{1,4})?" placeholder="Например, I65.2" /><span className={styles.small}>Код не выбирает профиль автоматически.</span></label></div>
            <label className={styles.field}>Контекст лечения<select name="careContext" defaultValue={referral.doctorAssessment?.careContext ?? "unknown"}><option value="unknown">Не уточнён — перечень недоступен</option><option value="operative">С вмешательством</option><option value="conservative">Без вмешательства</option></select></label>
            <label className={styles.field}>Причина изменения<textarea name="reason" required maxLength={500} placeholder="Почему это заключение подтверждается или исправляется" /></label>
            <button className="btn" disabled={disabled}>{busy ? "Сохраняем…" : "Сохранить заключение"}</button>
          </fieldset></form> : <p className={styles.notice}>Изменять заключение может только назначенный врач. Просмотр истории доступен в карточке.</p>}
        </section><section className={styles.card}><h2>Подтвердить факты</h2><p className={styles.small}>Указывайте только известные факты. Назначенная дата сама по себе не подтверждает явку.</p>
          <form className={styles.form} key={`facts-${referral.revision}`} onSubmit={(event) => void save(event, "facts")}>
            <fieldset disabled={disabled}>
            <label className={styles.field}>Принимающая организация<input name="destinationOrganization" defaultValue={referral.destinationOrganization || ""} maxLength={160} /></label>
            <div className={styles.fields}><BoolField name="specialistReferred" label="Направлен к узкому специалисту" value={facts.specialistReferred ?? null} /><label className={styles.field}>Подготовка пакета<select name="preparationStarted" defaultValue={facts.preparationStarted ? "yes" : "no"}><option value="no">Не начата</option><option value="yes">Начата врачом</option></select></label><BoolField name="sent" label="Направление отправлено" value={referral.sent} /><BoolField name="queue" label="В листе ожидания" value={referral.queue} /></div>
            <div className={styles.fields}><label className={styles.field}>Назначенная дата<input name="scheduledDate" type="date" defaultValue={referral.scheduledDate || ""} /></label><label className={styles.field}>Явка<select name="attendance" defaultValue={referral.attendance ?? "unknown"}><option value="unknown">Неизвестно</option><option value="attended">Явился — подтверждено</option><option value="not_attended">Не явился — подтверждено</option></select></label></div>
            <label className={styles.field}>Отмена направления<select name="cancelled" defaultValue={referral.cancelled ? "yes" : "no"}><option value="no">Не отменено</option><option value="yes">Отмена подтверждена</option></select></label>
            <label className={styles.field}>Когда произошло событие, время Алматы<input name="occurredAt" type="datetime-local" /><span className={styles.small}>Можно оставить пустым: время события останется неизвестным.</span></label>
            <label className={styles.field}>Основание или причина исправления<textarea name="reason" maxLength={500} placeholder="Что подтвердили или почему исправляете прежнюю запись" /></label>
            <button className="btn" disabled={disabled}>{busy ? "Сохраняем…" : "Подтвердить изменения"}</button>
            </fieldset>
          </form>
        </section></>}
        {tab === "history" && <section className={styles.card}><h2>История подтверждений</h2><p className={styles.small}>Неизменяемый журнал. Исправление добавляет новую запись, а не удаляет предыдущую. Время указано по Алматы.</p><ol className={styles.timeline}>{[...referral.events].reverse().map((event) => {
          if (event.type === "doctor_assessment_changed") {
            const previous = (event.before as DoctorAssessmentEventState).assessment;
            const current = (event.after as DoctorAssessmentEventState).assessment!;
            return <li key={event.id}><p><strong>{event.actorName}</strong> · Сохранил заключение врача</p><p className={styles.small}>Записано: {timestamp(event.recordedAt)} · версия заключения {current.revision}</p>{(["hypothesis", "profile", "icd10Code", "careContext"] as const).filter((key) => previous?.[key] !== current[key]).map((key) => <p className={styles.small} key={key}>{FACT_LABELS[key]}: {previous ? `${eventFieldValue(key, previous[key])} → ` : ""}{eventFieldValue(key, current[key])}</p>)}<p>{event.reason}</p></li>;
          }
          if (event.type === "registration_snapshot_recorded") return <li key={event.id}><p><strong>{event.actorName}</strong> · Подтвердил снимок данных на момент регистрации</p><p className={styles.small}>Записано: {timestamp(event.recordedAt)} · ревизия {event.revision}. Значения сохранены без автоматического сопоставления с карточкой и больше не изменяются.</p></li>;
          const previous = event.before as Partial<ReferralFacts> | null;
          return <li key={event.id}><p><strong>{event.actorName}</strong> · {event.type === "created" ? "Создал направление" : event.type === "facts_changed" ? "Подтвердил факты" : "Записал обследование"}</p><p className={styles.small}>Записано: {timestamp(event.recordedAt)} · Событие: {timestamp(event.occurredAt)}</p>{event.transition && <p className={styles.small}>Переход этапа: {event.transition.from ? FLOW_LABELS[event.transition.from] : "начало"} → {FLOW_LABELS[event.transition.to]} · с {timestamp(event.transition.enteredAt)}</p>}{Object.entries(event.after).filter(([key, value]) => key in FACT_LABELS && (!previous || (previous as Record<string, unknown>)[key] !== value)).map(([key, value]) => <p className={styles.small} key={key}>{FACT_LABELS[key]}: {previous && key in previous ? `${eventFieldValue(key, (previous as Record<string, unknown>)[key])} → ` : ""}{eventFieldValue(key, value)}</p>)}{event.reason && <p>{event.reason}</p>}</li>;
        })}</ol></section>}
        {tab === "risk" && <section className={styles.card}><h2>Исследовательская оценка B3</h2>
          <p className={styles.notice}>Только исследование. Оценка не влияет на заключение врача, срочность, маршрут или решение о госпитализации.</p>
          {referral.registrationSnapshot ? <><p className={styles.small}>Врач подтвердил семь значений такими, какими они были при регистрации. Снимок неизменяемый; данные карточки не подставляются автоматически.</p>
            <dl className={styles.factList}>{REGISTRATION_FIELDS.map(([name, label]) => <div key={name}><dt>{label}</dt><dd>{referral.registrationSnapshot?.[name] ?? "не указано"}</dd></div>)}</dl>
            <button className="btn" disabled={disabled} onClick={() => void loadRisk()}>{busy ? "Проверяем…" : "Рассчитать исследовательскую оценку"}</button>
          </> : actor.role === "doctor" && actor.id === referral.doctorId ? <form className={styles.form} onSubmit={(event) => void saveRegistrationSnapshot(event)}><fieldset disabled={disabled}>
            <p className={styles.small}>Введите значения из записи на момент регистрации. Подтвердите их только по первичному источнику; текущий профиль, код и организация не копируются сюда автоматически.</p>
            {REGISTRATION_FIELDS.map(([name, label]) => <label className={styles.field} key={name}>{label}<input name={name} maxLength={500} required={name !== "bed_profile"} /></label>)}
            <label className={styles.field}><input name="attestation" type="checkbox" required /> Подтверждаю, что значения относятся к моменту регистрации направления</label>
            <button className="btn" disabled={disabled}>{busy ? "Сохраняем…" : "Сохранить неизменяемый снимок"}</button>
          </fieldset></form> : <p className={styles.small}>Снимок ещё не подтверждён назначенным врачом. Исследовательская оценка недоступна.</p>}
          {risk?.status === "unavailable" && <p className={styles.notice}>{risk.reason === "REGISTRATION_SNAPSHOT_MISSING" ? "Нет подтверждённого снимка на момент регистрации." : risk.reason === "INPUTS_INCOMPLETE" ? "Недостаточно обязательных входных данных." : "Проверенный артефакт оценки сейчас недоступен."}</p>}
          {risk?.status === "available" && <div className={styles.memo}><p className={styles.eyebrow}>Вероятность отказа среди зрелых наблюдаемых исходов</p><p className={styles.stageTime}>{(risk.refusalProbabilityAmongMatureOutcomes * 100).toFixed(1)}%</p><p>{risk.riskBand === "at_or_above_working_threshold" ? "На или выше рабочего исследовательского порога" : "Ниже рабочего исследовательского порога"} ({(risk.workingThreshold * 100).toFixed(1)}%).</p>{risk.warnings.map((warning) => <p className={styles.notice} key={warning}>{warning}</p>)}<h3>Покрытие входов</h3><ul className={styles.list}>{REGISTRATION_FIELDS.map(([name, label]) => <li key={name}><strong>{label}</strong><p>{COVERAGE_LABELS[risk.inputCoverage[name]] ?? "покрытие неизвестно"}</p></li>)}</ul><ul className={styles.list}>{risk.limitations.map((item) => <li key={item}>{item}</li>)}</ul><p className={styles.small}>Модель {risk.modelVersion} · входная ревизия {risk.inputRevision}</p></div>}
        </section>}
        {tab === "exams" && <section className={styles.card}><h2>Комплектность пакета</h2><span className={styles.badge}>{packageState(referral)}</span><p className={styles.small}>На {calendarDate(referral.completeness.evaluatedOn)} · {referral.completeness.basis === "scheduled_date" ? "к назначенной дате" : "на сегодня"}</p>
          {!referral.completeness.catalogueAvailable && <p className={styles.notice}>{(referral.doctorAssessment?.careContext ?? "unknown") === "unknown" ? "Врач ещё не выбрал контекст лечения; активный перечень недоступен." : referral.completeness.catalogueStatus === "available" && !referral.completeness.catalogueValidated ? `Перечень ${referral.completeness.catalogueVersion} получен, но ещё не проверен врачом больницы.` : "Проверенный перечень для этого профиля недоступен."} Комплектность не подтверждена.</p>}
          <ul className={styles.list}>{referral.completeness.entries.map((entry) => <li key={entry.requirementId}><strong>{entry.label}</strong><p>{requirementPosition(referral, entry.requirementId, entry.required)} · {EXAM_LABELS[entry.status]} · {freshnessLabel(referral, entry.requirementId, entry.expiresOn)}</p>{entry.provenance === "profile_addition_unverified" && <p className={styles.small}>Профильное дополнение: источник и применимость требуют подтверждения врача.</p>}</li>)}</ul>
          <h3>Отметки пациента</h3><p className={styles.small}>Это сведения со слов пациента. Проверьте сам результат перед подтверждением. Отметки не меняют подтверждённую комплектность автоматически.</p>
          {!referral.patientReports?.length && <p className={styles.small}>Пациент пока не оставил отметок. Обновите карточку, чтобы увидеть новые.</p>}
          <ul className={styles.list}>{referral.patientReports?.map((report) => {
            const confirmed = referral.examinations.some((exam) => exam.patientReportId === report.id);
            return <li key={report.id}><strong>{requirementDefinition(referral, report.requirementId)?.label ?? report.requirementId}</strong><p>Проведено: {calendarDate(report.performedOn)} · Результат: {report.resultAvailable ? "получен" : "ещё не получен"}</p><p className={styles.small}>Пациент отметил: {timestamp(report.recordedAt)} · версия {report.revision}</p>{confirmed ? <p>Подтверждено врачом</p> : <button className="btn ghost" disabled={disabled || referral.cancelled || actor.role !== "doctor"} onClick={() => void confirmReport(report)}>Проверил результат — подтвердить</button>}</li>;
          })}</ul>
          <h3>Обследования текущего перечня</h3>{!referral.examinations.some((exam) => exam.requirementSnapshotId === referral.requirementSnapshotId) && <p className={styles.small}>Пока не добавлены.</p>}<ul className={styles.list}>{referral.examinations.filter((exam) => exam.requirementSnapshotId === referral.requirementSnapshotId).map((exam) => <li key={exam.id}><strong>{exam.label}</strong><p className={styles.small}>Проведено: {calendarDate(exam.performedOn)} · Действует до: {calendarDate(exam.expiresOn)}</p><p className={styles.small}>Наличие результата: {eventValue(exam.resultAvailable)}</p><button className="btn subtle" disabled={disabled} onClick={() => { setDateError(""); setEditingExam({ ...exam }); }}>Исправить</button></li>)}</ul>
          {referral.examinations.some((exam) => exam.requirementSnapshotId !== referral.requirementSnapshotId) && <><h3>Исторические записи прежних перечней</h3><p className={styles.small}>Они сохранены для аудита и не влияют на текущую комплектность.</p><ul className={styles.list}>{referral.examinations.filter((exam) => exam.requirementSnapshotId !== referral.requirementSnapshotId).map((exam) => <li key={exam.id}><strong>{exam.label}</strong><p className={styles.small}>Проведено: {calendarDate(exam.performedOn)} · Действует до: {calendarDate(exam.expiresOn)}</p><p className={styles.small}>Наличие результата: {eventValue(exam.resultAvailable)}</p></li>)}</ul></>}
        </section>}
        {tab === "memo" && <section className={styles.card}><div className={styles.cardHeading}><h2>Памятка пациенту</h2><Icon name="referrals" /></div><p className={styles.small}>Проверьте список перед передачей пациенту. Передача — через врача. Если доставка не подтверждена, проверьте Telegram: автоматически повторять отправку нельзя.</p><div className={styles.row}><button className="btn ghost" disabled={disabled} onClick={() => void getMemo()}>Посмотреть памятку</button>{disabled ? <button className="btn subtle" disabled><Icon name="download" size={16} /> Скачать PDF</button> : <a className="btn subtle" href={`${base}/patient-memo?format=pdf`} target="_blank" rel="noreferrer"><Icon name="download" size={16} /> Скачать PDF</a>}<button className="btn subtle" disabled={disabled} onClick={() => void notify()}>{notifyStatus?.state === "pending" ? "Отправляем…" : "Отправить врачу в Telegram"}</button></div>
          {notifyStatus && <p className={`${styles.notifyStatus} ${notifyStatus.state === "error" ? styles.notifyError : ""}`} role={notifyStatus.state === "error" ? "alert" : "status"}>{notifyStatus.message}</p>}
          <h3>Личная ссылка пациента</h3><p className={styles.small}>Открывает только список подготовки и отметки этого направления. Срок — 30 дней. Создание новой ссылки отзывает прежнюю. Передавайте её только этому пациенту.</p>
          <div className={styles.row}><button className="btn ghost" disabled={disabled} onClick={() => void managePreparation("reissue")}>Создать новую ссылку пациенту</button><button className="btn subtle" disabled={disabled} onClick={() => void managePreparation("revoke")}>Отозвать доступ пациента</button></div>
          {preparationUrl && <label className={styles.field}>Передайте ссылку пациенту<input readOnly value={preparationUrl} onFocus={(event) => event.currentTarget.select()} /><a href={preparationUrl} target="_blank" rel="noreferrer">Открыть пакет пациента</a></label>}
          {memo ? <div className={styles.memo}><p className={styles.eyebrow}>Памятка для передачи пациенту</p><h3>{memo.patientLabel}</h3><p>{memo.destinationOrganization || "Организацию нужно уточнить"}</p><p>Целевая дата госпитализации: {calendarDate(memo.scheduledDate)}</p>{!memo.catalogueAvailable && <p className={styles.notice}>{(memo.careContext ?? "unknown") === "unknown" ? "Контекст лечения ещё не выбран; активный перечень недоступен." : "Справочник ещё не проверен врачом больницы. Состав пакета ниже не подтверждён."}</p>}<h3>Что взять с собой</h3><ul className={styles.list}>{memo.items.map((item, index) => <li key={index}><strong>{item.label}</strong><p>{memoAction(item.status)}{item.expiresOn ? ` · срок действия до ${calendarDate(item.expiresOn)}` : " · срок действия уточните у врача"}{item.provenance === "profile_addition_unverified" ? " · применимость подтверждает врач" : ""}</p></li>)}</ul><p className={styles.small}>Окончательный состав пакета и готовность подтверждает врач. Demeu не отправляет данные в Портал бюро госпитализации.</p></div> : <EmptyState title="Предпросмотр памятки" description="Нажмите «Посмотреть памятку», чтобы проверить актуальный состав перед передачей." />}
        </section>}
      </div>{(tab === "overview" || tab === "exams") && <aside className={styles.stack}>
          {tab === "overview" && <><section className={`${styles.card} ${isOperationallyDelayed(referral, delayThreshold) ? styles.delay : ""}`}><div className={styles.cardHeading}><h2>Время на этапе</h2><Icon name="clock" /></div><p className={styles.stageTime}>{referral.observedStageDays === null ? "Неизвестно" : `${referral.observedStageDays.toFixed(1)} дн.`}</p><p className={styles.small}>{observedDaysLabel(referral.observedStageDays)}</p><label className={styles.field}>Рабочий порог, дней<input type="number" min="0" step="0.1" value={delayThreshold} onChange={(event) => setDelayThreshold(event.target.value)} placeholder="Не задан" /></label><p className={styles.small}>Порог сохраняется в этом браузере и применяется в списке и обзоре. Это не нормативный срок и не оценка срочности.</p>{isOperationallyDelayed(referral, delayThreshold) && <p className={styles.delayLabel}>Превышен выбранный рабочий порог</p>}</section><section className={styles.card}><h2>Пакет обследований</h2><span className={styles.badge}>{packageState(referral)}</span><p className={styles.small}>{referral.completeness.catalogueAvailable ? "Проверка по подтверждённому перечню." : referral.completeness.catalogueStatus === "available" && !referral.completeness.catalogueValidated ? `Перечень ${referral.completeness.catalogueVersion} ожидает проверки врачом больницы. Комплектность не подтверждена.` : "Проверенный перечень недоступен. Комплектность не подтверждена."}</p><button className="btn subtle" onClick={() => setTab("exams")}>Перейти к обследованиям <Icon name="arrow" size={16} /></button></section></>}
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
