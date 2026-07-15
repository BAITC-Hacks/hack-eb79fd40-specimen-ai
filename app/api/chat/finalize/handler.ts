import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  finalizeSession,
  NothingToAnalyzeError,
  type AnalyzePort,
  type BackgroundScheduler,
  type DoctorSummaryPort,
} from "@/lib/finalize";
import {
  SessionNotCollectingError,
  SessionNotFoundError,
  type SessionStore,
} from "@/lib/store";

export interface FinalizeRouteDeps {
  sessionStore: SessionStore;
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

export async function handleFinalize(
  req: NextRequest,
  deps: FinalizeRouteDeps,
) {
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
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return apiError(
      400,
      "SESSION_ID_REQUIRED",
      "Требуется идентификатор сессии",
      requestId,
    );
  }

  try {
    const { result, replayed } = await finalizeSession(sessionId, {
      sessionStore: deps.sessionStore,
      analyze: deps.analyze,
      doctorSummary: deps.doctorSummary,
      schedule: deps.schedule,
    });
    return NextResponse.json({
      result,
      source: result.source,
      replayed,
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return apiError(
        404,
        "SESSION_NOT_FOUND",
        "Сессия не найдена",
        requestId,
      );
    }
    if (error instanceof SessionNotCollectingError) {
      return apiError(
        409,
        "SESSION_COMPLETED",
        "Сессия уже завершена",
        requestId,
      );
    }
    if (error instanceof NothingToAnalyzeError) {
      return apiError(
        400,
        "BAD_REQUEST",
        "Нет реплик пациента для анализа",
        requestId,
      );
    }
    return apiError(
      500,
      "ANALYZE_FAILED",
      "Не удалось сформировать сводку",
      requestId,
    );
  }
}
