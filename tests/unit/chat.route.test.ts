import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleChat } from "../../app/api/chat/handler";
import {
  GREETING_KK,
  GREETING_RU,
  stripDoneMarker,
} from "../../lib/anamnesis";
import { HARD_TURN_CAP, SOFT_TURN_CAP } from "../../lib/config";
import { MemorySessionStore } from "../../lib/store";
import type { SessionStore } from "../../lib/store";
import type { TriageResult } from "../../lib/types";

const RESULT = {
  anamnesis: {
    chief_complaint: "боль в груди",
    symptom: {
      onset: "сегодня",
      location: "грудь",
      quality: "давящая",
      severity: 8,
      modifiers: "",
      associated: ["одышка"],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: {
      age: 58,
      sex: "m",
      pregnancy: "na",
      risk_factors: [],
    },
  },
  red_flags: [],
  urgency: "emergency",
  urgency_reasons: ["красный флаг"],
  routing: [{ specialty: "кардиология", confidence: 1 }],
  hypothesis: {
    text: "Требуется срочная оценка врача.",
    confidence: 0,
    disclaimer: "Это не диагноз, решает врач.",
  },
  source: "rules_only",
} as TriageResult;

const EMERGENCY_RESULT = {
  ...RESULT,
  red_flags: [
    {
      code: "chest_pain",
      label: "Боль в груди с признаками риска",
      evidence: "Давит в груди",
      evidence_kind: "quote",
      emergency: true,
      source_message_index: 1,
    },
  ],
} as TriageResult;

function request(sessionId: string, message = "Продолжаю отвечать") {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
}

async function collectingSession() {
  const sessionStore = new MemorySessionStore();
  const token = await sessionStore.createDoctorToken();
  const session = await sessionStore.createSession(token);
  await sessionStore.appendMessage(session.id, {
    role: "assistant",
    content: GREETING_RU,
  });
  return { sessionStore, sessionId: session.id };
}

async function collectingKazakhSession() {
  const sessionStore = new MemorySessionStore();
  const token = await sessionStore.createDoctorToken();
  const session = await sessionStore.createSession(token, "kk");
  await sessionStore.appendMessage(session.id, {
    role: "assistant",
    content: GREETING_KK,
  });
  return { sessionStore, sessionId: session.id };
}

describe("POST /api/chat", () => {
  it("finalizes the safety reply through the shared finalizer", async () => {
    const { sessionStore, sessionId } = await collectingSession();
    const analyze = vi.fn(async () => Promise.resolve(EMERGENCY_RESULT));

    const response = await handleChat(request(sessionId, "Давит в груди"), {
      sessionStore,
      runTurn: async () =>
        stripDoneMarker(
          "Немедленно позвоните 103. Данные переданы врачу.\n[ ANAMNESIS COMPLETE ]",
        ),
      analyze,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      done: true,
      turnsLeft: 0,
      closing: { emergency: true },
    });
    expect(body).not.toHaveProperty("result");
    expect(body.reply).not.toMatch(/ANAMNESIS/iu);
    expect(analyze).toHaveBeenCalledOnce();
    expect((await sessionStore.getSession(sessionId))?.status).toBe(
      "completed",
    );
  });

  it("finalizes on an emergency rule even when the model omits the marker", async () => {
    const { sessionStore, sessionId } = await collectingSession();
    const analyze = vi.fn(async () => Promise.resolve(EMERGENCY_RESULT));

    const response = await handleChat(
      request(sessionId, "Мне сильно давит в груди"),
      {
        sessionStore,
        runTurn: async () => ({
          reply: "Немедленно позвоните 103.",
          done: false,
        }),
        analyze,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      done: true,
      reply:
        "Сейчас лучше не ждать приёма. Позвоните 103 или обратитесь в приёмный покой. Ваши ответы переданы врачу.",
      closing: { emergency: true },
    });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("persists and delivers an emergency without calling the dialogue model", async () => {
    const { sessionStore, sessionId } = await collectingSession();
    const runTurn = vi.fn(async () => {
      throw new Error("dialogue model unavailable");
    });
    const sendDoctorSummary = vi.fn(async () => Promise.resolve());
    let delivery: Promise<void> | undefined;

    const response = await handleChat(
      request(sessionId, "Боль в груди и не могу дышать"),
      {
        sessionStore,
        runTurn,
        analyze: async () => EMERGENCY_RESULT,
        doctorSummary: { sendDoctorSummary },
        schedule: (work) => { delivery = work(); },
      },
    );
    await delivery;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      done: true,
      closing: { emergency: true },
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(sendDoctorSummary).toHaveBeenCalledOnce();
    expect(await sessionStore.getSession(sessionId)).toMatchObject({
      status: "completed",
      turnCount: 1,
      deliveryStatus: "sent",
      messages: expect.arrayContaining([
        { role: "user", content: "Боль в груди и не могу дышать" },
      ]),
    });
  });

  it("auto-finalizes exactly at HARD_TURN_CAP with a non-empty result", async () => {
    const { sessionStore, sessionId } = await collectingSession();
    const analyze = vi.fn(async () => Promise.resolve(RESULT));
    let lastResponse: Response | undefined;
    let lastBody: Record<string, unknown> | undefined;

    for (let index = 0; index < HARD_TURN_CAP; index += 1) {
      lastResponse = await handleChat(request(sessionId, `Реплика ${index + 1}`), {
        sessionStore,
        runTurn: async () => ({ reply: "Следующий вопрос", done: false }),
        analyze,
      });
      const currentBody = (await lastResponse.json()) as Record<string, unknown>;
      lastBody = currentBody;

      if (index + 1 === SOFT_TURN_CAP) {
        expect(currentBody.turnsLeft).toBe(
          HARD_TURN_CAP - SOFT_TURN_CAP,
        );
      }
    }

    expect(lastResponse?.status).toBe(200);
    expect(lastBody).toMatchObject({
      done: true,
      turnsLeft: 0,
      closing: { emergency: false },
    });
    expect(lastBody).not.toHaveProperty("result");
    expect(analyze).toHaveBeenCalledOnce();
    expect(await sessionStore.getSession(sessionId)).toMatchObject({
      status: "completed",
      turnCount: HARD_TURN_CAP,
    });

    const repeated = await handleChat(request(sessionId, "Лишняя реплика"), {
      sessionStore,
      runTurn: async () => ({ reply: "", done: false }),
      analyze,
    });
    expect(repeated.status).toBe(409);
    await expect(repeated.json()).resolves.toMatchObject({
      code: "SESSION_COMPLETED",
    });
  });

  it("uses only the Kazakh hard-cap closing for a Kazakh session", async () => {
    const { sessionStore, sessionId } = await collectingKazakhSession();
    for (let index = 0; index < HARD_TURN_CAP - 1; index += 1) {
      await sessionStore.appendMessage(sessionId, {
        role: "user",
        content: `Жауап ${index + 1}`,
      });
      await sessionStore.appendMessage(sessionId, {
        role: "assistant",
        content: "Келесі сұрақ",
      });
    }

    const response = await handleChat(request(sessionId, "Соңғы жауап"), {
      sessionStore,
      runTurn: async (_messages, language) => {
        expect(language).toBe("kk");
        return { reply: "Түсіндім.", done: false };
      },
      analyze: async () => RESULT,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reply).toBe("Жеткілікті мәлімет жиналды. Рақмет!");
    expect(body.reply).not.toMatch(/Спасибо|передаю|врачу/iu);
  });

  it("persists a patient message before the dialogue call fails", async () => {
    const { sessionStore, sessionId } = await collectingSession();
    const runTurn = vi
      .fn<() => Promise<{ reply: string; done: boolean }>>()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValue({ reply: "Продолжим опрос", done: false });

    const response = await handleChat(request(sessionId, "Повторяемая реплика"), {
      sessionStore,
      runTurn,
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "LLM_UNAVAILABLE",
    });
    expect(await sessionStore.getSession(sessionId)).toMatchObject({
      turnCount: 1,
      messages: [
        { role: "assistant", content: GREETING_RU },
        { role: "user", content: "Повторяемая реплика" },
      ],
    });

    const retried = await handleChat(
      request(sessionId, "Повторяемая реплика"),
      { sessionStore, runTurn },
    );
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      done: false,
      reply: "Продолжим опрос",
    });
    expect(await sessionStore.getSession(sessionId)).toMatchObject({
      turnCount: 1,
      messages: [
        { role: "assistant", content: GREETING_RU },
        { role: "user", content: "Повторяемая реплика" },
        { role: "assistant", content: "Продолжим опрос" },
      ],
    });
  });

  it("retries only finalize after analysis fails at the hard cap", async () => {
    const { sessionStore, sessionId } = await collectingSession();
    for (let index = 0; index < HARD_TURN_CAP - 1; index += 1) {
      await sessionStore.appendMessage(sessionId, {
        role: "user",
        content: `Реплика ${index + 1}`,
      });
      await sessionStore.appendMessage(sessionId, {
        role: "assistant",
        content: "Следующий вопрос",
      });
    }
    const runTurn = vi.fn(async () => ({
      reply: "Последний вопрос",
      done: false,
    }));
    const analyze = vi
      .fn<() => Promise<TriageResult>>()
      .mockRejectedValueOnce(new Error("analysis unavailable"))
      .mockResolvedValue(RESULT);

    const failed = await handleChat(request(sessionId, "Реплика 20"), {
      sessionStore,
      runTurn,
      analyze,
    });
    expect(failed.status).toBe(500);
    expect(await sessionStore.getSession(sessionId)).toMatchObject({
      status: "collecting",
      turnCount: HARD_TURN_CAP,
    });
    const sessionAfterFailure = await sessionStore.getSession(sessionId);
    if (!sessionAfterFailure) throw new Error("session disappeared after failure");
    const messagesAfterFailure = sessionAfterFailure.messages.length;

    const retried = await handleChat(request(sessionId, "Не дублировать"), {
      sessionStore,
      runTurn,
      analyze,
    });

    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      done: true,
      turnsLeft: 0,
      closing: { emergency: false },
    });
    expect(runTurn).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(await sessionStore.getSession(sessionId)).toMatchObject({
      status: "completed",
      turnCount: HARD_TURN_CAP,
      messages: expect.arrayContaining([
        { role: "user", content: "Реплика 20" },
      ]),
    });
    expect((await sessionStore.getSession(sessionId))?.messages).toHaveLength(
      messagesAfterFailure,
    );
  });

  it("aborts a partial turn when appending the assistant reply fails", async () => {
    const { sessionStore: baseStore, sessionId } = await collectingSession();
    let failAssistant = true;
    const failingStore: SessionStore = {
      createDoctorToken: () => baseStore.createDoctorToken(),
      isValidDoctorToken: (token) => baseStore.isValidDoctorToken(token),
      createSession: (token) => baseStore.createSession(token),
      getSession: (id) => baseStore.getSession(id),
      appendMessage: async (id, chatMessage) => {
        if (chatMessage.role === "assistant" && failAssistant) {
          failAssistant = false;
          throw new Error("assistant append failed");
        }
        await baseStore.appendMessage(id, chatMessage);
      },
      completeSession: (id, result) => baseStore.completeSession(id, result),
      abortSession: (id, reason) => baseStore.abortSession(id, reason),
      sweepExpired: (now) => baseStore.sweepExpired(now),
      markNotified: (id, status) => baseStore.markNotified(id, status),
    };
    const runTurn = vi.fn(async () => ({ reply: "Вопрос", done: false }));

    const failed = await handleChat(request(sessionId, "Ответ"), {
      sessionStore: failingStore,
      runTurn,
    });

    expect(failed.status).toBe(500);
    expect(await baseStore.getSession(sessionId)).toMatchObject({
      status: "aborted",
      turnCount: 1,
    });

    const retry = await handleChat(request(sessionId, "Ответ"), {
      sessionStore: failingStore,
      runTurn,
    });
    expect(retry.status).toBe(409);
    expect(runTurn).toHaveBeenCalledOnce();
    expect((await baseStore.getSession(sessionId))?.turnCount).toBe(1);
  });
});
