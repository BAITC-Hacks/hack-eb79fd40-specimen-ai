import { describe, expect, it, vi } from "vitest";

import { finalizeSession, type DoctorSummaryPort } from "../../lib/finalize";
import { MemorySessionStore } from "../../lib/store";
import {
  analyze,
  shouldAbstain,
  type ModelPort,
  type ModelPortResult,
} from "../../lib/triage";
import type { ChatMessage } from "../../lib/types";
import {
  BASE_LLM_ANALYSIS,
  failingLlm,
  fakeLlm,
  fakeModel,
  type PortCounter,
} from "../fixtures/triage.ports";

const ROUTINE_MODEL: ModelPortResult = {
  prediction: {
    pathologies: [
      { code: "Bronchitis", label_ru: "Бронхит", prob: 0.72 },
      { code: "Anemia", label_ru: "Анемия", prob: 0.08 },
    ],
    top_contributions: [],
    abstained: false,
    model_version: "integration-lr-v1",
  },
  abstain_threshold: 0.5,
};

const EMERGENCY_MESSAGES: ChatMessage[] = [
  { role: "assistant", content: "Что вас беспокоит?" },
  { role: "user", content: "Давит в груди и появилась одышка в покое." },
];

describe("model integration in the analytical layer", () => {
  it("keeps rule-based emergency above a routine model result", async () => {
    const llmCalls: PortCounter = { calls: 0 };
    const model: ModelPort = { predict: () => ROUTINE_MODEL };

    const result = await analyze(EMERGENCY_MESSAGES, {
      llm: fakeLlm(llmCalls),
      model,
    });

    expect(result.source).toBe("model");
    expect(result.model?.pathologies[0].code).toBe("Bronchitis");
    expect(result.urgency).toBe("emergency");
    expect(result.routing[0].specialty).toBe("терапевт");
    expect(result.routing[0].confidence).toBeCloseTo(0.8);
  });

  it("returns rules_only without model when extraction fails", async () => {
    const llmCalls: PortCounter = { calls: 0 };
    const modelCalls: PortCounter = { calls: 0 };

    const result = await analyze(EMERGENCY_MESSAGES, {
      llm: failingLlm(llmCalls),
      model: fakeModel(modelCalls),
    });

    expect(result.source).toBe("rules_only");
    expect(result.anamnesis.symptom.severity).toBeNull();
    expect(result.model).toBeUndefined();
    expect(modelCalls.calls).toBe(0);
    expect(result.urgency_reasons.join(" ")).toMatch(
      /Контекстные факторы не проверялись/iu,
    );
  });

  it("redacts an abstained model and still delivers the doctor summary", async () => {
    const sessionStore = new MemorySessionStore();
    const doctorToken = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(doctorToken);
    await sessionStore.appendMessage(session.id, EMERGENCY_MESSAGES[1]);
    const llmCalls: PortCounter = { calls: 0 };
    const modelCalls: PortCounter = { calls: 0 };
    const sendDoctorSummary = vi.fn<DoctorSummaryPort["sendDoctorSummary"]>(
      async () => Promise.resolve(),
    );
    const jobs: (() => Promise<void>)[] = [];

    const outcome = await finalizeSession(session.id, {
      sessionStore,
      analyze: (messages) =>
        analyze(messages, {
          llm: fakeLlm(llmCalls),
          model: fakeModel(modelCalls, "abstain"),
        }),
      doctorSummary: { sendDoctorSummary },
      schedule: (work) => jobs.push(work),
    });

    expect(outcome.result.source).toBe("llm_fallback");
    expect(outcome.result.model).toMatchObject({
      abstained: true,
      pathologies: [],
      top_contributions: [],
    });
    expect(jobs).toHaveLength(1);
    await jobs[0]();
    expect(sendDoctorSummary).toHaveBeenCalledOnce();
    expect(sendDoctorSummary.mock.calls[0][1]).toBe(outcome.result);
    await expect(sessionStore.getSession(session.id)).resolves.toMatchObject({
      deliveryStatus: "sent",
    });
  });

  it("checks out-of-label-space before the confidence threshold", () => {
    expect(
      shouldAbstain(
        { evidences: [], age: null, sex: "unknown" },
        [],
        ROUTINE_MODEL.prediction,
        0.9,
      ),
    ).toBe("out_of_label_space");
    expect(
      shouldAbstain(
        {
          evidences: [{ code: "E_14" }, { code: "E_66" }],
          age: null,
          sex: "unknown",
        },
        ["one unmapped", "two unmapped"],
        ROUTINE_MODEL.prediction,
        0.5,
      ),
    ).toBeUndefined();
  });

  it("uses deterministic zero-confidence fallback routes without extra port calls", async () => {
    const emergencyLlmCalls: PortCounter = { calls: 0 };
    const emergencyModelCalls: PortCounter = { calls: 0 };
    const emergency = await analyze(EMERGENCY_MESSAGES, {
      llm: fakeLlm(emergencyLlmCalls),
      model: fakeModel(emergencyModelCalls, "abstain"),
    });

    expect(emergency.source).toBe("llm_fallback");
    expect(emergency.routing).toEqual([
      { specialty: "скорая/приёмный покой", confidence: 0 },
    ]);
    expect(emergency.model).toMatchObject({
      abstained: true,
      pathologies: [],
      top_contributions: [],
    });
    expect(emergencyLlmCalls.calls).toBe(1);
    expect(emergencyModelCalls.calls).toBe(1);

    const routineLlmCalls: PortCounter = { calls: 0 };
    const routineModelCalls: PortCounter = { calls: 0 };
    const routine = await analyze(
      [{ role: "user", content: "Насморк без тревожных признаков." }],
      {
        llm: fakeLlm(routineLlmCalls),
        model: fakeModel(routineModelCalls, "abstain"),
      },
    );

    expect(routine.source).toBe("llm_fallback");
    expect(routine.routing).toEqual([
      { specialty: "терапевт", confidence: 0 },
    ]);
    expect(routineLlmCalls.calls).toBe(1);
    expect(routineModelCalls.calls).toBe(1);

    const failedLlmCalls: PortCounter = { calls: 0 };
    const skippedModelCalls: PortCounter = { calls: 0 };
    const rulesOnly = await analyze(EMERGENCY_MESSAGES, {
      llm: failingLlm(failedLlmCalls),
      model: fakeModel(skippedModelCalls),
    });

    expect(rulesOnly.source).toBe("rules_only");
    expect(rulesOnly.routing).toEqual([]);
    expect(failedLlmCalls.calls).toBe(1);
    expect(skippedModelCalls.calls).toBe(0);
  });

  it("routes any emergency fallback to emergency care even without a regex flag", async () => {
    const llmCalls: PortCounter = { calls: 0 };
    const modelCalls: PortCounter = { calls: 0 };
    const result = await analyze(
      [{ role: "user", content: "Сильная слабость началась сегодня." }],
      {
        llm: fakeLlm(llmCalls, {
          ...BASE_LLM_ANALYSIS,
          urgency: "emergency",
          urgency_reasons: ["Адаптер определил экстренный приоритет."],
        }),
        model: fakeModel(modelCalls, "abstain"),
      },
    );

    expect(result.red_flags).toEqual([]);
    expect(result.source).toBe("llm_fallback");
    expect(result.urgency).toBe("emergency");
    expect(result.routing).toEqual([
      { specialty: "скорая/приёмный покой", confidence: 0 },
    ]);
    expect(llmCalls.calls).toBe(1);
    expect(modelCalls.calls).toBe(1);
  });
});
