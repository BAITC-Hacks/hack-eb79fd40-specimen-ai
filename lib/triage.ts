import { structured } from "./llm";
import { detectRedFlags } from "./redflags";
import type { Anamnesis, ChatMessage, TriageResult, Urgency } from "./types";

// ============================================================================
// АНАЛИТИЧЕСКИЙ СЛОЙ (AI-ядро продукта).
//
// Это ШОВ с ML-треком Алмаза. Сейчас — LLM + rule-based реализация, чтобы
// демо работало end-to-end уже сегодня. Алмаз подменяет внутренности
// `analyze()` на обученные модели (скоринг срочности / классификатор
// маршрутизации на DDXPlus + открытых датасетах), сохраняя сигнатуру и
// формат TriageResult. Красные флаги (redflags.ts) остаются rule-based ради
// объяснимости.
// ============================================================================

const EXTRACT_SYSTEM = `Ты — медицинский аналитический модуль. По транскрипту первичного опроса пациента:
1) извлеки структурированный анамнез;
2) оцени срочность (routine | planned | urgent | emergency) и перечисли причины;
3) предложи маршрутизацию к специалисту (top-3 с вероятностями 0..1);
4) сформируй ПРЕДВАРИТЕЛЬНУЮ ГИПОТЕЗУ (НЕ диагноз) с уверенностью 0..1.

Правила:
- Ты не ставишь диагноз. Гипотеза — это версия для врача, финальное решение за человеком.
- Опирайся только на сказанное пациентом; не выдумывай факты.
- Язык вывода — русский.`;

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    anamnesis: {
      type: "object",
      additionalProperties: false,
      properties: {
        chief_complaint: { type: "string" },
        symptom: {
          type: "object",
          additionalProperties: false,
          properties: {
            onset: { type: "string" },
            location: { type: "string" },
            quality: { type: "string" },
            severity: { type: "integer" },
            modifiers: { type: "string" },
            associated: { type: "array", items: { type: "string" } },
          },
          required: ["onset", "location", "quality", "severity", "modifiers", "associated"],
        },
        past_history: { type: "array", items: { type: "string" } },
        chronic: { type: "array", items: { type: "string" } },
        allergies: { type: "array", items: { type: "string" } },
        medications: { type: "array", items: { type: "string" } },
        context: {
          type: "object",
          additionalProperties: false,
          properties: {
            age: { type: ["integer", "null"] },
            sex: { type: "string", enum: ["m", "f", "unknown"] },
            pregnancy: { type: "string", enum: ["yes", "no", "na"] },
            risk_factors: { type: "array", items: { type: "string" } },
          },
          required: ["age", "sex", "pregnancy", "risk_factors"],
        },
      },
      required: [
        "chief_complaint",
        "symptom",
        "past_history",
        "chronic",
        "allergies",
        "medications",
        "context",
      ],
    },
    urgency: { type: "string", enum: ["routine", "planned", "urgent", "emergency"] },
    urgency_reasons: { type: "array", items: { type: "string" } },
    routing: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          specialty: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["specialty", "confidence"],
      },
    },
    hypothesis: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["text", "confidence"],
    },
  },
  required: ["anamnesis", "urgency", "urgency_reasons", "routing", "hypothesis"],
};

interface ModelOut {
  anamnesis: Anamnesis;
  urgency: Urgency;
  urgency_reasons: string[];
  routing: { specialty: string; confidence: number }[];
  hypothesis: { text: string; confidence: number };
}

const DISCLAIMER =
  "Это предварительная гипотеза, а не диагноз. Финальное решение принимает врач.";

const RANK: Record<Urgency, number> = {
  routine: 0,
  planned: 1,
  urgent: 2,
  emergency: 3,
};

function transcriptText(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "Пациент" : "Ассистент"}: ${m.content}`)
    .join("\n");
}

export async function analyze(messages: ChatMessage[]): Promise<TriageResult> {
  const transcript = transcriptText(messages);
  const out = await structured<ModelOut>(EXTRACT_SYSTEM, transcript, SCHEMA);

  // Rule-based красные флаги поверх модели — объяснимый слой.
  const red_flags = detectRedFlags(transcript, out.anamnesis);

  // Срочность: берём максимум из модели и правил. Emergency-флаг доминирует.
  let urgency = out.urgency;
  const reasons = [...out.urgency_reasons];
  const emergencyFlag = red_flags.find((f) => f.emergency);
  if (emergencyFlag && RANK[urgency] < RANK.emergency) {
    urgency = "emergency";
    reasons.unshift(`красный флаг: ${emergencyFlag.label} (${emergencyFlag.evidence})`);
  }

  return {
    anamnesis: out.anamnesis,
    red_flags,
    urgency,
    urgency_reasons: reasons,
    routing: out.routing.slice(0, 3),
    hypothesis: { ...out.hypothesis, disclaimer: DISCLAIMER },
  };
}
