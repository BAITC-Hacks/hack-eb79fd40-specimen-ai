import { describe, expect, it, vi } from "vitest";
import { RETENTION_MS, SESSION_TTL_MS } from "../../lib/config";
import {
  MemorySessionStore,
  SessionNotCollectingError,
  type AbortedSessionNotice,
} from "../../lib/store";
import type { TriageResult } from "../../lib/types";

const result: TriageResult = {
  anamnesis: {
    chief_complaint: "",
    symptom: {
      onset: "",
      location: "",
      quality: "",
      severity: 0,
      modifiers: "",
      associated: [],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: { age: null, sex: "unknown", pregnancy: "na", risk_factors: [] },
  },
  red_flags: [],
  urgency: "routine",
  urgency_reasons: [],
  routing: [],
  hypothesis: {
    text: "",
    confidence: 0,
    disclaimer: "Это предварительная гипотеза, а не диагноз. Решает врач.",
  },
  source: "rules_only",
};

describe("MemorySessionStore", () => {
  it("validates issued doctor tokens and returns detached sessions", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    await expect(sessionStore.isValidDoctorToken(token)).resolves.toBe(true);

    const created = await sessionStore.createSession(token);
    created.messages = [{ role: "user", content: "external mutation" }];
    const stored = await sessionStore.getSession(created.id);
    expect(stored?.messages).toEqual([]);
  });

  it("stores the requested session language atomically and defaults to Russian", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();

    const defaultSession = await sessionStore.createSession(token);
    const kazakhSession = await sessionStore.createSession(token, "kk");

    expect(defaultSession.language).toBe("ru");
    expect(kazakhSession.language).toBe("kk");
    expect((await sessionStore.getSession(defaultSession.id))?.language).toBe(
      "ru",
    );
    expect((await sessionStore.getSession(kazakhSession.id))?.language).toBe(
      "kk",
    );
  });

  it("increments turnCount only for patient messages", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);

    await sessionStore.appendMessage(session.id, {
      role: "assistant",
      content: "Вопрос",
    });
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Ответ",
    });

    const stored = await sessionStore.getSession(session.id);
    expect(stored?.turnCount).toBe(1);
    expect(stored?.messages).toHaveLength(2);

    const leaked = stored as unknown as { messages: Array<{ content: string }> };
    leaked.messages[0].content = "runtime mutation";
    expect((await sessionStore.getSession(session.id))?.messages[0].content).toBe(
      "Вопрос",
    );
  });

  it("rejects messages after a terminal transition", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.completeSession(session.id, result);

    await expect(
      sessionStore.appendMessage(session.id, { role: "user", content: "Поздно" }),
    ).rejects.toBeInstanceOf(SessionNotCollectingError);
  });

  it("deletes a zero-turn session on direct abort without any delivery attempt", async () => {
    const sendAbortedNotice = vi.fn(async () => {
      throw new Error("zero-turn notifier must be unreachable");
    });
    const sessionStore = new MemorySessionStore({
      abortedNotice: { sendAbortedNotice },
    });
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    const markNotified = vi.spyOn(sessionStore, "markNotified");

    await sessionStore.abortSession(session.id, "language_changed");
    await sessionStore.abortSession(session.id, "duplicate");

    expect(sendAbortedNotice).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
    await expect(sessionStore.getSession(session.id)).resolves.toBeUndefined();
  });

  it("silently deletes an expired zero-turn session and does not count it as aborted", async () => {
    let now = 5_000;
    const sendAbortedNotice = vi.fn(
      async (notice: AbortedSessionNotice) => {
        void notice;
      },
    );
    const sessionStore = new MemorySessionStore({
      now: () => now,
      abortedNotice: { sendAbortedNotice },
    });
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    const markNotified = vi.spyOn(sessionStore, "markNotified");
    now += SESSION_TTL_MS + 1;

    await expect(sessionStore.sweepExpired(now)).resolves.toBe(0);
    await expect(sessionStore.sweepExpired(now)).resolves.toBe(0);

    expect(sendAbortedNotice).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
    await expect(sessionStore.getSession(session.id)).resolves.toBeUndefined();
  });

  it("sends an aborted-session DTO without TriageResult and marks delivery sent", async () => {
    const notices: AbortedSessionNotice[] = [];
    let now = 1_000;
    const sendAbortedNotice = vi.fn(async (notice: AbortedSessionNotice) => {
      notices.push(notice);
    });
    const sessionStore = new MemorySessionStore({
      now: () => now,
      abortedNotice: { sendAbortedNotice },
    });
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Я начал опрос",
    });
    now = 2_000;

    await sessionStore.abortSession(session.id, "ttl_expired");

    expect(sendAbortedNotice).toHaveBeenCalledOnce();
    expect(notices[0]).toEqual({
      sessionId: session.id,
      doctorToken: token,
      startedAt: 1_000,
      abortedAt: 2_000,
      reason: "ttl_expired",
    });
    expect(notices[0]).not.toHaveProperty("result");
    const aborted = await sessionStore.getSession(session.id);
    expect(aborted).toMatchObject({
      status: "aborted",
      deliveryStatus: "sent",
      notifiedAt: 2_000,
    });

    await sessionStore.abortSession(session.id, "again");
    expect(sendAbortedNotice).toHaveBeenCalledOnce();
  });

  it("marks an aborted notice failed without losing the terminal state", async () => {
    const sessionStore = new MemorySessionStore({
      now: () => 3_000,
      abortedNotice: {
        sendAbortedNotice: async () => {
          throw new Error("delivery unavailable");
        },
      },
    });
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Я начал опрос",
    });

    await sessionStore.abortSession(session.id, "ttl_expired");
    expect(await sessionStore.getSession(session.id)).toMatchObject({
      status: "aborted",
      deliveryStatus: "failed",
      notifiedAt: 3_000,
    });
  });

  it("aborts and notifies for an expired started session but retains completed sessions for 24 hours", async () => {
    let now = 10_000;
    const sendAbortedNotice = vi.fn(async () => Promise.resolve());
    const sessionStore = new MemorySessionStore({
      now: () => now,
      abortedNotice: { sendAbortedNotice },
    });
    const token = await sessionStore.createDoctorToken();
    const collecting = await sessionStore.createSession(token);
    await sessionStore.appendMessage(collecting.id, {
      role: "user",
      content: "Я начал опрос",
    });
    const completed = await sessionStore.createSession(token);
    await sessionStore.completeSession(completed.id, result);

    now += SESSION_TTL_MS + 1;
    await expect(sessionStore.sweepExpired(now)).resolves.toBe(1);
    expect(await sessionStore.getSession(collecting.id)).toMatchObject({
      status: "aborted",
      deliveryStatus: "sent",
      notifiedAt: now,
    });
    expect(sendAbortedNotice).toHaveBeenCalledOnce();
    expect((await sessionStore.getSession(completed.id))?.status).toBe("completed");

    await expect(sessionStore.sweepExpired(now)).resolves.toBe(0);
    expect(sendAbortedNotice).toHaveBeenCalledOnce();

    now = 10_000 + RETENTION_MS + 1;
    await expect(sessionStore.sweepExpired(now)).resolves.toBe(0);
    expect(await sessionStore.getSession(completed.id)).toBeUndefined();
  });

  it("coalesces concurrent sweeps so an expired started session is notified once", async () => {
    let now = 20_000;
    const sendAbortedNotice = vi.fn(async () => Promise.resolve());
    const sessionStore = new MemorySessionStore({
      now: () => now,
      abortedNotice: { sendAbortedNotice },
    });
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Я начал опрос",
    });
    now += SESSION_TTL_MS + 1;

    const counts = await Promise.all([
      sessionStore.sweepExpired(now),
      sessionStore.sweepExpired(now),
    ]);

    expect(counts.sort()).toEqual([0, 1]);
    expect(sendAbortedNotice).toHaveBeenCalledOnce();
    await expect(sessionStore.getSession(session.id)).resolves.toMatchObject({
      status: "aborted",
      deliveryStatus: "sent",
    });
  });

  it("coalesces concurrent direct aborts with a sweep into one notice", async () => {
    let now = 30_000;
    const sendAbortedNotice = vi.fn(
      async (notice: AbortedSessionNotice) => {
        void notice;
      },
    );
    const sessionStore = new MemorySessionStore({
      now: () => now,
      abortedNotice: { sendAbortedNotice },
    });
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Чувствительные данные пациента",
    });
    now += SESSION_TTL_MS + 1;

    const [, , swept] = await Promise.all([
      sessionStore.abortSession(session.id, "patient_left"),
      sessionStore.abortSession(session.id, "duplicate"),
      sessionStore.sweepExpired(now),
    ]);

    expect(swept).toBe(0);
    expect(sendAbortedNotice).toHaveBeenCalledOnce();
    expect(sendAbortedNotice.mock.calls[0][0]).not.toHaveProperty("messages");
    expect(JSON.stringify(sendAbortedNotice.mock.calls[0][0])).not.toContain(
      "Чувствительные данные пациента",
    );
    await expect(sessionStore.getSession(session.id)).resolves.toMatchObject({
      status: "aborted",
      deliveryStatus: "sent",
      notifiedAt: now,
    });
  });

  it("sweeps mixed sessions with count and TTL boundaries kept exact", async () => {
    let now = 40_000;
    const sendAbortedNotice = vi.fn(async () => Promise.resolve());
    const sessionStore = new MemorySessionStore({
      now: () => now,
      abortedNotice: { sendAbortedNotice },
    });
    const token = await sessionStore.createDoctorToken();
    const zero = await sessionStore.createSession(token);
    const started = await sessionStore.createSession(token);
    await sessionStore.appendMessage(started.id, {
      role: "user",
      content: "Одна реплика",
    });
    const secondZero = await sessionStore.createSession(token);
    const completed = await sessionStore.createSession(token);
    await sessionStore.completeSession(completed.id, result);

    now += SESSION_TTL_MS;
    await expect(sessionStore.sweepExpired(now)).resolves.toBe(0);
    await expect(sessionStore.getSession(zero.id)).resolves.toMatchObject({
      status: "collecting",
    });
    await expect(sessionStore.getSession(started.id)).resolves.toMatchObject({
      status: "collecting",
    });

    now += 1;
    await expect(sessionStore.sweepExpired(now)).resolves.toBe(1);
    await expect(sessionStore.getSession(zero.id)).resolves.toBeUndefined();
    await expect(sessionStore.getSession(started.id)).resolves.toMatchObject({
      status: "aborted",
      deliveryStatus: "sent",
    });
    expect(sendAbortedNotice).toHaveBeenCalledOnce();
    await expect(sessionStore.getSession(completed.id)).resolves.toMatchObject({
      status: "completed",
    });

    const fresh = await sessionStore.createSession(token);
    await sessionStore.abortSession("unknown", "unknown");
    await expect(sessionStore.getSession(fresh.id)).resolves.toMatchObject({
      status: "collecting",
    });
    await expect(sessionStore.getSession(secondZero.id)).resolves.toBeUndefined();
  });
});
