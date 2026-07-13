import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/store";
import { greeting } from "@/lib/anamnesis";

// Пациент открыл ссылку врача → создаём сессию и отдаём приветствие.
export async function POST(req: NextRequest) {
  const { token } = await req.json();
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }
  const session = createSession(token);
  const text = await greeting();
  session.messages.push({ role: "assistant", content: text });
  return NextResponse.json({ sessionId: session.id, reply: text });
}
