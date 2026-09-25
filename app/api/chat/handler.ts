import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  completionReplyForLanguage,
  emergencyReplyForLanguage,
  runAnamnesisTurn,
  type TurnResult,
} from "@/lib/anamnesis";
import { HARD_TURN_CAP, MAX_MESSAGE_LEN } from "@/lib/config";
import { runDeterministicAnamnesisTurn } from "@/lib/deterministic";
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
import {
  PROCESSING_MODE,
  type ProcessingMode,
} from "@/lib/processing-mode";
import { patientClosing } from "@/lib/patient-response";
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
  processingMode?: ProcessingMode;
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

const HARD_CAP_REPLY: Record<Session["language"], string> = {
  ru: "Спасибо, этого достаточно — передаю данные врачу.",
  kk: "Жеткілікті мәлімет жиналды. Рақмет!",
};

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
      processingMode: deps.processingMode,
    });
    const completed = await deps.sessionStore.getSession(sessionId);
    if (!completed) {
      return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
    }
    return NextResponse.json({
      reply,
      done: true,
      turnsLeft: 0,
      closing: patientClosing(result, completed.language),
    });
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
      completionReplyForLanguage(session.language),
      requestId,
      deps,
    );
  }

  const userMessage: ChatMessage = {
    role: "user",
    content: message.trim(),
  };

  const pendingUser = session.messages.at(-1)?.role === "user"
    ? session.messages.at(-1)
    : undefined;
  if (pendingUser && pendingUser.content !== userMessage.content) {
    return apiError(
      409,
      "TURN_PENDING",
      "Предыдущая реплика ещё обрабатывается",
      requestId,
    );
  }

  let afterUser = session;
  if (!pendingUser) {
    // Persist the patient's words before any external call. Emergency rules
    // and doctor delivery must survive an unavailable dialogue model.
    try {
      await deps.sessionStore.appendMessage(session.id, userMessage);
      const persisted = await deps.sessionStore.getSession(session.id);
      if (!persisted) {
        return apiError(500, "INTERNAL", "Внутренняя ошибка", requestId);
      }
      afterUser = persisted;
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
  }

  const candidate = [...afterUser.messages];
  const processingMode = deps.processingMode ?? PROCESSING_MODE;
  const forcedByRule = detectRedFlags(candidate).some(
    (flag) => flag.emergency,
  );
  let turn: TurnResult;
  if (forcedByRule) {
    turn = { reply: emergencyReplyForLanguage(session.language), done: true };
  } else {
    try {
      turn = processingMode === "deterministic"
        ? runDeterministicAnamnesisTurn(candidate, session.language)
        : deps.runTurn
          ? await deps.runTurn(candidate, session.language)
          : await runAnamnesisTurn(candidate, {}, session.language);
    } catch {
      return apiError(
        500,
        processingMode === "deterministic" ? "INTERNAL" : "LLM_UNAVAILABLE",
        "Сервис временно недоступен, попробуйте ещё раз",
        requestId,
      );
    }
  }

  const forcedByCap = afterUser.turnCount >= HARD_TURN_CAP;
  const reply = forcedByRule
    ? emergencyReplyForLanguage(session.language)
    : forcedByCap && !turn.done
      ? HARD_CAP_REPLY[session.language]
      : turn.done
        ? completionReplyForLanguage(session.language)
        : turn.reply;

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
