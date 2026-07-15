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
        { evidences: [{ code: "mapped" }], age: null, sex: "unknown" },
        ["one unmapped"],
        ROUTINE_MODEL.prediction,
        0.5,
      ),
    ).toBeUndefined();
  });
});
