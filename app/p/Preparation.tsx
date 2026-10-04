"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PatientPackage } from "@/lib/referrals/types";
import styles from "./preparation.module.css";

const COPY = {
  ru: { title: "Подготовка обследований", loading: "Загружаем список…", error: "Не удалось открыть пакет. Ссылка могла истечь или быть отозвана. Уточните у врача новую ссылку.",
    retry: "Обновить список", waiting: "Врач ещё готовит направление", waitingBody: "Ваш опрос сохранён. Список появится здесь после того, как врач создаст направление. Повторно проходить опрос не нужно.",
    unvalidated: "Перечень ещё не проверен врачом больницы. Состав пакета и готовность должен подтвердить врач.", unavailable: "Перечень для этого направления недоступен. Уточните его у врача.",
    date: "Дата госпитализации", notSet: "Не назначена", validity: "Срок действия", days: "дн.", expiry: "Действует до", unknown: "Уточнить у врача", doctor: "Подтверждено врачом", reported: "Со слов пациента — ожидает проверки врача",
    conditional: "По показаниям: применимость определяет врач", required: "Обязательное", optional: "Необязательное", done: "Отметить «сдал»", save: "Сохранить отметку", performed: "Дата проведения", result: "Результат получен", yes: "Да", no: "Ещё не получен",
    saving: "Сохраняем…", saved: "Отметка сохранена. Врач увидит её в направлении.", failed: "Не удалось сохранить. Проверьте соединение и повторите.", conflict: "Отметка изменилась в другой вкладке. Список обновлён; проверьте данные и повторите сохранение.",
    future: "Укажите реальную дату проведения, не позднее сегодняшнего дня.", pdf: "Скачать памятку PDF", disclaimer: "Ваши отметки не заменяют проверку результатов. Окончательный состав пакета и готовность подтверждает врач.",
    cancelled: "Направление отменено. Отметки недоступны; уточните дальнейшие действия у врача.", expires: "Ссылка действительна до", invalidPdf: "Скачать PDF можно после создания направления.",
    status: { present: "Результат есть", missing: "Результата нет", expired: "Срок истёк", unknown: "Нужно уточнение", not_applicable: "Не требуется по решению врача" },
    willExpire: "Результат истечёт до назначенной госпитализации", notConfirmed: "Готовность не подтверждена", confirmed: "Врач подтвердил эту отметку", source: "Версия перечня",
    context: "Контекст подготовки", contexts: { operative: "с вмешательством", conservative: "без вмешательства", unknown: "не уточнён" }, profileDraft: "Профильное дополнение: источник и применимость подтверждает врач" },
  kk: { title: "Тексерулерге дайындық", loading: "Тізім жүктелуде…", error: "Пакетті ашу мүмкін болмады. Сілтеме мерзімі өткен немесе кері қайтарылған болуы мүмкін. Дәрігерден жаңа сілтеме сұраңыз.",
    retry: "Тізімді жаңарту", waiting: "Дәрігер жолдаманы дайындауда", waitingBody: "Сауалнамаңыз сақталды. Дәрігер жолдаманы жасағаннан кейін тізім осы жерде пайда болады. Сауалнаманы қайта өту қажет емес.",
    unvalidated: "Тізімді аурухана дәрігері әлі тексерген жоқ. Пакеттің құрамы мен дайындықты дәрігер растауы керек.", unavailable: "Бұл жолдаманың тізімі қолжетімсіз. Дәрігерден нақтылаңыз.",
    date: "Госпитализация күні", notSet: "Белгіленбеген", validity: "Жарамдылық мерзімі", days: "күн", expiry: "Жарамды күні", unknown: "Дәрігерден нақтылау", doctor: "Дәрігер растаған", reported: "Пациенттің айтуы бойынша — дәрігердің тексеруін күтуде",
    conditional: "Көрсетілім бойынша: қажеттілігін дәрігер анықтайды", required: "Міндетті", optional: "Міндетті емес", done: "«Тапсырдым» деп белгілеу", save: "Белгіні сақтау", performed: "Өткізілген күні", result: "Нәтиже алынды", yes: "Иә", no: "Әлі алынған жоқ",
    saving: "Сақталуда…", saved: "Белгі сақталды. Дәрігер оны жолдамадан көреді.", failed: "Сақтау мүмкін болмады. Байланысты тексеріп, қайталаңыз.", conflict: "Белгі басқа бетте өзгерді. Тізім жаңартылды; деректерді тексеріп, қайта сақтаңыз.",
    future: "Бүгінгі күннен кеш емес нақты өткізу күнін көрсетіңіз.", pdf: "PDF жадынаманы жүктеу", disclaimer: "Белгілер нәтижелерді тексеруді алмастырмайды. Соңғы тізім мен дайындықты дәрігер растайды.",
    cancelled: "Жолдама тоқтатылды. Белгілер қолжетімсіз; келесі әрекеттерді дәрігерден нақтылаңыз.", expires: "Сілтеме жарамды күні", invalidPdf: "PDF жолдама жасалғаннан кейін қолжетімді болады.",
    status: { present: "Нәтиже бар", missing: "Нәтиже жоқ", expired: "Мерзімі өткен", unknown: "Нақтылау қажет", not_applicable: "Дәрігер шешімі бойынша қажет емес" },
    willExpire: "Нәтиже жоспарланған госпитализацияға дейін жарамсыз болады", notConfirmed: "Дайындық расталмаған", confirmed: "Дәрігер бұл белгіні растады", source: "Тізім нұсқасы",
    context: "Дайындық мәнмәтіні", contexts: { operative: "араласумен", conservative: "араласусыз", unknown: "нақтыланбаған" }, profileDraft: "Бейіндік қосымша: дереккөз бен қолданылуын дәрігер растайды" },
};
type Lang = "ru" | "kk";
export class PreparationError extends Error { constructor(readonly status: number, readonly code?: string) { super(String(status)); } }
export async function preparationRequest(url: string, body?: unknown): Promise<PatientPackage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, referrerPolicy: "no-referrer" });
    if (!response.ok) { const failure = await response.json().catch(() => null); throw new PreparationError(response.status, failure?.code); }
    const data = await response.json();
    if (!data.package || !Array.isArray(data.package.items) || typeof data.package.accessId !== "string") throw new Error("Invalid response");
    return data.package;
  } finally { clearTimeout(timeout); }
}
const today = () => new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const date = (value: string | null) => value ? value.split("-").reverse().join(".") : "—";
export default function Preparation({ accessId, language: initialLanguage = "ru", initialPackage }: { accessId: string; language?: Lang; initialPackage?: PatientPackage }) {
  const [language, setLanguage] = useState<Lang>(initialLanguage);
  const [data, setData] = useState<PatientPackage | null>(initialPackage ?? null);
  const [loading, setLoading] = useState(!initialPackage);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const requestKeys = useRef(new Map<string, string>());
  const active = useRef(true);
  const text = COPY[language];
  const base = `/api/patient/${encodeURIComponent(accessId)}/package`;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (initialPackage && version === 0) return;
    let disposed = false;
    setLoading(true); setError(false);
    void preparationRequest(base).then((next) => { if (!disposed) setData(next); })
      .catch(() => { if (!disposed) { setError(true); setData(null); } })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [base, version, initialPackage]);
  async function save(event: FormEvent<HTMLFormElement>, item: PatientPackage["items"][number]) {
    event.preventDefault();
    if (pending.current || busy) return;
    const form = new FormData(event.currentTarget);
    const performedOn = String(form.get("performedOn") ?? "");
    if (!performedOn || performedOn > today()) { setMessage(text.future); return; }
    pending.current = true; setBusy(item.requirementId); setMessage("");
    const input = { requirementId: item.requirementId, performedOn, resultAvailable: form.get("resultAvailable") === "yes", expectedRevision: item.selfReport?.revision ?? 0 };
    const intent = JSON.stringify(input);
    const key = requestKeys.current.get(intent) ?? crypto.randomUUID();
    requestKeys.current.set(intent, key);
    try {
      const next = await preparationRequest(base, { ...input, idempotencyKey: key });
      requestKeys.current.delete(intent);
      if (active.current) { setData(next); setMessage(text.saved); }
    } catch (reason) {
      if (active.current) {
        if (reason instanceof PreparationError && reason.code === "REVISION_CONFLICT") {
          try { const next = await preparationRequest(base); if (active.current) setData(next); } catch { /* Keep unsaved form values visible. */ }
          setMessage(text.conflict);
        } else if (reason instanceof PreparationError && reason.code === "NO_CHANGES") setMessage(text.saved);
        else setMessage(text.failed);
      }
    } finally { pending.current = false; if (active.current) setBusy(null); }
  }
  return <section className={styles.shell} lang={language} aria-labelledby={`preparation-${accessId}`}>
    <header className={styles.header}><div><span className={styles.brand}>Demeu</span><h1 id={`preparation-${accessId}`}>{text.title}</h1></div><div className={styles.language} aria-label={language === "ru" ? "Язык" : "Тіл"}><button type="button" aria-pressed={language === "ru"} onClick={() => setLanguage("ru")}>Рус</button><button type="button" aria-pressed={language === "kk"} onClick={() => setLanguage("kk")}>Қаз</button></div></header>
    {loading && <p role="status">{text.loading}</p>}
    {error && <p className={styles.notice} role="alert">{text.error}</p>}
    {!loading && <button className="btn subtle" type="button" disabled={Boolean(busy)} onClick={() => setVersion((v) => v + 1)}>{text.retry}</button>}
    {data && <>
      <p className={styles.muted}>{text.expires}: {date(new Date(data.expiresAt + 5 * 3600000).toISOString().slice(0, 10))}</p>
      {data.state === "awaiting_referral" ? <div className={styles.card}><h2>{text.waiting}</h2><p>{text.waitingBody}</p></div> : <>
        <div className={styles.card}><h2>{data.patientLabel}</h2><p>{data.destinationOrganization || text.unknown}</p><p><strong>{text.date}: </strong>{data.scheduledDate ? date(data.scheduledDate) : text.notSet}</p><p><strong>{text.context}: </strong>{text.contexts[data.careContext ?? "unknown"]}</p><p className={styles.muted}>{text.source}: {data.catalogueVersion ?? "—"}</p>
          {(data.careContext ?? "unknown") !== "unknown" && !data.catalogueValidated && <p className={styles.notice}>{text.unvalidated}</p>}
          {!data.items.length && <p className={styles.notice}>{text.unavailable}</p>}
          {data.state === "cancelled" && <p className={styles.notice} role="status">{text.cancelled}</p>}
          <a className="btn ghost" href={`${base}?format=pdf&lang=${language}`} target="_blank" rel="noreferrer">{text.pdf}</a>
        </div>
        <ol className={styles.items}>{data.items.map((item) => <li key={item.requirementId} className={styles.card}>
          <h2>{item.label}</h2><p className={styles.muted}>{item.conditional ? text.conditional : item.required === true ? text.required : item.required === false ? text.optional : text.unknown}</p>
          {item.provenance === "profile_addition_unverified" && <p className={styles.notice}>{text.profileDraft}</p>}
          <p className={item.preparationStatus === "expired" ? styles.warning : undefined}><strong>{text.status[item.preparationStatus]}</strong></p>
          <p>{text.validity}: {item.validForDays === null ? text.unknown : `${item.validForDays} ${text.days}`} · {text.expiry}: {date(item.expiresOn)}</p>
          {item.expiringBeforeAdmission && <p className={styles.warning}>{text.willExpire}</p>}
          {item.selfReport && <p className={styles.muted}>{item.selfReport.confirmed ? text.confirmed : text.reported} · {date(item.selfReport.performedOn)}</p>}
          {!item.selfReport && item.confirmedStatus === "present" && <p className={styles.muted}>{text.doctor}</p>}
          {item.applicability === "yes" && data.state !== "cancelled" && <details className={styles.details}><summary>{text.done}</summary><form className={styles.form} onSubmit={(event) => void save(event, item)}>
            <label>{text.performed}<input required type="date" name="performedOn" max={today()} defaultValue={item.selfReport?.performedOn ?? ""} disabled={Boolean(busy)} /></label>
            <label>{text.result}<select name="resultAvailable" defaultValue={item.selfReport?.resultAvailable === false ? "no" : "yes"} disabled={Boolean(busy)}><option value="yes">{text.yes}</option><option value="no">{text.no}</option></select></label>
            <button className="btn" type="submit" disabled={Boolean(busy)}>{busy === item.requirementId ? text.saving : text.save}</button>
          </form></details>}
        </li>)}</ol>
      </>}
    </>}
    {message && <p className={styles.notice} role="status">{message}</p>}
    <p className={styles.muted}>{text.disclaimer}</p>
  </section>;
}
