"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { timestamp } from "../../client";
import { useWorkspaceData, type Intake } from "../../data";
import { useWorkspaceContext } from "../../shell";
import { EmptyState, PageHeading } from "../../ui";
import s from "../../dashboard.module.css";
import { IntakeSummary } from "../summary";

const STATUS = { collecting: "В процессе", completed: "Завершён", aborted: "Прерван" };
const DELIVERY = { pending: "Ожидает подтверждения", sent: "Отправлено врачу", failed: "Ошибка доставки" };

export default function IntakeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { actor } = useWorkspaceContext();
  const allowed = actor.role !== "analyst";
  const resource = useWorkspaceData<{ intake: Intake }>(
    allowed ? `/api/workspace/intakes/${encodeURIComponent(id)}` : null,
    `${actor.id}:${actor.role}:${actor.organizationId}:${id}`,
  );

  if (!allowed) return <EmptyState title="Сводка недоступна" description="Персональные опросы недоступны вашей роли." />;
  const intake = resource.data?.intake;
  return <div className={s.stack}>
    <Link className={s.sectionLink} href="/workspace/intakes">← Все опросы</Link>
    {resource.loading && <p role="status" className={s.loading}>Загружаем сводку опроса…</p>}
    {resource.error && <p role="alert" className={`${s.notice} ${s.error}`}>{resource.error}</p>}
    {intake && <>
      <PageHeading
        eyebrow="Опрос пациента"
        title="Сводка первичного опроса"
        description={`Создан ${timestamp(intake.createdAt)}`}
        actions={<div className={s.actions}><span className={s.tag}>{STATUS[intake.status]}</span><span className={`${s.tag}${intake.deliveryStatus === "failed" ? ` ${s.warning}` : ""}`}>{DELIVERY[intake.deliveryStatus]}</span></div>}
      />
      {intake.result ? <IntakeSummary result={intake.result} /> : <section className={s.card}><EmptyState title="Итоговая сводка ещё не сформирована" description="Сводка появится после завершения опроса. Обновите страницу позже." /></section>}
      <section className={s.card}>
        <div className={s.head}><div><h2>Следующее действие</h2><p className={s.small}>Направление хранится отдельно от исходного опроса.</p></div>
          {intake.referralId
            ? <Link className={s.button} href={`/workspace/referrals/${encodeURIComponent(intake.referralId)}`}>Открыть направление</Link>
            : intake.status === "completed" && intake.result
              ? <Link className={s.button} href={`/workspace/referrals/new?sourceSessionId=${encodeURIComponent(intake.sessionId)}`}>Подготовить направление</Link>
              : <span className={s.small}>Доступно после завершения опроса</span>}
        </div>
      </section>
    </>}
  </div>;
}
