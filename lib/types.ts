// Общие типы приложения Demeu (GovTech Camp).

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// Структурированный анамнез — результат извлечения из свободного текста.
export interface Anamnesis {
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
