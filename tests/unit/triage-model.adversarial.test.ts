import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildHealthResponse } from "../../lib/health";
import { loadArtifact } from "../../lib/model";
import {
  analyze,
  shouldAbstain,
  type LlmAnalysis,
  type ModelPort,
  type ModelPortResult,
} from "../../lib/triage";
import type { ChatMessage, EvidenceVector, ModelPrediction } from "../../lib/types";
import { BASE_LLM_ANALYSIS, fakeLlm, type PortCounter } from "../fixtures/triage.ports";

const ROUTINE_MESSAGES: ChatMessage[] = [
  { role: "assistant", content: "Что вас беспокоит?" },
  { role: "user", content: "Насморк без других жалоб." },
];

function analysis(
  evidence: EvidenceVector = {
    evidences: [{ code: "E_14" }, { code: "E_66" }],
    age: 49,
    sex: "f",
  },
  unmapped: string[] = [],
): LlmAnalysis {
  return {
    ...BASE_LLM_ANALYSIS,
    evidence,
    unmapped,
    urgency: "routine",
    urgency_reasons: ["LLM: routine"],
    routing: [{ specialty: "терапевт", confidence: 0.4 }],
    hypothesis: { text: "Нужна оценка врача.", confidence: 0.9 },
  };
}

function prediction(
  pathologies: ModelPrediction["pathologies"],
): ModelPrediction {
  return {
    pathologies,
    top_contributions: [],
    abstained: false,
    model_version: "adversarial-lr-v1",
  };
}

function modelPort(
  pathologies: ModelPrediction["pathologies"],
  threshold = 0.1,
): ModelPort {
  return {
    predict(): ModelPortResult {
      return {
        prediction: prediction(pathologies),
        abstain_threshold: threshold,
      };
    },
  };
}

