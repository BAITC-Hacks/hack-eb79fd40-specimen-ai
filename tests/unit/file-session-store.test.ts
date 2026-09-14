import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RETENTION_MS, SESSION_TTL_MS, TOKEN_TTL_MS } from "../../lib/config";
import { FileSessionStore } from "../../lib/storage/session-store";
import type { TriageResult } from "../../lib/types";
import { BASE_LLM_ANALYSIS } from "../fixtures/triage.ports";

const result: TriageResult = {
  anamnesis: BASE_LLM_ANALYSIS.anamnesis,
  red_flags: [], urgency: "planned", urgency_reasons: [], routing: [],
  hypothesis: { text: "Требуется оценка врача", confidence: 0, disclaimer: "Это не диагноз, решает врач" },
  source: "rules_only",
};
const directories: string[] = [];
const instances: FileSessionStore[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "demeu-sessions-"));
  directories.push(directory);
  const path = join(directory, "sessions.json");
  let now = 1_000;
  const open = (sendAbortedNotice?: () => Promise<void>) => {
    const state = new FileSessionStore({ path, now: () => now,
      abortedNotice: sendAbortedNotice ? { sendAbortedNotice } : undefined });
    instances.push(state);
    return state;
  };
  return { path, open, advance: (ms: number) => { now += ms; } };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((state) => state.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileSessionStore", () => {
  it("preserves tokens, language, turns, result and delivery across restart", async () => {
    const { open } = await fixture();
    const state = open();
    const token = await state.createDoctorToken();
    const session = await state.createSession(token, "kk");
    await state.appendMessage(session.id, { role: "assistant", content: "Сәлем" });
    await Promise.all(Array.from({ length: 8 }, () => state.appendMessage(session.id, { role: "user", content: "Ответ" })));
    await state.completeSession(session.id, result);
    await state.markNotified(session.id, "sent");
    await state.close();
    const reopened = open();
    expect(await reopened.isValidDoctorToken(token)).toBe(true);
    expect(await reopened.getSession(session.id)).toMatchObject({ language: "kk", turnCount: 8, status: "completed", result, deliveryStatus: "sent" });
    expect((await reopened.listSessions())[0].messages).toHaveLength(9);
    await expect(reopened.appendMessage(session.id, { role: "user", content: "late" })).rejects.toThrow();
  });

  it("commits aborted state before calling the notifier and does not replay on restart", async () => {
    const { path, open } = await fixture();
    const notify = vi.fn(async () => {
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted.sessions[0]).toMatchObject({ status: "aborted", deliveryStatus: "pending" });
      throw new Error("not delivered");
    });
    const state = open(notify);
    const token = await state.createDoctorToken();
    const session = await state.createSession(token);
    await state.appendMessage(session.id, { role: "user", content: "Начал" });
    await state.abortSession(session.id, "ttl_expired");
    expect(await state.getSession(session.id)).toMatchObject({ status: "aborted", deliveryStatus: "failed" });
    await state.close();
    const reopened = open(notify);
    await reopened.abortSession(session.id, "repeat");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("preserves legacy TTL and silent zero-turn deletion", async () => {
    const { open, advance } = await fixture();
    const notify = vi.fn(async () => undefined);
    const state = open(notify);
    const token = await state.createDoctorToken();
    const empty = await state.createSession(token);
    const started = await state.createSession(token);
    await state.appendMessage(started.id, { role: "user", content: "Начал" });
    advance(SESSION_TTL_MS + 1);
    expect(await state.sweepExpired(1_000 + SESSION_TTL_MS + 1)).toBe(1);
    expect(await state.getSession(empty.id)).toBeUndefined();
    expect(notify).toHaveBeenCalledOnce();
    // Use the injected clock for explicit sweeps as in the runtime store.
    advance(RETENTION_MS + 1);
    await state.sweepExpired(1_000 + SESSION_TTL_MS + RETENTION_MS + 2);
    expect(await state.getSession(started.id)).toBeUndefined();
    advance(TOKEN_TTL_MS);
    expect(await state.isValidDoctorToken(token)).toBe(false);
  });

  it("keeps pending completion visible after restart without sending automatically", async () => {
    const { open } = await fixture();
    const notify = vi.fn(async () => undefined);
    const state = open(notify);
    const token = await state.createDoctorToken();
    const session = await state.createSession(token);
    await state.appendMessage(session.id, { role: "user", content: "Ответ" });
    await state.completeSession(session.id, result);
    await state.close();
    expect(await open(notify).getSession(session.id)).toMatchObject({ status: "completed", deliveryStatus: "pending" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects an invalid saved result instead of opening an empty store", async () => {
    const { path, open } = await fixture();
    const state = open();
    const token = await state.createDoctorToken();
    const session = await state.createSession(token);
    await state.completeSession(session.id, result);
    await state.close();
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.sessions[0].result.hypothesis.disclaimer = "";
    await writeFile(path, JSON.stringify(saved));
    await expect(open().getSession(session.id)).rejects.toThrow("Invalid session snapshot");
  });
});
