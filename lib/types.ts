// Общие типы приложения Demeu (GovTech Camp).

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type HistoryStatusValue = "reported" | "denied" | "not_stated";

export interface HistoryStatus {
  past_history: HistoryStatusValue;
  chronic: HistoryStatusValue;
  allergies: HistoryStatusValue;
  medications: HistoryStatusValue;
}

// Историческая форма нужна только для чтения сохранённых до schema v2 сводок.
export interface LegacyAnamnesis {
  chief_complaint: string;
  symptom: {
    onset: string;
    location: string;
    quality: string;
    severity: number | null; // 0..10 со слов пациента; null, если сила не названа
    modifiers: string;
    associated: string[];
  };
  past_history: string[];
  chronic: string[];
  allergies: string[];
  medications: string[];
  context: {
    age: number | null;
    sex: "m" | "f" | "unknown";
    pregnancy: "yes" | "no" | "na";
    risk_factors: string[];
  };
}

export interface NormalizedAnamnesis extends LegacyAnamnesis {
  history_status: HistoryStatus;
  negative_findings: string[];
}

// Новые результаты всегда NormalizedAnamnesis; union сохраняет чтение старых snapshots.
export type Anamnesis = LegacyAnamnesis | NormalizedAnamnesis;

const HISTORY_STATUS_VALUES = new Set<HistoryStatusValue>([
  "reported",
  "denied",
  "not_stated",
]);

function normalizedHistoryStatus(
  value: unknown,
  reportedItems: readonly string[],
): HistoryStatusValue {
  if (reportedItems.length > 0) return "reported";
  return HISTORY_STATUS_VALUES.has(value as HistoryStatusValue) && value === "denied"
    ? "denied"
    : "not_stated";
}

/**
 * Upgrade historical persisted results and fixtures created before explicit
 * negative findings were added. Missing status never means that the patient
 * denied a finding: legacy empty arrays normalize to `not_stated`.
 */
export function normalizeAnamnesis(value: Anamnesis): NormalizedAnamnesis {
  const current = value as LegacyAnamnesis & Partial<NormalizedAnamnesis>;
  const negativeFindings = Array.isArray(current.negative_findings)
    ? [...new Set(current.negative_findings
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean))]
    : [];

  return {
    ...value,
    history_status: {
      past_history: normalizedHistoryStatus(
        current.history_status?.past_history,
        value.past_history,
      ),
      chronic: normalizedHistoryStatus(
        current.history_status?.chronic,
        value.chronic,
      ),
      allergies: normalizedHistoryStatus(
        current.history_status?.allergies,
        value.allergies,
      ),
      medications: normalizedHistoryStatus(
        current.history_status?.medications,
        value.medications,
      ),
    },
    negative_findings: negativeFindings,
  };
}

export type Urgency = "routine" | "planned" | "urgent" | "emergency";

// Сработавший красный флаг с объяснением — для explainability.
export interface RedFlag {
  code: string;
  label: string;
  evidence: string;
  evidence_kind: "quote" | "derived";
  emergency: boolean;
  source_message_index: number;
  elicited_by?: string;
}

// Вектор признаков в пространстве DDXPlus (выход LLM-адаптера).
export interface EvidenceVector {
  evidences: { code: string; value?: string | number }[];
  age: number | null;
  sex: "m" | "f" | "unknown";
}

export interface FeatureContribution {
  feature: string;
  label_ru: string;
  contribution: number;
}

export interface ModelPrediction {
  pathologies: {
    code: string;
    label_ru: string;
    prob: number;
    icd10?: string;
  }[];
  top_contributions: FeatureContribution[];
  abstained: boolean;
  abstain_reason?: "low_confidence" | "out_of_label_space";
  model_version: string;
}

// Результат аналитического слоя (то, что видит врач).
export interface TriageResult {
  anamnesis: Anamnesis;
  red_flags: RedFlag[];
  urgency: Urgency;
  urgency_reasons: string[];
  routing: { specialty: string; confidence: number }[]; // top-3 маршрутизация
  hypothesis: {
    text: string;
    confidence: number;
    disclaimer: string; // «это не диагноз, решает врач»
  };
  model?: ModelPrediction;
  source: "model" | "llm_fallback" | "rules_only";
  /** Added in September; absent on historical persisted results. */
  processing_mode?: "external_llm" | "deterministic";
}

// Сессия пациента.
export interface Session {
  id: string;
  doctorToken: string;
  language: "ru" | "kk";
  messages: ChatMessage[];
  status: "collecting" | "completed" | "aborted";
  result?: TriageResult;
  turnCount: number;
  deliveryStatus: "pending" | "sent" | "failed";
  notifiedAt?: number;
  createdAt: number;
  completedAt?: number;
}

export type ReadonlySession = Readonly<Omit<Session, "messages">> & {
  readonly messages: readonly ChatMessage[];
};
