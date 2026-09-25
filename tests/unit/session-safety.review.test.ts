import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { handleChat } from "../../app/api/chat/handler";
import { sendChat } from "../../lib/http";
import { withSessionRequest } from "../../lib/session-operations";
import { FileSessionStore } from "../../lib/storage/session-store";
import { MemorySessionStore } from "../../lib/store";

function request(sessionId: string, message: string, requestId: string): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message, requestId }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session safety review 25.09", () => {
  it("coalesces an in-flight retry and replays the exact success without a second model call", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    const requestId = randomUUID();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const runTurn = async () => {
      calls += 1;
      await blocked;
      return { reply: "Следующий вопрос", done: false } as const;
    };
    const run = (req: NextRequest) => withSessionRequest(req, () => handleChat(req, { sessionStore, runTurn }));

    const first = run(request(session.id, "Один ответ", requestId));
    const duplicate = run(request(session.id, "Один ответ", requestId));
    await vi.waitFor(() => expect(calls).toBe(1));
    release();
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);
    const firstBody = await firstResponse.json();
    const duplicateBody = await duplicateResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(duplicateResponse.status).toBe(200);
    expect(duplicateBody).toEqual(firstBody);
    expect(calls).toBe(1);
    expect((await sessionStore.getSession(session.id))?.turnCount).toBe(1);

    const replay = await run(request(session.id, "Один ответ", requestId));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstBody);
    expect(calls).toBe(1);
    expect((await sessionStore.getSession(session.id))?.turnCount).toBe(1);
  });

  it("rejects reuse of one key for a different payload before model execution", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    const requestId = randomUUID();
    const runTurn = vi.fn(async () => ({ reply: "Следующий вопрос", done: false } as const));
    const run = (req: NextRequest) => withSessionRequest(req, () => handleChat(req, { sessionStore, runTurn }));

    expect((await run(request(session.id, "Первый", requestId))).status).toBe(200);
    const conflict = await run(request(session.id, "Другой", requestId));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect((await sessionStore.getSession(session.id))?.turnCount).toBe(1);
  });

  it("reuses the client request id after a lost response and rotates it after success", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      seen.push(body.requestId);
      if (seen.length === 1) throw new TypeError("connection lost");
      return Response.json({ reply: "Дальше", done: false, turnsLeft: 19 });
    }));

    await expect(sendChat("session-a", "Текст")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "network" },
    });
    await expect(sendChat("session-a", "Текст")).resolves.toMatchObject({ ok: true });
    await expect(sendChat("session-a", "Текст")).resolves.toMatchObject({ ok: true });

    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[1]);
  });

  it("persists personal-link consumption even after a zero-turn session is removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-link-once-"));
    const path = join(directory, "sessions.json");
    const first = new FileSessionStore({ path });
    try {
      const token = await first.createDoctorToken();
      // A direct create models a snapshot written before consumed-token state
      // existed. The first guarded create lazily migrates it as already used.
      const session = await first.createSession(token);
      await expect(first.createSessionOnce(token)).resolves.toBeUndefined();
      await first.abortSession(session!.id, "patient_left");
      expect(await first.getSession(session!.id)).toBeUndefined();
      await first.close();

      const reopened = new FileSessionStore({ path });
      try {
        await expect(reopened.createSessionOnce(token)).resolves.toBeUndefined();
      } finally {
        await reopened.close();
      }
    } finally {
      await first.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
