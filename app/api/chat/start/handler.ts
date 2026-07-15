import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GREETING_RU } from "@/lib/anamnesis";
import { HARD_TURN_CAP } from "@/lib/config";
import type { SessionStore } from "@/lib/store";

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

    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "assistant",
      content: GREETING_RU,
    });
    return NextResponse.json({
      sessionId: session.id,
      reply: GREETING_RU,
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
