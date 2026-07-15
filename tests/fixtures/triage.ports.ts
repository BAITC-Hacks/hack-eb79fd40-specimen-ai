import type {
  LlmAnalysis,
  LlmPort,
  ModelPort,
  ModelPortResult,
} from "../../lib/triage";

export interface PortCounter {
  calls: number;
}

export const BASE_LLM_ANALYSIS: LlmAnalysis = {
  anamnesis: {
    chief_complaint: "Боль в груди",
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
  evidence: {
    evidences: [{ code: "E_14" }, { code: "E_66" }],
    age: 58,
    sex: "m",
  },
  unmapped: [],
  urgency: "planned",
  urgency_reasons: ["LLM: требуется оценка врача"],
  routing: [
    { specialty: "терапия", confidence: 0.55 },
    { specialty: "кардиология", confidence: 0.75 },
  ],
  hypothesis: {
    text: "Следует оценить сочетание боли в груди и одышки.",
    confidence: 0.8,
  },
};

export function fakeLlm(
  counter: PortCounter,
  analysis: LlmAnalysis = BASE_LLM_ANALYSIS,
): LlmPort {
  return {
    async analyze() {
      counter.calls += 1;
      return analysis;
    },
  };
}

export function failingLlm(counter: PortCounter): LlmPort {
  return {
    async analyze() {
      counter.calls += 1;
      throw new Error("adapter unavailable");
    },
  };
}

const SUCCESSFUL_MODEL_RESULT: ModelPortResult = {
  prediction: {
    pathologies: [
      { code: "P_ROUTINE", label_ru: "Плановое состояние", prob: 0.72 },
      { code: "P_ALT", label_ru: "Альтернативное состояние", prob: 0.18 },
    ],
    top_contributions: [
      {
        feature: "E_CHEST_PAIN",
        label_ru: "Боль в груди",
        contribution: 1.4,
      },
    ],
    abstained: false,
    model_version: "fake-lr-v1",
  },
  urgency: "routine",
  urgency_reasons: ["fake model: routine"],
  routing: [
    { specialty: "неврология", confidence: 0.3 },
    { specialty: "терапия", confidence: 0.6 },
  ],
};

const ABSTAIN_MODEL_RESULT: ModelPortResult = {
  prediction: {
    pathologies: [
      { code: "P_UNTRUSTED", label_ru: "Недоверенное состояние", prob: 0.31 },
    ],
    top_contributions: [
      {
        feature: "E_UNKNOWN",
        label_ru: "Непокрытый признак",
        contribution: 0.2,
      },
    ],
    abstained: true,
    abstain_reason: "low_confidence",
    model_version: "fake-lr-v1",
  },
  urgency: "routine",
  urgency_reasons: ["недоверенный model output"],
  routing: [{ specialty: "терапия", confidence: 0.31 }],
};

export function fakeModel(
  counter: PortCounter,
  mode: "success" | "abstain" = "success",
): ModelPort {
  return {
    predict() {
      counter.calls += 1;
      return mode === "success" ? SUCCESSFUL_MODEL_RESULT : ABSTAIN_MODEL_RESULT;
    },
  };
}
