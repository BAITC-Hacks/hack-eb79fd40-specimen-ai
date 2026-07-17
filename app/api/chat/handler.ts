import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  runAnamnesisTurn,
  type TurnResult,
} from "@/lib/anamnesis";
import { HARD_TURN_CAP, MAX_MESSAGE_LEN } from "@/lib/config";
import {
  finalizeSession,
  type AnalyzePort,
  type BackgroundScheduler,
  type DoctorSummaryPort,
} from "@/lib/finalize";
import {
  SessionNotCollectingError,
  SessionNotFoundError,
  type SessionStore,
} from "@/lib/store";
import { detectRedFlags } from "@/lib/redflags";
import type { ChatMessage, Session } from "@/lib/types";

type RunTurnPort = (
  messages: ChatMessage[],
  language: Session["language"],
) => Promise<TurnResult>;

export interface ChatRouteDeps {
  sessionStore: SessionStore;
  runTurn?: RunTurnPort;
  analyze?: AnalyzePort;
  doctorSummary?: DoctorSummaryPort;
  schedule?: BackgroundScheduler;
}

function apiError(
  status: number,
  code: string,
  error: string,
  requestId: string,
) {
  return NextResponse.json(
    { error, code, request_id: requestId },
    { status },
  );
}

const COMPLETION_REPLY: Record<Session["language"], string> = {
  ru: "Спасибо, я передаю данные врачу.",
  kk: "Рақмет, жауаптарыңыз дәрігерге жіберілді.",
};

const HARD_CAP_REPLY: Record<Session["language"], string> = {
  ru: "Спасибо, этого достаточно — передаю данные врачу.",
  kk: "Жеткілікті мәлімет жиналды. Рақмет!",
};

function lastAssistantReply(
  messages: readonly ChatMessage[],
  language: Session["language"],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return messages[index].content;
  }
  return COMPLETION_REPLY[language];
}

async function finalizedChatResponse(
  sessionId: string,
  reply: string,
  requestId: string,
  deps: ChatRouteDeps,
) {
  try {
    const { result } = await finalizeSession(sessionId, {
      sessionStore: deps.sessionStore,
      analyze: deps.analyze,
      doctorSummary: deps.doctorSummary,
      schedule: deps.schedule,
    });
    return NextResponse.json({ reply, done: true, turnsLeft: 0, result });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
    }
    return apiError(
      500,
      "ANALYZE_FAILED",
      "Не удалось сформировать сводку",
      requestId,
    );
  }
}

export async function handleChat(req: NextRequest, deps: ChatRouteDeps) {
  const requestId = randomUUID();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Некорректный запрос", requestId);
  }

  const sessionId =
    typeof body === "object" && body !== null && "sessionId" in body
      ? (body as { sessionId?: unknown }).sessionId
      : undefined;
  const message =
    typeof body === "object" && body !== null && "message" in body
      ? (body as { message?: unknown }).message
      : undefined;

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return apiError(
      400,
      "SESSION_ID_REQUIRED",
      "Требуется идентификатор сессии",
      requestId,
    );
  }
  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > MAX_MESSAGE_LEN
  ) {
    return apiError(
      400,
      "MESSAGE_REQUIRED",
      "Требуется корректная реплика пациента",
      requestId,
    );
  }

  let session;
  try {
    session = await deps.sessionStore.getSession(sessionId);
  } catch {
    return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
  }
  if (!session) {
    return apiError(
      404,
      "SESSION_NOT_FOUND",
      "Сессия не найдена",
      requestId,
    );
  }
  if (session.status !== "collecting") {
    return apiError(
      409,
      "SESSION_COMPLETED",
      "Сессия уже завершена",
      requestId,
    );
  }
  if (session.turnCount >= HARD_TURN_CAP) {
    return finalizedChatResponse(
      session.id,
      lastAssistantReply(session.messages, session.language),
      requestId,
      deps,
    );
  }

  const userMessage: ChatMessage = {
    role: "user",
    content: message.trim(),
  };
  const candidate = [...session.messages, userMessage];
  let turn: TurnResult;
  try {
    turn = deps.runTurn
      ? await deps.runTurn(candidate, session.language)
      : await runAnamnesisTurn(candidate, {}, session.language);
  } catch {
    return apiError(
      500,
      "LLM_UNAVAILABLE",
      "Сервис временно недоступен, попробуйте ещё раз",
      requestId,
    );
  }

  const forcedByCap = session.turnCount + 1 >= HARD_TURN_CAP;
  const forcedByRule = detectRedFlags(candidate).some(
    (flag) => flag.emergency,
  );
  const reply =
    forcedByCap && !turn.done
      ? `${turn.reply}\n\n${HARD_CAP_REPLY[session.language]}`.trim()
      : turn.reply;

  try {
    await deps.sessionStore.appendMessage(session.id, userMessage);
  } catch (error) {
    if (error instanceof SessionNotCollectingError) {
      return apiError(
        409,
        "SESSION_COMPLETED",
        "Сессия уже завершена",
        requestId,
      );
    }
    return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
  }

  try {
    await deps.sessionStore.appendMessage(session.id, {
      role: "assistant",
      content: reply,
    });
  } catch (error) {
    if (error instanceof SessionNotCollectingError) {
      return apiError(
        409,
        "SESSION_COMPLETED",
        "Сессия уже завершена",
        requestId,
      );
    }
    try {
      await deps.sessionStore.abortSession(
        session.id,
        "assistant_append_failed",
      );
    } catch {
      return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
    }
    return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
  }

  let updated;
  try {
    updated = await deps.sessionStore.getSession(session.id);
  } catch {
    return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
  }
  if (!updated) {
    return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
  }

  const turnsLeft = Math.max(0, HARD_TURN_CAP - updated.turnCount);
  if (!turn.done && !forcedByRule && updated.turnCount < HARD_TURN_CAP) {
    return NextResponse.json({ reply, done: false, turnsLeft });
  }

  return finalizedChatResponse(session.id, reply, requestId, deps);
}
