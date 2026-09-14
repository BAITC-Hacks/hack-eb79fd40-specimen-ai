import { isTriageResult } from "../http";
import { SESSION_TTL_MS } from "../config";
import {
  MemorySessionStore,
  type AbortedNoticePort,
  type AbortedSessionNotice,
  type SessionStore,
} from "../store";
import type { ChatMessage, ReadonlySession, Session, TriageResult } from "../types";
import { FileState } from "./file-state";

interface SessionSnapshot {
  schema_version: 1;
  doctors: [string, number][];
  sessions: Session[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function validSession(value: unknown): value is Session {
  if (
    !record(value) || !text(value.id) || !text(value.doctorToken) ||
    !["ru", "kk"].includes(String(value.language)) ||
    !["collecting", "completed", "aborted"].includes(String(value.status)) ||
    !["pending", "sent", "failed"].includes(String(value.deliveryStatus)) ||
    !timestamp(value.createdAt) ||
    (value.notifiedAt !== undefined && !timestamp(value.notifiedAt)) ||
    !Array.isArray(value.messages) ||
    !value.messages.every((message) => record(message) &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string") ||
    value.turnCount !== value.messages.filter((message) => message.role === "user").length
  ) return false;
  if (value.status === "collecting") {
    if (value.completedAt !== undefined || value.result !== undefined) return false;
  } else if (!timestamp(value.completedAt)) return false;
  if (value.status === "completed") {
    if (!isTriageResult(value.result)) return false;
    for (const flag of value.result.red_flags) {
      if (flag.evidence_kind === "derived") {
        if (flag.source_message_index !== -1) return false;
      } else {
        const source = value.messages[flag.source_message_index];
        if (!source || source.role !== "user" || !source.content.includes(flag.evidence)) return false;
      }
    }
  } else if (value.result !== undefined) return false;
  return true;
}

function validateSnapshot(value: unknown): SessionSnapshot {
  if (
    !record(value) || value.schema_version !== 1 ||
    !Array.isArray(value.doctors) || !Array.isArray(value.sessions) ||
    !value.doctors.every((entry) => Array.isArray(entry) && entry.length === 2 &&
      text(entry[0]) && timestamp(entry[1])) ||
    !value.sessions.every(validSession)
  ) throw new Error("Invalid session snapshot");
  const tokens = value.doctors.map(([token]) => token);
  const ids = value.sessions.map((session) => session.id);
  if (new Set(tokens).size !== tokens.length || new Set(ids).size !== ids.length ||
      value.sessions.some((session) => !tokens.includes(session.doctorToken))) {
    throw new Error("Invalid session snapshot references");
  }
  return value as unknown as SessionSnapshot;
}

export interface FileSessionStoreOptions {
  path: string;
  now?: () => number;
  abortedNotice?: AbortedNoticePort;
  maxBytes?: number;
}

export class FileSessionStore implements SessionStore {
  private readonly state: FileState<SessionSnapshot>;
  private readonly now: () => number;

  constructor(private readonly options: FileSessionStoreOptions) {
    this.now = options.now ?? Date.now;
    this.state = new FileState({
      path: options.path,
      initial: () => ({ schema_version: 1, doctors: [], sessions: [] }),
      validate: validateSnapshot,
      maxBytes: options.maxBytes,
    });
  }

  private mutate<R>(fn: (store: MemorySessionStore) => Promise<R>): Promise<R> {
    return this.state.transaction(async (draft) => {
      const doctors = new Map(draft.doctors);
      const sessions = new Map(draft.sessions.map((session) => [session.id, session]));
      // Reuse the canonical semantics, with no notifier/external side effects.
      const memory = new MemorySessionStore({ doctors, sessions, now: this.now });
      const result = await fn(memory);
      draft.doctors = [...doctors.entries()];
      draft.sessions = [...sessions.values()];
      return result;
    });
  }

  createDoctorToken(): Promise<string> {
    return this.mutate((memory) => memory.createDoctorToken());
  }
  isValidDoctorToken(token: string): Promise<boolean> {
    return this.mutate((memory) => memory.isValidDoctorToken(token));
  }
  createSession(token: string, language: Session["language"] = "ru"): Promise<Session> {
    return this.mutate((memory) => memory.createSession(token, language));
  }
  getSession(id: string): Promise<ReadonlySession | undefined> {
    return this.state.read((snapshot) => snapshot.sessions.find((session) => session.id === id));
  }
  listSessions(): Promise<ReadonlySession[]> {
    return this.state.read((snapshot) => [...snapshot.sessions]);
  }
  appendMessage(id: string, message: ChatMessage): Promise<void> {
    return this.mutate((memory) => memory.appendMessage(id, message));
  }
  completeSession(id: string, result: TriageResult): Promise<void> {
    return this.mutate((memory) => memory.completeSession(id, result));
  }
  markNotified(id: string, status: "sent" | "failed"): Promise<void> {
    return this.mutate((memory) => memory.markNotified(id, status));
  }

  private async deliver(notices: AbortedSessionNotice[]): Promise<void> {
    if (!this.options.abortedNotice) return;
    for (const notice of notices) {
      let status: "sent" | "failed" = "sent";
      try {
        await this.options.abortedNotice.sendAbortedNotice(notice);
      } catch {
        status = "failed";
      }
      // Token retention may remove the session in the same sweep. The notice
      // still represents an actual started interview, but no row remains to mark.
      if (await this.getSession(notice.sessionId)) {
        await this.markNotified(notice.sessionId, status);
      }
    }
  }

  async abortSession(id: string, reason: string): Promise<void> {
    const notice = await this.mutate(async (memory) => {
      const before = await memory.getSession(id);
      await memory.abortSession(id, reason);
      const after = await memory.getSession(id);
      return before?.status === "collecting" && after?.status === "aborted"
        ? { sessionId: id, doctorToken: after.doctorToken, startedAt: after.createdAt,
            abortedAt: after.completedAt!, reason }
        : undefined;
    });
    if (notice) await this.deliver([notice]);
  }

  async sweepExpired(now: number): Promise<number> {
    const outcome = await this.mutate(async (memory) => {
      const before = await memory.listSessions();
      const count = await memory.sweepExpired(now);
      const notices: AbortedSessionNotice[] = [];
      for (const session of before) {
        if (session.status !== "collecting") continue;
        const after = await memory.getSession(session.id);
        if (session.turnCount > 0 && now - session.createdAt > SESSION_TTL_MS) {
          notices.push({ sessionId: session.id, doctorToken: session.doctorToken,
            startedAt: session.createdAt, abortedAt: after?.completedAt ?? this.now(), reason: "ttl_expired" });
        }
      }
      return { count, notices };
    });
    await this.deliver(outcome.notices);
    return outcome.count;
  }

  close(): Promise<void> {
    return this.state.close();
  }
}
