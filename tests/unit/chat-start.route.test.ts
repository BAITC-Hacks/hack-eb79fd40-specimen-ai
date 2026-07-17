import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleChatStart } from "../../app/api/chat/start/handler";
import { POST } from "../../app/api/chat/start/route";
import { GREETING_KK, GREETING_RU } from "../../lib/anamnesis";
import { HARD_TURN_CAP } from "../../lib/config";
import { MemorySessionStore } from "../../lib/store";
import type { SessionStore } from "../../lib/store";

function request(
  token: string,
  fields: Record<string, unknown> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/chat/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, ...fields }),
  });
}

describe("POST /api/chat/start", () => {
  it("returns a static greeting and the full turn budget without network", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();

    const response = await handleChatStart(request(token), sessionStore);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      reply: GREETING_RU,
      turnsLeft: HARD_TURN_CAP,
    });
    expect(await sessionStore.getSession(body.sessionId)).toMatchObject({
      language: "ru",
      turnCount: 0,
      messages: [{ role: "assistant", content: GREETING_RU }],
    });
  });

  it.each([
    ["ru", GREETING_RU],
    ["kk", GREETING_KK],
  ] as const)(
    "stores and returns the exact %s greeting selected by canonical language",
    async (language, greeting) => {
      const sessionStore = new MemorySessionStore();
      const token = await sessionStore.createDoctorToken();

      const response = await handleChatStart(
        request(token, { language }),
        sessionStore,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.reply).toBe(greeting);
      expect(await sessionStore.getSession(body.sessionId)).toMatchObject({
        language,
        messages: [{ role: "assistant", content: greeting }],
      });
    },
  );

  it("does not treat the non-canonical lang property as Kazakh", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();

    const response = await handleChatStart(
      request(token, { lang: "kk" }),
      sessionStore,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reply).toBe(GREETING_RU);
    expect(await sessionStore.getSession(body.sessionId)).toMatchObject({
      language: "ru",
    });
  });

  it.each(["en", "", null, 1, true, {}, []])(
    "rejects invalid canonical language %j before creating a session",
    async (language) => {
      const sessionStore = new MemorySessionStore();
      const token = await sessionStore.createDoctorToken();
      const createSession = vi.spyOn(sessionStore, "createSession");

      const response = await handleChatStart(
        request(token, { language }),
        sessionStore,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(createSession).not.toHaveBeenCalled();
    },
  );

  it("returns 404 for an unknown well-formed doctor token", async () => {
    const response = await POST(request("deadbeefdeadbeef"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TOKEN_NOT_FOUND" });
  });

  it("maps a store failure to 500, never 404", async () => {
    const failingStore: SessionStore = {
      createDoctorToken: async () => "",
      isValidDoctorToken: async () => {
        throw new Error("store unavailable");
      },
      createSession: async () => {
        throw new Error("not reached");
      },
      getSession: async () => undefined,
      appendMessage: async () => undefined,
      completeSession: async () => undefined,
      abortSession: async () => undefined,
      sweepExpired: async () => 0,
      markNotified: async () => undefined,
    };

    const response = await handleChatStart(
      request("deadbeefdeadbeef"),
      failingStore,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL" });
  });
});
