import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { withSessionSweep } from "./session-operations";
import { FileSessionStore } from "./storage/session-store";
import { RETENTION_MS, SESSION_TTL_MS, TOKEN_TTL_MS } from "./config";
import { workspaceNotifierFromEnv } from "./workspace-notifier";
import type {
  ChatMessage,
  ReadonlySession,
  Session,
  TriageResult,
} from "./types";

export interface SessionStore {
  createDoctorToken(): Promise<string>;
  isValidDoctorToken(token: string): Promise<boolean>;
  createSession(
    doctorToken: string,
    language?: Session["language"],
  ): Promise<Session>;
  createSessionOnce?(
    doctorToken: string,
    language?: Session["language"],
  ): Promise<Session | undefined>;
  getSession(id: string): Promise<ReadonlySession | undefined>;
  appendMessage(id: string, message: ChatMessage): Promise<void>;
  completeSession(id: string, result: TriageResult): Promise<void>;
  abortSession(id: string, reason: string): Promise<void>;
  sweepExpired(now: number): Promise<number>;
  markNotified(id: string, status: "sent" | "failed"): Promise<void>;
}

export interface AbortedSessionNotice {
  sessionId: string;
  doctorToken: string;
  startedAt: number;
  abortedAt: number;
  reason: string;
}

export interface AbortedNoticePort {
  sendAbortedNotice(notice: AbortedSessionNotice): Promise<void>;
}

export class SessionNotFoundError extends Error {
  readonly code = "session_not_found" as const;

  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionNotCollectingError extends Error {
  readonly code = "session_not_collecting" as const;

  constructor(id: string) {
    super(`Session is not collecting: ${id}`);
    this.name = "SessionNotCollectingError";
  }
}

interface MemorySessionStoreOptions {
  sessions?: Map<string, Session>;
  doctors?: Map<string, number>;
  consumedDoctorTokens?: Set<string>;
  now?: () => number;
  abortedNotice?: AbortedNoticePort;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions: Map<string, Session>;
  private readonly doctors: Map<string, number>;
  private readonly consumedDoctorTokens: Set<string>;
  private readonly now: () => number;
  private readonly abortedNotice?: AbortedNoticePort;

  constructor(options: MemorySessionStoreOptions = {}) {
    this.sessions = options.sessions ?? new Map();
    this.doctors = options.doctors ?? new Map();
    this.consumedDoctorTokens = options.consumedDoctorTokens ?? new Set();
    this.now = options.now ?? Date.now;
    this.abortedNotice = options.abortedNotice;
  }

  async createDoctorToken(): Promise<string> {
    const token = randomUUID().replaceAll("-", "").slice(0, 16);
    this.doctors.set(token, this.now());
    return token;
  }

  async isValidDoctorToken(token: string): Promise<boolean> {
    const createdAt = this.doctors.get(token);
    if (createdAt === undefined) return false;
    if (this.now() - createdAt <= TOKEN_TTL_MS) return true;

    this.doctors.delete(token);
    this.consumedDoctorTokens.delete(token);
    for (const [id, session] of this.sessions) {
      if (session.doctorToken === token) this.sessions.delete(id);
    }
    return false;
  }

