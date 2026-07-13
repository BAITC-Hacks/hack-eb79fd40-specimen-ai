import { randomUUID } from "node:crypto";
import type { Session, TriageResult } from "./types";

// In-memory хранилище сессий (достаточно для демо/прототипа).
// Для прод-версии — заменить на БД. Держим на globalThis, чтобы переживать
// hot-reload в dev.
const g = globalThis as unknown as {
  __demeuSessions?: Map<string, Session>;
  __demeuDoctors?: Set<string>;
};
const sessions = (g.__demeuSessions ??= new Map<string, Session>());
const doctors = (g.__demeuDoctors ??= new Set<string>());

// Врач генерирует персональную ссылку (token). MVP: без аутентификации.
export function createDoctorToken(): string {
  const token = randomUUID().slice(0, 8);
  doctors.add(token);
  return token;
}

export function createSession(doctorToken: string): Session {
  const s: Session = {
    id: randomUUID(),
    doctorToken,
    language: "ru",
    messages: [],
    status: "collecting",
    createdAt: Date.now(),
  };
  sessions.set(s.id, s);
  return s;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function completeSession(id: string, result: TriageResult): void {
  const s = sessions.get(id);
  if (s) {
    s.status = "completed";
    s.result = result;
  }
}
