import { describe, expect, it } from "vitest";
import { analyze } from "../../lib/triage";
import type { ChatMessage } from "../../lib/types";
import {
  BASE_LLM_ANALYSIS,
  failingLlm,
  fakeLlm,
  fakeModel,
  type PortCounter,
} from "../fixtures/triage.ports";
import { assertTriageInvariants } from "./invariants";

const EMERGENCY_MESSAGES: ChatMessage[] = [
  { role: "assistant", content: "Что вас беспокоит?" },
  {
    role: "user",
    content: "Давит в груди и появилась одышка в покое.",
  },
];

describe("четыре золотых инварианта аналитического слоя", () => {
  it("golden 1: emergency-флаг доминирует над выходом модели", async () => {
    const llmCalls: PortCounter = { calls: 0 };
    const modelCalls: PortCounter = { calls: 0 };
    const result = await analyze(EMERGENCY_MESSAGES, {
      llm: fakeLlm(llmCalls),
      model: fakeModel(modelCalls, "success"),
    });

    expect(result.source).toBe("model");
    expect(result.model?.pathologies[0].code).toBe("P_ROUTINE");
    expect(result.urgency).toBe("emergency");
    expect(result.urgency_reasons[0]).toMatch(/красн\p{L}*\s+флаг/iu);
    expect(llmCalls.calls).toBe(1);
    expect(modelCalls.calls).toBe(1);
    expect(() => assertTriageInvariants(result, EMERGENCY_MESSAGES)).not.toThrow();
  });

  it("golden 2: quote evidence проверяема, derived evidence имеет индекс -1", async () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Опишите жалобу." },
      { role: "user", content: "Началось кровотечение." },
    ];
    const llmCalls: PortCounter = { calls: 0 };
    const analysis = {
      ...BASE_LLM_ANALYSIS,
      anamnesis: {
        ...BASE_LLM_ANALYSIS.anamnesis,
        chief_complaint: "Боль в животе и кровотечение",
        context: {
          ...BASE_LLM_ANALYSIS.anamnesis.context,
          sex: "f" as const,
          pregnancy: "yes" as const,
        },
      },
    };
    const result = await analyze(messages, { llm: fakeLlm(llmCalls, analysis) });

    expect(result.red_flags.some((flag) => flag.evidence_kind === "quote")).toBe(true);
    expect(result.red_flags.some((flag) => flag.evidence_kind === "derived")).toBe(true);
    expect(() => assertTriageInvariants(result, messages)).not.toThrow();
  });

  it("golden 3: TriageResult полон, а model присутствует тогда и только тогда, когда модель считалась", async () => {
    const modelLlmCalls: PortCounter = { calls: 0 };
    const modelCalls: PortCounter = { calls: 0 };
    const modelResult = await analyze(EMERGENCY_MESSAGES, {
      llm: fakeLlm(modelLlmCalls),
      model: fakeModel(modelCalls, "success"),
    });

    const abstainLlmCalls: PortCounter = { calls: 0 };
    const abstainModelCalls: PortCounter = { calls: 0 };
    const abstainResult = await analyze(EMERGENCY_MESSAGES, {
      llm: fakeLlm(abstainLlmCalls),
      model: fakeModel(abstainModelCalls, "abstain"),
    });

    const failedLlmCalls: PortCounter = { calls: 0 };
    const skippedModelCalls: PortCounter = { calls: 0 };
    const rulesResult = await analyze(EMERGENCY_MESSAGES, {
      llm: failingLlm(failedLlmCalls),
      model: fakeModel(skippedModelCalls, "success"),
    });

    expect(modelResult.source).toBe("model");
    expect(modelCalls.calls).toBe(1);
    expect(modelResult.model).toBeDefined();
    expect(abstainResult.source).toBe("llm_fallback");
    expect(abstainModelCalls.calls).toBe(1);
    expect(abstainResult.model).toMatchObject({
      abstained: true,
      pathologies: [],
      top_contributions: [],
    });
    expect(rulesResult.source).toBe("rules_only");
    expect(failedLlmCalls.calls).toBe(1);
    expect(skippedModelCalls.calls).toBe(0);
    expect(rulesResult.model).toBeUndefined();
    expect(rulesResult.hypothesis.confidence).toBe(0);
    expect(rulesResult.urgency_reasons.join(" ")).toMatch(
      /признак\p{L}*\s+не\s+извлеч/iu,
    );

    for (const result of [modelResult, abstainResult, rulesResult]) {
      expect(() => assertTriageInvariants(result, EMERGENCY_MESSAGES)).not.toThrow();
    }
  });

  it("golden 4: disclaimer всегда непустой и содержит «не диагноз, решает врач»", async () => {
    const malformed = {
      ...BASE_LLM_ANALYSIS,
      hypothesis: { text: "", confidence: Number.NaN },
    };
    const llmCalls: PortCounter = { calls: 0 };
    const modelCalls: PortCounter = { calls: 0 };
    const result = await analyze(EMERGENCY_MESSAGES, {
      llm: fakeLlm(llmCalls, malformed),
      model: fakeModel(modelCalls, "success"),
    });

    expect(result.hypothesis.disclaimer).toMatch(/не\s+диагноз/iu);
    expect(result.hypothesis.disclaimer).toMatch(/решает\s+врач/iu);
    expect(result.hypothesis.text).not.toHaveLength(0);
    expect(() => assertTriageInvariants(result, EMERGENCY_MESSAGES)).not.toThrow();
  });

  it("accepts nullable or explicit-zero severity and rejects non-finite severity", async () => {
    const result = await analyze(EMERGENCY_MESSAGES, {
      llm: failingLlm({ calls: 0 }),
    });
    expect(result.anamnesis.symptom.severity).toBeNull();
    expect(() => assertTriageInvariants(result, EMERGENCY_MESSAGES)).not.toThrow();

    const explicitZero = structuredClone(result);
    explicitZero.anamnesis.symptom.severity = 0;
    expect(() =>
      assertTriageInvariants(explicitZero, EMERGENCY_MESSAGES),
    ).not.toThrow();

    const nonFinite = structuredClone(result);
    nonFinite.anamnesis.symptom.severity = Number.NaN;
    expect(() =>
      assertTriageInvariants(nonFinite, EMERGENCY_MESSAGES),
    ).toThrow(/severity/u);
  });
});
