import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { greetingForLanguage } from "@/lib/anamnesis";
import { HARD_TURN_CAP } from "@/lib/config";
import type { SessionStore } from "@/lib/store";
import type { Session } from "@/lib/types";

export async function handleChatStart(
  req: NextRequest,
  sessionStore: SessionStore,
) {
  const requestId = randomUUID();

  try {
    const body: unknown = await req.json();
    const token =
      typeof body === "object" && body !== null && "token" in body
        ? (body as { token?: unknown }).token
        : undefined;
    const requestedLanguage =
      typeof body === "object" && body !== null && "language" in body
        ? (body as { language?: unknown }).language
        : undefined;

    if (typeof token !== "string" || !/^[0-9a-f]{16}$/.test(token)) {
      return NextResponse.json(
        {
          error: "Требуется корректная ссылка врача",
          code: "TOKEN_REQUIRED",
          request_id: requestId,
        },
        { status: 400 },
      );
    }

    if (
      requestedLanguage !== undefined &&
      requestedLanguage !== "ru" &&
      requestedLanguage !== "kk"
    ) {
      return NextResponse.json(
        {
          error: "Некорректный язык сессии",
          code: "BAD_REQUEST",
          request_id: requestId,
        },
        { status: 400 },
      );
    }
    const language: Session["language"] = requestedLanguage ?? "ru";

    if (!(await sessionStore.isValidDoctorToken(token))) {
      return NextResponse.json(
        {
          error: "Ссылка недействительна или устарела",
          code: "TOKEN_NOT_FOUND",
          request_id: requestId,
        },
        { status: 404 },
      );
    }

    if (!sessionStore.createSessionOnce) throw new Error("Session store cannot consume personal links");
    const session = await sessionStore.createSessionOnce(token, language);
    if (!session) {
      return NextResponse.json(
        {
          error: "Ссылка уже использована",
          code: "LINK_ALREADY_USED",
          request_id: requestId,
        },
        { status: 409 },
      );
    }
    const greeting = greetingForLanguage(session.language);
    await sessionStore.appendMessage(session.id, {
      role: "assistant",
      content: greeting,
    });
    return NextResponse.json({
      sessionId: session.id,
      reply: greeting,
      turnsLeft: HARD_TURN_CAP,
    });
  } catch {
    return NextResponse.json(
      {
        error: "Внутренняя ошибка",
        code: "INTERNAL",
        request_id: requestId,
      },
      { status: 500 },
    );
  }
}
