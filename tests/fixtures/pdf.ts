import type { ReadonlySession, TriageResult } from "../../lib/types";

export const PDF_RESULT: TriageResult = {
  anamnesis: {
    chief_complaint: "давящая боль в груди и одышка",
    symptom: {
      onset: "два часа назад",
      location: "за грудиной",
      quality: "давящая",
      severity: 8,
      modifiers: "усиливается при ходьбе",
      associated: ["одышка", "холодный пот"],
    },
    past_history: ["аппендэктомия"],
    chronic: ["артериальная гипертензия"],
    allergies: ["пенициллин"],
    medications: ["эналаприл"],
    context: {
      age: 58,
      sex: "m",
      pregnancy: "na",
      risk_factors: ["курение"],
    },
  },
  red_flags: [
    {
      code: "chest_pain",
      label: "Боль в груди с одышкой",
      evidence: "У меня давит в груди *_[]<>& и тяжело дышать",
      evidence_kind: "quote",
      emergency: true,
      source_message_index: 1,
      elicited_by: "Что вас беспокоит?",
    },
    {
      code: "elderly_severe",
      label: "Возраст и выраженная боль",
      evidence: "возраст 58 лет, сила боли 8/10",
      evidence_kind: "derived",
      emergency: false,
      source_message_index: -1,
    },
  ],
  urgency: "emergency",
  urgency_reasons: [
    "красный флаг: боль в груди с одышкой",
    "правило подняло приоритет независимо от модели",
  ],
  routing: [
    { specialty: "кардиология", confidence: 0.72 },
    { specialty: "неотложная помощь", confidence: 0.18 },
    { specialty: "терапия", confidence: 0.1 },
  ],
  hypothesis: {
    text: "Предварительная гипотеза: требуется исключить острое сердечно-сосудистое состояние.",
    confidence: 0.62,
    disclaimer: "Это предварительная гипотеза, а не диагноз. Решает врач.",
  },
  model: {
    pathologies: [
      {
        code: "p1",
        label_ru: "Острое коронарное состояние",
        prob: 0.62,
      },
      {
        code: "p2",
        label_ru: "Тромбоэмболическое состояние",
        prob: 0.16,
      },
    ],
    top_contributions: [
      {
        feature: "f1",
        label_ru: "давящая боль за грудиной",
        contribution: 2.41,
      },
      {
        feature: "f2",
        label_ru: "боль усиливается на вдохе",
        contribution: -0.35,
      },
    ],
    abstained: false,
    model_version: "test-lr-v1",
  },
  source: "model",
};

export const PDF_SESSION: ReadonlySession = {
  id: "pdf-session-123",
  doctorToken: "doctor-token-1234",
  language: "ru",
  messages: [
    { role: "assistant", content: "Что вас беспокоит?" },
    {
      role: "user",
      content: "У меня давит в груди *_[]<>& и тяжело дышать",
    },
    { role: "assistant", content: "Как давно это началось?" },
    { role: "user", content: "Два часа назад, боль восемь из десяти." },
  ],
  status: "completed",
  result: PDF_RESULT,
  turnCount: 2,
  deliveryStatus: "pending",
  createdAt: 1_721_000_000_000,
  completedAt: 1_721_000_240_000,
};
