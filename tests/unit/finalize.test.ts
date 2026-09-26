import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleFinalize } from "../../app/api/chat/finalize/handler";
import { finalizeSession, NothingToAnalyzeError } from "../../lib/finalize";
import { MemorySessionStore } from "../../lib/store";
import type { TriageResult } from "../../lib/types";

const RESULT = {
  anamnesis: {
    chief_complaint: "головная боль",
    symptom: {
      onset: "сегодня",
      location: "голова",
      quality: "ноющая",
      severity: 4,
      modifiers: "",
      associated: [],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: {
      age: null,
      sex: "unknown",
      pregnancy: "na",
      risk_factors: [],
    },
  },
  red_flags: [],
  urgency: "planned",
  urgency_reasons: [],
  routing: [{ specialty: "терапевт", confidence: 1 }],
  hypothesis: {
    text: "Нужна оценка врача.",
    confidence: 0,
    disclaimer: "Это не диагноз, решает врач.",
  },
  source: "rules_only",
} as TriageResult;

function request(sessionId: string) {
  return new NextRequest("http://localhost/api/chat/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

describe("finalizeSession", () => {
  it("does not analyze or notify for an empty session", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    const analyze = vi.fn(async () => Promise.resolve(RESULT));
    const sendDoctorSummary = vi.fn(async () => undefined);
    const schedule = vi.fn((work: () => Promise<void>) => void work());

    await expect(
      finalizeSession(session.id, {
        sessionStore,
        analyze,
        doctorSummary: { sendDoctorSummary },
        schedule,
      }),
    ).rejects.toBeInstanceOf(NothingToAnalyzeError);

    expect(analyze).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(sendDoctorSummary).not.toHaveBeenCalled();
    await expect(sessionStore.getSession(session.id)).resolves.toMatchObject({
      status: "collecting",
      turnCount: 0,
      deliveryStatus: "pending",
    });
  });

  it("returns the stored result on repeat without invoking analysis again", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Болит голова",
    });
    const analyze = vi.fn(async () => Promise.resolve(RESULT));

    const first = await finalizeSession(session.id, { sessionStore, analyze });
    const second = await finalizeSession(session.id, { sessionStore, analyze });

    expect(first).toEqual({ result: RESULT, replayed: false });
    expect(second).toEqual({ result: RESULT, replayed: true });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("serves the canonical route and reports replayed completion", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Болит голова",
    });
    const analyze = vi.fn(async () => Promise.resolve(RESULT));

    const first = await handleFinalize(request(session.id), {
      sessionStore,
      analyze,
    });
    const repeated = await handleFinalize(request(session.id), {
      sessionStore,
      analyze,
    });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      closing: {
        emergency: false,
        text: "Спасибо. Ваши ответы переданы врачу. Дальнейшие шаги врач обсудит с вами отдельно.",
      },
      replayed: false,
    });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({
      closing: {
        emergency: false,
        text: "Спасибо. Ваши ответы переданы врачу. Дальнейшие шаги врач обсудит с вами отдельно.",
      },
      replayed: true,
    });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("returns 404 for an unknown session and 409 for an aborted one", async () => {
    const sessionStore = new MemorySessionStore();
    const missing = await handleFinalize(request("missing"), { sessionStore });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Я начал опрос",
    });
    await sessionStore.abortSession(session.id, "patient_left");
    const aborted = await handleFinalize(request(session.id), { sessionStore });
    expect(aborted.status).toBe(409);
    await expect(aborted.json()).resolves.toMatchObject({
      code: "SESSION_COMPLETED",
    });
  });
});
