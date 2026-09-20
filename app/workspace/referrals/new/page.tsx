"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { ReferralDetail } from "@/lib/referrals/types";
import { REFERRAL_PROFILES } from "@/lib/referrals/profiles";
import { timestamp, useWorkspaceCommand } from "../../client";
import { useWorkspaceData, type Intake } from "../../data";
import { useWorkspaceContext } from "../../shell";
import { EmptyState, Icon, PageHeading } from "../../ui";
import s from "../../dashboard.module.css";

export default function NewReferralPage() {
  const { actor } = useWorkspaceContext();
  const router = useRouter();
  const allowed = actor.role !== "analyst";
  const resource = useWorkspaceData<{ intakes: Intake[] }>(allowed ? "/api/workspace/intakes" : null, actor.id + actor.role + actor.organizationId);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const command = useWorkspaceCommand();
  useEffect(() => { setSource(new URLSearchParams(window.location.search).get("sourceSessionId") ?? ""); }, []);
  if (!allowed) return <EmptyState title="Создание недоступно" description="Направления подтверждает врач. Аналитику доступны только сводные данные." />;
  const completed = resource.data?.intakes.filter((intake) => intake.status === "completed" && intake.result) ?? [];
  const chosen = completed.find((intake) => intake.sessionId === source);
  const unavailable = Boolean(source && resource.data && !chosen);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (source && !chosen)) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const { referral } = await command<{ referral: ReferralDetail }>("/api/referrals", {
        patientLabel: String(data.get("patientLabel") ?? "").trim(), profile: String(data.get("profile") ?? "").trim(),
        icd10Code: String(data.get("icd10Code") ?? "").trim() || null,
        destinationOrganization: String(data.get("destinationOrganization") ?? "").trim() || null, sourceSessionId: source || null,
      });
      router.push("/workspace/referrals/" + encodeURIComponent(referral.id));
    } catch (reason) { setError((reason as Error).message); setBusy(false); }
  }
  return <div className={s.stack}>
    <PageHeading eyebrow="Новое направление" title="Подготовить направление" description="Сначала создайте запись. Очередь, даты и явку вы сможете подтвердить отдельно." actions={<Link className={s.secondary} href="/workspace/referrals">К направлениям</Link>} />
    <div className={s.grid}><section className={s.card}>
      <div className={s.head}><h2>Основные сведения</h2><Icon name="referrals" size={20} /></div>
      <form className={s.form} onSubmit={(event) => void create(event)}>
        <label className={s.field}>Метка пациента / эпизода<input name="patientLabel" required maxLength={100} autoComplete="off" placeholder="Например, внутренний номер эпизода" /><span className={s.small}>ФИО и ИИН не требуются. Не добавляйте лишние персональные сведения.</span></label>
        <label className={s.field}>Профиль госпитализации<select name="profile" required defaultValue=""><option value="" disabled>Выберите профиль</option>{REFERRAL_PROFILES.map((profile) => <option key={profile} value={profile}>{profile}</option>)}</select><span className={s.small}>Профили из переданного перечня обследований. Перечень ещё не проверен врачом больницы.</span></label>
        <label className={s.field}>Код МКБ-10<input name="icd10Code" maxLength={8} pattern="[A-Za-z][0-9]{2}(\.[0-9A-Za-z]{1,4})?" placeholder="Например, I20.9" autoComplete="off" /><span className={s.small}>Укажите только код, подтверждённый врачом. Он нужен для аналитики; перечень обследований выбирается по профилю.</span></label>
        <label className={s.field}>Принимающая организация<input name="destinationOrganization" maxLength={160} placeholder="Можно уточнить позже" /></label>
        <label className={s.field}>Связать с завершённым опросом<select value={source} disabled={resource.loading || busy} onChange={(e) => setSource(e.target.value)}><option value="">Без опроса — ручное создание</option>{unavailable && <option value={source}>Выбранный опрос недоступен</option>}{completed.map((intake) => <option key={intake.sessionId} value={intake.sessionId}>{timestamp(intake.createdAt)} · {intake.result?.anamnesis.chief_complaint || "Завершённый опрос"}</option>)}</select></label>
        {resource.loading && <p role="status" className={s.small}>Проверяем доступные опросы…</p>}
        {resource.error && <div className={s.notice + " " + s.error} role="alert">{resource.error} <button type="button" className={s.secondary} onClick={resource.reload}>Повторить загрузку</button></div>}
        {unavailable && <p className={s.notice} role="alert">Выбранный опрос недоступен или уже удалён по сроку хранения. Выберите другой либо явно создайте направление без связи.</p>}
        {chosen && <p className={s.notice}>Сохранится сводка выбранного завершённого опроса без переписки. Направление подтверждаете вы, не модель.</p>}
        {error && <p className={s.notice + " " + s.error} role="alert">{error}</p>}
        <div className={s.actions}><button className={s.button} disabled={busy || Boolean(source && !chosen)}>{busy ? "Сохраняем…" : "Подтвердить создание"}</button><Link className={s.secondary} href="/workspace/referrals">Отмена</Link></div>
      </form>
    </section><aside className={s.stack}><section className={s.card}><h2>Что произойдёт дальше</h2><ol className={s.muted}><li>Будет создана отдельная запись направления.</li><li>Вы сможете добавить обследования и проверить комплектность.</li><li>Известные внешние факты подтверждаются отдельно и сохраняются в истории.</li></ol><p className={s.notice}>Неизвестное остаётся неизвестным. Создание записи не означает отправку в Портал или назначение госпитализации.</p></section></aside></div>
  </div>;
}
