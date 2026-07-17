import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleChat } from "../../app/api/chat/handler";
import { handleChatStart } from "../../app/api/chat/start/handler";
import {
  GREETING_KK,
  GREETING_RU,
  runAnamnesisTurn,
  type ChatTurnPort,
} from "../../lib/anamnesis";
import { MemorySessionStore } from "../../lib/store";

function startRequest(token: string): NextRequest {
  return new NextRequest("http://localhost/api/chat/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

function chatRequest(sessionId: string, message: string): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
}

describe("start and first Anthropic turn", () => {
  it("keeps the greeting in the transcript but sends a user-first payload", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const startResponse = await handleChatStart(
      startRequest(token),
      sessionStore,
    );
    const startBody = (await startResponse.json()) as { sessionId: string };
    const patientText = "Голова болит со вчера";
    const chatTurn = vi.fn<ChatTurnPort>(async () =>
      Promise.resolve("Насколько сильная боль?"),
    );

    const chatResponse = await handleChat(
      chatRequest(startBody.sessionId, patientText),
      {
        sessionStore,
        runTurn: (messages) => runAnamnesisTurn(messages, { chatTurn }),
      },
    );

    expect(startResponse.status).toBe(200);
    expect(chatResponse.status).toBe(200);
    expect(chatTurn).toHaveBeenCalledOnce();
    const [, apiMessages] = chatTurn.mock.calls[0];
    expect(apiMessages).toEqual([
      { role: "user", content: patientText },
    ]);
    expect(apiMessages[0]).toEqual({ role: "user", content: patientText });
    expect(await sessionStore.getSession(startBody.sessionId)).toMatchObject({
      messages: [
        { role: "assistant", content: GREETING_RU },
        { role: "user", content: patientText },
        { role: "assistant", content: "Насколько сильная боль?" },
      ],
    });
  });

  it("keeps Kazakh session language at the first Anthropic boundary", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const startResponse = await handleChatStart(
      new NextRequest("http://localhost/api/chat/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, language: "kk" }),
      }),
      sessionStore,
    );
    const startBody = (await startResponse.json()) as { sessionId: string };
    const patientText =
      "Проверяю, что язык сессии не меняется по тексту пациента";
    const chatTurn = vi.fn<ChatTurnPort>(async () =>
      Promise.resolve("Ауырсыну қаншалықты қатты?"),
    );

    const chatResponse = await handleChat(
      chatRequest(startBody.sessionId, patientText),
      {
        sessionStore,
        runTurn: (messages, language) =>
          runAnamnesisTurn(messages, { chatTurn }, language),
      },
    );

    expect(chatResponse.status).toBe(200);
    const [system, apiMessages] = chatTurn.mock.calls[0];
    expect(system).toContain(`«${GREETING_KK}»`);
    expect(system).toContain("Отвечай ТОЛЬКО на казахском языке");
    expect(system).not.toContain(`«${GREETING_RU}»`);
    expect(apiMessages[0]).toEqual({ role: "user", content: patientText });
    expect(await sessionStore.getSession(startBody.sessionId)).toMatchObject({
      language: "kk",
      messages: [
        { role: "assistant", content: GREETING_KK },
        { role: "user", content: patientText },
        { role: "assistant", content: "Ауырсыну қаншалықты қатты?" },
      ],
    });
  });
});
