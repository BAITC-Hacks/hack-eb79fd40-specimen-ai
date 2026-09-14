import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { handleChat } from "../../app/api/chat/handler";
import { handleChatStart } from "../../app/api/chat/start/handler";
import { TOKEN_TTL_MS } from "../../lib/config";
import { MemorySessionStore } from "../../lib/store";
import { withSessionOperation, withSessionRequest, withSessionSweep } from "../../lib/session-operations";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("single-process session operation coordinator", () => {
  it("serializes the entire operation for one session", async () => {
    const release = deferred();
    const entered = deferred();
    const events: string[] = [];
    const first = withSessionOperation("same", async () => {
      events.push("first"); entered.resolve(); await release.promise; events.push("first_done");
    });
    const second = withSessionOperation("same", async () => { events.push("second"); });
    await entered.promise;
    expect(events).toEqual(["first"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "first_done", "second"]);
  });

  it("lets different sessions run concurrently", async () => {
    const enteredA = deferred();
    const enteredB = deferred();
    const first = withSessionOperation("parallel-a", async () => { enteredA.resolve(); await enteredB.promise; });
    const second = withSessionOperation("parallel-b", async () => { enteredB.resolve(); await enteredA.promise; });
    await Promise.all([first, second]);
  });

  it("gives the second chat turn the history committed by the first turn", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const histories: string[][] = [];
    const runTurn = async (messages: { content: string }[]) => {
      histories.push(messages.map((message) => message.content));
      if (histories.length === 1) { firstEntered.resolve(); await releaseFirst.promise; }
      return { reply: "Следующий вопрос", done: false };
    };
    const send = (message: string) => withSessionOperation(session.id, () => handleChat(
      new NextRequest("http://localhost/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, message }),
      }), { sessionStore, runTurn },
    ));
    const first = send("Первый ответ");
    const second = send("Второй ответ");
    await firstEntered.promise;
    expect(histories).toEqual([["Первый ответ"]]);
    releaseFirst.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(histories[1]).toEqual(["Первый ответ", "Следующий вопрос", "Второй ответ"]);
    expect((await sessionStore.getSession(session.id))?.turnCount).toBe(2);
  });

  it("sweeps after old operations and blocks new operations without creating a cycle", async () => {
    const releaseOld = deferred();
    const releaseSweep = deferred();
    const oldEntered = deferred();
    const sweepEntered = deferred();
    const events: string[] = [];
    const old = withSessionOperation("barrier", async () => {
      events.push("old"); oldEntered.resolve(); await releaseOld.promise; events.push("old_done");
    });
    const queuedOld = withSessionOperation("barrier", async () => { events.push("queued_old"); });
    const sweep = withSessionSweep(async () => {
      events.push("sweep"); sweepEntered.resolve(); await releaseSweep.promise; events.push("sweep_done");
    });
    const next = withSessionOperation("new-session", async () => { events.push("new"); });
    await oldEntered.promise;
    expect(events).toEqual(["old"]);
    releaseOld.resolve();
    await sweepEntered.promise;
    expect(events).toEqual(["old", "old_done", "queued_old", "sweep"]);
    releaseSweep.resolve();
    await Promise.all([old, queuedOld, sweep, next]);
    expect(events).toEqual(["old", "old_done", "queued_old", "sweep", "sweep_done", "new"]);
  });

  it("releases both per-session queues and sweep gates after rejection", async () => {
    const first = withSessionOperation("failed", async () => { throw new Error("operation failed"); });
    const second = withSessionOperation("failed", async () => "recovered");
    await expect(first).rejects.toThrow("operation failed");
    expect(await second).toBe("recovered");
    const sweep = withSessionSweep(async () => { throw new Error("sweep failed"); });
    const next = withSessionOperation("after-sweep", async () => "works");
    await expect(sweep).rejects.toThrow("sweep failed");
    expect(await next).toBe("works");
  });

  it("waits for an active chat before expired-token start performs its deletion cascade", async () => {
    let now = 1_000;
    const sessionStore = new MemorySessionStore({ now: () => now });
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    const entered = deferred();
    const release = deferred();
    const active = withSessionOperation(session.id, async () => {
      entered.resolve(); await release.promise;
      await sessionStore.appendMessage(session.id, { role: "user", content: "Ответ" });
    });
    await entered.promise;
    now += TOKEN_TTL_MS + 1;
    const start = withSessionSweep(() => handleChatStart(new NextRequest("http://localhost/api/chat/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
    }), sessionStore));
    expect(await sessionStore.getSession(session.id)).toBeDefined();
    release.resolve();
    await active;
    expect((await start).status).toBe(404);
    expect(await sessionStore.getSession(session.id)).toBeUndefined();
  });

  it("keeps invalid body validation with the existing handler and never retries a failing operation", async () => {
    let calls = 0;
    const req = new Request("http://localhost/api/chat", { method: "POST", body: "{" });
    const response = await withSessionRequest(req, async () => { calls += 1; return Response.json({}, { status: 400 }); });
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
    const valid = new Request("http://localhost/api/chat", {
      method: "POST", body: JSON.stringify({ sessionId: "11111111-1111-4111-8111-111111111111" }),
    });
    await expect(withSessionRequest(valid, async () => { calls += 1; throw new Error("failure"); })).rejects.toThrow("failure");
    expect(calls).toBe(2);
  });
});
