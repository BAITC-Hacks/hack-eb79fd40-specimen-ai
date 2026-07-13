import { NextRequest, NextResponse } from "next/server";
import { getSession, completeSession } from "@/lib/store";
import { runAnamnesisTurn } from "@/lib/anamnesis";
import { analyze } from "@/lib/triage";
import { notifyDoctor } from "@/lib/hermes";

// Ход диалога пациента. Когда анамнез собран — запускаем аналитический слой
// и уведомляем врача.
export async function POST(req: NextRequest) {
  const { sessionId, message } = await req.json();
  const session = sessionId ? getSession(sessionId) : undefined;
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  session.messages.push({ role: "user", content: message });
  const { reply, done } = await runAnamnesisTurn(session.messages);
  session.messages.push({ role: "assistant", content: reply });

  if (!done) {
    return NextResponse.json({ reply, done: false });
  }

  // Анамнез собран — аналитический слой + доставка врачу.
  const result = await analyze(session.messages);
  completeSession(session.id, result);
  await notifyDoctor(session, result);

  return NextResponse.json({ reply, done: true, result });
}
