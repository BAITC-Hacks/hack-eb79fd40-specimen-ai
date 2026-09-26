import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { handleChatStart } from "../../app/api/chat/start/handler";
import { GREETING_KK, GREETING_RU } from "../../lib/anamnesis";
import { MemorySessionStore } from "../../lib/store";

function startRequest(token: string): NextRequest {
  return new NextRequest("http://localhost/api/chat/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, language: "kk" }),
  });
}

describe("demo runtime debt regressions", () => {
  it("starts a Kazakh session with Kazakh content and persists that language", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();

    const response = await handleChatStart(startRequest(token), sessionStore);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reply).toBe(GREETING_KK);
    expect(body.reply).not.toBe(GREETING_RU);
    expect(body.reply).toMatch(/[әіңғүұқөһ]/iu);
    await expect(sessionStore.getSession(body.sessionId)).resolves.toMatchObject({
      language: "kk",
      messages: [{ role: "assistant", content: GREETING_KK }],
    });
  });

  it("silently removes an abandoned zero-turn session", async () => {
    const sendAbortedNotice = vi.fn(async () => undefined);
    const sessionStore = new MemorySessionStore({
      abortedNotice: { sendAbortedNotice },
    });
    const token = await sessionStore.createDoctorToken();
    const started = await handleChatStart(startRequest(token), sessionStore);
    const { sessionId } = await started.json();

    await expect(sessionStore.getSession(sessionId)).resolves.toMatchObject({
      turnCount: 0,
      messages: [{ role: "assistant", content: GREETING_KK }],
    });

    await sessionStore.abortSession(sessionId, "patient_left");

    expect(sendAbortedNotice).not.toHaveBeenCalled();
    await expect(sessionStore.getSession(sessionId)).resolves.toBeUndefined();
  });
});
