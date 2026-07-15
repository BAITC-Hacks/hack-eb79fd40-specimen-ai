import type { TriageResult } from "../../lib/types";

export const FRONTEND_RESULT: TriageResult = {
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
    chronic: ["гипертония"],
    allergies: [],
    medications: ["эналаприл"],
    context: {
      age: 58,
      sex: "m",
      pregnancy: "na",
      risk_factors: [],
    },
  },
  red_flags: [
    {
      code: "chest_pain",
      label: "Боль в груди с одышкой",
      evidence: "Болит в груди",
      evidence_kind: "quote",
      emergency: true,
      source_message_index: 1,
    },
  ],
  urgency: "emergency",
  urgency_reasons: ["Обнаружен красный флаг"],
  routing: [{ specialty: "кардиология", confidence: 0.72 }],
  hypothesis: {
    text: "Нужен срочный осмотр врача.",
    confidence: 0,
    disclaimer: "Это не диагноз, решение принимает врач.",
  },
  source: "rules_only",
};
