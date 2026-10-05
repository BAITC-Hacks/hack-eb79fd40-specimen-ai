import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleChat } from "../../app/api/chat/handler";
import { handleFinalize } from "../../app/api/chat/finalize/handler";
import { GREETING_RU } from "../../lib/anamnesis";
import { MemorySessionStore } from "../../lib/store";
import { renderSummary } from "../../lib/telegram";
import { analyze, type LlmAnalysis } from "../../lib/triage";
import type { ChatMessage, ReadonlySession, TriageResult } from "../../lib/types";
import { BASE_LLM_ANALYSIS, failingLlm, fakeLlm, fakeModel } from "../fixtures/triage.ports";

const FAST_REPORT = "онемела правая рука, речь стала невнятной, лицо перекосило";
const DENIED_FAST_REPORT = "болит голова… Слабости в руках и ногах нет, речь нормальная";
const routineAnalysis: LlmAnalysis = {
  ...BASE_LLM_ANALYSIS,
  anamnesis: {
    ...BASE_LLM_ANALYSIS.anamnesis,
    chief_complaint: "Болит голова",
    symptom: { ...BASE_LLM_ANALYSIS.anamnesis.symptom, severity: 3, associated: [] },
  },
  urgency: "routine",
};

function request(path: string, sessionId: string, message?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...(message === undefined ? {} : { message }) }),
  });
}

async function collectingSession() {
  const sessionStore = new MemorySessionStore();
  const token = await sessionStore.createDoctorToken();
  const session = await sessionStore.createSession(token);
  await sessionStore.appendMessage(session.id, { role: "assistant", content: GREETING_RU });
  return { sessionStore, sessionId: session.id };
}

describe("FAST through real chat/finalize analysis and doctor summary", () => {
  it.each(["available", "unavailable"] as const)("closes with 103 and delivers emergency even with adapter %s", async (adapter) => {
    const { sessionStore, sessionId } = await collectingSession();
    const llmCounter = { calls: 0 };
    const modelCounter = { calls: 0 };
    const runTurn = vi.fn(async () => ({ reply: "Приходите как обычно", done: false }));
    const analyzePort = vi.fn((messages: ChatMessage[]) => analyze(messages, {
      llm: adapter === "available" ? fakeLlm(llmCounter, routineAnalysis) : failingLlm(llmCounter),
      model: fakeModel(modelCounter),
    }));
    const sendDoctorSummary = vi.fn<(_session: ReadonlySession, _result: TriageResult) => Promise<void>>(async () => {});
    let delivery: Promise<void> | undefined;
    const deps = {
      sessionStore, runTurn, analyze: analyzePort, doctorSummary: { sendDoctorSummary },
      schedule: (work: () => Promise<void>) => { delivery = work(); },
      processingMode: "external_llm" as const,
    };

    const response = await handleChat(request("/api/chat", sessionId, FAST_REPORT), deps);
    await delivery;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ done: true, turnsLeft: 0, closing: { emergency: true } });
    expect(body.reply).toContain("103");
    expect(body.reply).not.toContain("Приходите как обычно");
    expect(body).not.toHaveProperty("result");
    expect(runTurn).not.toHaveBeenCalled();
    expect(sendDoctorSummary).toHaveBeenCalledOnce();
    const saved = await sessionStore.getSession(sessionId);
    expect(saved).toMatchObject({ status: "completed", deliveryStatus: "sent", result: {
      urgency: "emergency", red_flags: [expect.objectContaining({ code: "stroke", emergency: true, evidence: "онемела правая рука", source_message_index: 1 })],
      source: adapter === "available" ? "model" : "rules_only",
    } });
    const [deliveredSession, deliveredResult] = sendDoctorSummary.mock.calls[0];
    expect(deliveredResult).toEqual(saved!.result);
    const summary = renderSummary(deliveredSession, deliveredResult);
    expect(summary).toContain("НЕОТЛОЖНО");
    expect(summary).toContain("онемела правая рука");
    expect(llmCounter.calls).toBe(1);
    expect(modelCounter.calls).toBe(adapter === "available" ? 1 : 0);

    const repeated = await handleFinalize(request("/api/chat/finalize", sessionId), deps);
    expect(await repeated.json()).toMatchObject({ replayed: true, closing: { emergency: true } });
    expect(analyzePort).toHaveBeenCalledOnce();
    expect(sendDoctorSummary).toHaveBeenCalledOnce();
  });

  it("continues ordinary questioning for denied FAST and finalizes without a false 103 screen", async () => {
    const { sessionStore, sessionId } = await collectingSession();
    const runTurn = vi.fn(async () => ({ reply: "Когда началась головная боль?", done: false }));
    const analyzePort = vi.fn((messages: ChatMessage[]) => analyze(messages, {
      llm: fakeLlm({ calls: 0 }, routineAnalysis), model: fakeModel({ calls: 0 }),
    }));
    const sendDoctorSummary = vi.fn<(_session: ReadonlySession, _result: TriageResult) => Promise<void>>(async () => {});
    let delivery: Promise<void> | undefined;
    const deps = {
      sessionStore, runTurn, analyze: analyzePort, doctorSummary: { sendDoctorSummary },
      schedule: (work: () => Promise<void>) => { delivery = work(); },
      processingMode: "external_llm" as const,
    };
    const response = await handleChat(request("/api/chat", sessionId, DENIED_FAST_REPORT), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ done: false, reply: "Когда началась головная боль?" });
    expect(runTurn).toHaveBeenCalledOnce();
    expect(analyzePort).not.toHaveBeenCalled();
    expect(sendDoctorSummary).not.toHaveBeenCalled();

    const completed = await handleFinalize(request("/api/chat/finalize", sessionId), deps);
    await delivery;
    expect(await completed.json()).toMatchObject({ replayed: false, closing: { emergency: false } });
    expect(await sessionStore.getSession(sessionId)).toMatchObject({ status: "completed", result: { urgency: "routine", red_flags: [] } });
    const [deliveredSession, deliveredResult] = sendDoctorSummary.mock.calls[0];
    expect(renderSummary(deliveredSession, deliveredResult)).not.toContain("Признаки инсульта");
  });
});