describe("model integration adversarial boundaries", () => {
  it("owns abstain centrally with OOL precedence and strict ratio/threshold boundaries", () => {
    const highConfidence = prediction([
      { code: "Bronchitis", label_ru: "Бронхит", prob: 0.9 },
    ]);
    const exactThreshold = prediction([
      { code: "Bronchitis", label_ru: "Бронхит", prob: 0.5 },
    ]);
    const belowThreshold = prediction([
      { code: "Bronchitis", label_ru: "Бронхит", prob: 0.499999 },
    ]);
    const oneActive: EvidenceVector = {
      evidences: [{ code: "E_14" }],
      age: null,
      sex: "unknown",
    };
    const twoActive: EvidenceVector = {
      evidences: [{ code: "E_14" }, { code: "E_66" }],
      age: null,
      sex: "unknown",
    };

    expect(
      shouldAbstain({ ...oneActive, evidences: [] }, [], highConfidence, 0.5),
    ).toBe("out_of_label_space");
    expect(shouldAbstain(oneActive, [], highConfidence, 0.5)).toBe(
      "out_of_label_space",
    );
    expect(
      shouldAbstain(twoActive, ["one", "two", "three"], highConfidence, 0.5),
    ).toBe("out_of_label_space");
    expect(
      shouldAbstain(twoActive, ["one", "two"], exactThreshold, 0.5),
    ).toBeUndefined();
    expect(shouldAbstain(twoActive, [], belowThreshold, 0.5)).toBe(
      "low_confidence",
    );
  });

  it("sums top-5 probabilities by primary specialty without alt routes or renormalization", async () => {
    const llmCalls: PortCounter = { calls: 0 };
    const result = await analyze(ROUTINE_MESSAGES, {
      llm: fakeLlm(llmCalls, analysis()),
      model: modelPort([
        { code: "Bronchitis", label_ru: "Бронхит", prob: 0.25 },
        { code: "Anemia", label_ru: "Анемия", prob: 0.2 },
        { code: "Acute laryngitis", label_ru: "Острый ларингит", prob: 0.4 },
      ]),
    });

    expect(result.source).toBe("model");
    expect(result.routing).toEqual([
      { specialty: "терапевт", confidence: 0.45 },
      { specialty: "ЛОР", confidence: 0.4 },
    ]);
    expect(new Set(result.routing.map(({ specialty }) => specialty)).size).toBe(
      result.routing.length,
    );
    expect(result.routing).toHaveLength(2);
    expect(result.routing[0].confidence).toBeGreaterThanOrEqual(
      result.routing[1].confidence,
    );
    expect(result.routing.map(({ specialty }) => specialty)).not.toContain("пульмонология");
  });

  it("includes an exact 0.15 pathology in worst-urgency selection and excludes below-boundary", async () => {
    const llmCalls: PortCounter = { calls: 0 };
    const exact = await analyze(ROUTINE_MESSAGES, {
      llm: fakeLlm(llmCalls, analysis()),
      model: modelPort([
        { code: "Bronchitis", label_ru: "Бронхит", prob: 0.7 },
        { code: "Acute pulmonary edema", label_ru: "Отёк лёгких", prob: 0.15 },
      ]),
    });
    const below = await analyze(ROUTINE_MESSAGES, {
      llm: fakeLlm(llmCalls, analysis()),
      model: modelPort([
        { code: "Bronchitis", label_ru: "Бронхит", prob: 0.7 },
        {
          code: "Acute pulmonary edema",
          label_ru: "Отёк лёгких",
          prob: 0.149999,
        },
      ]),
    });

    expect(exact.urgency).toBe("emergency");
    expect(below.urgency).toBe("routine");
  });

  it("fails closed when an injected prediction has no canonical pathology-map row", async () => {
    const llmCalls: PortCounter = { calls: 0 };
    const result = await analyze(ROUTINE_MESSAGES, {
      llm: fakeLlm(llmCalls, analysis()),
      model: modelPort([
        { code: "NOT_IN_MAP", label_ru: "Неизвестное состояние", prob: 0.9 },
      ]),
    });

    expect(result.source).toBe("llm_fallback");
    expect(result.model).toBeUndefined();
    expect(result.urgency_reasons.join(" ")).toMatch(/Модель недоступна/iu);
  });

  it("uses the real production artifact and exact 47-row map on the default model path", async () => {
    const [, firstCase] = readFileSync("tests/fixtures/parity.golden.jsonl", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const fixture = firstCase as { evidence_vector: EvidenceVector };
    const llmCalls: PortCounter = { calls: 0 };
    const result = await analyze(ROUTINE_MESSAGES, {
      llm: fakeLlm(llmCalls, analysis(fixture.evidence_vector)),
    });
    const artifact = loadArtifact();
    const pathologyMap = JSON.parse(
      readFileSync("data/pathology_map.json", "utf8"),
    ) as { pathology: string }[];

    expect(artifact.class_order).toHaveLength(47);
    expect(pathologyMap.map(({ pathology }) => pathology)).toEqual(artifact.class_order);
    expect(result.source).toBe("model");
    expect(result.model?.model_version).toBe(artifact.model_version);
    expect(result.routing.length).toBeGreaterThan(0);
  });

  it("reports the integrated production model version through healthz", () => {
    expect(buildHealthResponse({}).model_version).toBe(loadArtifact().model_version);
  });

  it("does not silently count an untrusted invented evidence code as mapped", async () => {
    const llmCalls: PortCounter = { calls: 0 };
    const result = await analyze(ROUTINE_MESSAGES, {
      llm: fakeLlm(
        llmCalls,
        analysis({ evidences: [{ code: "E_NOT_REAL" }], age: 49, sex: "f" }),
      ),
    });

    expect(result.source).toBe("llm_fallback");
    expect(result.model).toMatchObject({
      abstained: true,
      abstain_reason: "out_of_label_space",
      pathologies: [],
      top_contributions: [],
    });
  });
});
