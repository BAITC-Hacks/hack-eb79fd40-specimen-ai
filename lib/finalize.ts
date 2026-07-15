import { after } from "next/server";
import { analyze as analyzeResult } from "./triage";
import { telegramNotifierFromEnv } from "./telegram";
import {
  SessionNotCollectingError,
  SessionNotFoundError,
  store,
  type SessionStore,
} from "./store";
import type {
  ChatMessage,
  ReadonlySession,
  TriageResult,
} from "./types";

export type AnalyzePort = (messages: ChatMessage[]) => Promise<TriageResult>;

export interface DoctorSummaryPort {
  sendDoctorSummary(
    session: ReadonlySession,
    result: TriageResult,
  ): Promise<void>;
}

export type BackgroundScheduler = (work: () => Promise<void>) => void;

export interface FinalizeDeps {
  sessionStore?: SessionStore;
  analyze?: AnalyzePort;
  doctorSummary?: DoctorSummaryPort;
  schedule?: BackgroundScheduler;
}

export interface FinalizeOutcome {
  result: TriageResult;
  replayed: boolean;
}

export class NothingToAnalyzeError extends Error {
  constructor(id: string) {
    super(`Session has no patient messages: ${id}`);
    this.name = "NothingToAnalyzeError";
  }
}

const inFlightByStore = new WeakMap<
  SessionStore,
  Map<string, Promise<FinalizeOutcome>>
>();

const unconfiguredDoctorSummary: DoctorSummaryPort = {
  async sendDoctorSummary(): Promise<void> {
    throw new Error("Telegram delivery is not configured");
  },
};

async function finalizeOnce(
  id: string,
  sessionStore: SessionStore,
  analyze: AnalyzePort,
  doctorSummary?: DoctorSummaryPort,
  schedule: BackgroundScheduler = (work) => after(work),
): Promise<FinalizeOutcome> {
  const session = await sessionStore.getSession(id);
  if (!session) throw new SessionNotFoundError(id);

  if (session.status === "completed") {
    if (!session.result) {
      throw new Error(`Completed session has no result: ${id}`);
    }
    return { result: session.result, replayed: true };
  }
  if (session.status !== "collecting") {
    throw new SessionNotCollectingError(id);
  }
  if (!session.messages.some((message) => message.role === "user")) {
    throw new NothingToAnalyzeError(id);
  }

  const result = await analyze([...session.messages]);

  try {
    await sessionStore.completeSession(id, result);
    if (doctorSummary) {
      try {
        schedule(async () => {
          try {
            await doctorSummary.sendDoctorSummary(session, result);
            await sessionStore.markNotified(id, "sent");
          } catch {
            await sessionStore.markNotified(id, "failed");
          }
        });
      } catch {
        await sessionStore.markNotified(id, "failed");
      }
    }
    return { result, replayed: false };
  } catch (error) {
    if (!(error instanceof SessionNotCollectingError)) throw error;

    const latest = await sessionStore.getSession(id);
    if (latest?.status === "completed" && latest.result) {
      return { result: latest.result, replayed: true };
    }
    throw error;
  }
}

export async function finalizeSession(
  id: string,
  deps: FinalizeDeps = {},
): Promise<FinalizeOutcome> {
  const sessionStore = deps.sessionStore ?? store();
  const analyze = deps.analyze ?? analyzeResult;
  const doctorSummary =
    deps.doctorSummary ??
    telegramNotifierFromEnv() ??
    unconfiguredDoctorSummary;
  let inFlight = inFlightByStore.get(sessionStore);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByStore.set(sessionStore, inFlight);
  }

  const existing = inFlight.get(id);
  if (existing) return existing;

  const operation = finalizeOnce(
    id,
    sessionStore,
    analyze,
    doctorSummary,
    deps.schedule,
  );
  inFlight.set(id, operation);
  try {
    return await operation;
  } finally {
    inFlight.delete(id);
  }
}
