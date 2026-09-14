"use client";

import { useEffect, useRef, useState } from "react";
import type { ReferralActor, ReferralFlow } from "@/lib/referrals/types";

export class WorkspaceError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); }
}

// Requests from a previous principal must not invalidate a newer session.
let authEpoch = 0;
export function advanceWorkspaceAuthEpoch() { authEpoch += 1; }

export async function workspaceRequest<T>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const requestEpoch = authEpoch;
  let response: Response;
  try {
    response = await fetch(url, {
      method, credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new WorkspaceError(0, method === "GET" || url === "/api/workspace/auth" ? "Не удалось связаться с сервером. Проверьте подключение и повторите запрос." : "Связь прервалась. Проверьте состояние записи перед повтором действия."); }
  if (!response.ok) {
    if (typeof window !== "undefined" && url !== "/api/workspace/auth" && requestEpoch === authEpoch) {
      if (response.status === 401) window.dispatchEvent(new Event("demeu:workspace-expired"));
      if (response.status === 403) window.dispatchEvent(new Event("demeu:workspace-forbidden"));
    }
    const failure = await response.json().catch(() => null) as { code?: string } | null;
    const codes: Record<string, string> = {
      REASON_REQUIRED: "Укажите причину исправления или отмены.",
      DUPLICATE_EXAMINATION: "Это обследование уже записано. Выберите «Исправить» у существующей записи.",
      NO_CHANGES: "Изменений нет. Уточните нужные поля перед подтверждением.",
      DELIVERY_UNCONFIRMED: "Доставка могла выполниться частично. Проверьте Telegram врача. Повторная отправка заблокирована, чтобы избежать дубликатов; обратитесь к администратору.",
      DELIVERY_RECIPIENT_UNAVAILABLE: "Получатель Telegram не настроен или больше недоступен. Обратитесь к администратору.",
    };
    const messages: Record<number, string> = {
      400: "Проверьте поля формы. Даты должны быть действительными.",
      401: "Войдите в кабинет, чтобы продолжить.",
      403: "У вашей учётной записи нет доступа к этому действию.",
      404: "Запись не найдена или недоступна вашей учётной записи.",
      409: "Запись уже изменилась. Обновите карточку и проверьте актуальные данные перед повторным подтверждением.",
      429: "Слишком много запросов. Подождите немного перед повтором.",
      503: "Сервис временно недоступен. Попробуйте позже.",
    };
    throw new WorkspaceError(response.status, codes[failure?.code ?? ""] ?? messages[response.status] ?? "Не удалось выполнить действие. Попробуйте позже.", failure?.code);
  }
  try { return await response.json() as T; }
  catch { throw new WorkspaceError(0, "Не удалось прочитать ответ сервера. Повторите запрос."); }
}

export function useWorkspaceAuth() {
  const [auth, setAuth] = useState<{ actor: ReferralActor | null; enabled: boolean } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    workspaceRequest<{ actor: ReferralActor | null; enabled: boolean }>("/api/workspace/auth")
      .then((value) => { if (active) setAuth(value); })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, []);
  return { auth, setAuth, error };
}

// Keep one key for an unchanged intent after a lost response; discard only
// after success. A changed form/revision represents a new human decision.
export function useWorkspaceCommand() {
  const pending = useRef(new Map<string, string>());
  return async function command<T>(url: string, body: object): Promise<T> {
    const signature = JSON.stringify([url, body]);
    if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
    const result = await workspaceRequest<T>(url, { ...body, idempotencyKey: pending.current.get(signature) });
    pending.current.delete(signature);
    return result;
  };
}

export const FLOW_LABELS: Record<ReferralFlow, string> = {
  interviewed: "Опрос завершён", specialist_referred: "К узкому специалисту",
  preparing: "Подготовка", ready: "Пакет готов", sent: "Направление отправлено",
  waiting: "В листе ожидания", scheduled: "Дата назначена", attended: "Явка подтверждена",
  not_attended: "Неявка подтверждена", cancelled: "Отменено",
};
export const ROLE_LABELS = { owner: "Руководитель", doctor: "Врач", analyst: "Аналитик" };
export const COMPLETENESS_LABELS = { complete: "Комплектен", incomplete: "Не комплектен", expired: "Есть истёкшие сроки", unknown: "Не проверено" };
export const EXAM_LABELS = { present: "Есть", missing: "Отсутствует", expired: "Срок истёк", unknown: "Не проверено", not_applicable: "Не требуется" };
export function calendarDate(value: string | null) { return value ? value.split("-").reverse().join(".") : "Не указана"; }
export function exceedsOperationalDelay(days: number | null, threshold: string): boolean {
  const chosen = Number(threshold);
  return days !== null && Number.isFinite(days) && threshold.trim() !== "" && Number.isFinite(chosen) && chosen >= 0 && days > chosen;
}
export function observedDaysLabel(days: number | null): string {
  return days === null ? "Время на этапе неизвестно" : `На этапе ${days.toFixed(1)} дн. по записям кабинета`;
}
export function timestamp(value: number | null) { return value === null ? "Время события неизвестно" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" }).format(value); }