  async createSession(
    doctorToken: string,
    language: Session["language"] = "ru",
  ): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      doctorToken,
      language,
      messages: [],
      status: "collecting",
      turnCount: 0,
      deliveryStatus: "pending",
      createdAt: this.now(),
    };
    this.sessions.set(session.id, structuredClone(session));
    return structuredClone(session);
  }

  async createSessionOnce(
    doctorToken: string,
    language: Session["language"] = "ru",
  ): Promise<Session | undefined> {
    if (this.consumedDoctorTokens.has(doctorToken)) return undefined;
    if ([...this.sessions.values()].some((session) => session.doctorToken === doctorToken)) {
      // Lazy migration for snapshots written before consumption was persisted.
      this.consumedDoctorTokens.add(doctorToken);
      return undefined;
    }
    // Mark before the first await: concurrent starts in one process cannot both
    // consume the same personal link.
    this.consumedDoctorTokens.add(doctorToken);
    return this.createSession(doctorToken, language);
  }

  async getSession(id: string): Promise<ReadonlySession | undefined> {
    const session = this.sessions.get(id);
    return session
      ? (structuredClone(session) as ReadonlySession)
      : undefined;
  }

  async listSessions(): Promise<ReadonlySession[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }

  async appendMessage(id: string, message: ChatMessage): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    if (session.status !== "collecting") {
      throw new SessionNotCollectingError(id);
    }

    session.messages = [...session.messages, structuredClone(message)];
    if (message.role === "user") session.turnCount += 1;
  }

  async completeSession(id: string, result: TriageResult): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    if (session.status !== "collecting") {
      throw new SessionNotCollectingError(id);
    }

    session.status = "completed";
    session.result = structuredClone(result);
    session.completedAt = this.now();
  }

  async abortSession(id: string, reason: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.status !== "collecting") return;

    if (session.turnCount === 0) {
      this.sessions.delete(id);
      return;
    }

    const abortedAt = this.now();
    session.status = "aborted";
    session.completedAt = abortedAt;

    if (!this.abortedNotice) return;

    const notice: AbortedSessionNotice = {
      sessionId: session.id,
      doctorToken: session.doctorToken,
      startedAt: session.createdAt,
      abortedAt,
      reason,
    };

    try {
      await this.abortedNotice.sendAbortedNotice(structuredClone(notice));
      await this.markNotified(id, "sent");
    } catch {
      await this.markNotified(id, "failed");
    }
  }

  async sweepExpired(now: number): Promise<number> {
    let aborted = 0;

    for (const [id, session] of this.sessions) {
      if (session.status === "collecting") {
        if (now - session.createdAt > SESSION_TTL_MS) {
          const shouldBecomeAborted = session.turnCount > 0;
          await this.abortSession(id, "ttl_expired");
          if (shouldBecomeAborted) aborted += 1;
        }
        continue;
      }

      const terminalAt = session.completedAt ?? session.createdAt;
      if (now - terminalAt > RETENTION_MS) this.sessions.delete(id);
    }

    for (const [token, createdAt] of this.doctors) {
      if (now - createdAt <= TOKEN_TTL_MS) continue;
      this.doctors.delete(token);
      this.consumedDoctorTokens.delete(token);
      for (const [id, session] of this.sessions) {
        if (session.doctorToken === token) this.sessions.delete(id);
      }
    }

    return aborted;
  }

  async markNotified(
    id: string,
    status: "sent" | "failed",
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    session.deliveryStatus = status;
    session.notifiedAt = this.now();
  }
}

const globals = globalThis as unknown as {
  __demeuSessionsV2?: Map<string, Session>;
  __demeuDoctorTokens?: Map<string, number>;
  __demeuSessionStore?: SessionStore & { listSessions(): Promise<ReadonlySession[]> };
  __demeuSessionStoreLocation?: string | null;
  __demeuSweepTimer?: ReturnType<typeof setInterval>;
};

const singletonSessions = (globals.__demeuSessionsV2 ??= new Map());
const singletonDoctors = (globals.__demeuDoctorTokens ??= new Map());

export function store(): SessionStore & { listSessions(): Promise<ReadonlySession[]> } {
  const location = process.env.DEMEU_DATA_DIR ? resolve(process.env.DEMEU_DATA_DIR) : null;
  if (globals.__demeuSessionStore && globals.__demeuSessionStoreLocation !== location) {
    throw new Error("Session storage configuration changed; restart required");
  }
  if (!globals.__demeuSessionStore) {
    globals.__demeuSessionStore = location !== null
      ? new FileSessionStore({
          path: join(location, "sessions.json"),
          abortedNotice: workspaceNotifierFromEnv(),
        })
      : new MemorySessionStore({
      sessions: singletonSessions,
      doctors: singletonDoctors,
      abortedNotice: workspaceNotifierFromEnv(),
    });
    globals.__demeuSessionStoreLocation = location;
  }

  if (!globals.__demeuSweepTimer) {
    globals.__demeuSweepTimer = setInterval(() => {
      void withSessionSweep(async () => store().sweepExpired(Date.now())).catch(() => {
        console.error("Session sweep failed");
      });
    }, 5 * 60_000);
    globals.__demeuSweepTimer.unref?.();
  }

  return globals.__demeuSessionStore;
}
