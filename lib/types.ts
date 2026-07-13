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
    severity: number; // 0..10
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
  evidence: string; // конкретный фрагмент/признак, вызвавший флаг
  emergency: boolean; // true => советуем 103 / приёмный покой
}

// Результат аналитического слоя (то, что видит врач).
export interface TriageResult {
  anamnesis: Anamnesis;
  red_flags: RedFlag[];
  urgency: Urgency;
  urgency_reasons: string[];
  routing: { specialty: string; confidence: number }[]; // top-N маршрутизация
  hypothesis: {
    text: string;
    confidence: number;
    disclaimer: string; // «это не диагноз, решает врач»
  };
}

// Сессия пациента.
export interface Session {
  id: string;
  doctorToken: string;
  language: "ru" | "kk";
  messages: ChatMessage[];
  status: "collecting" | "completed";
  result?: TriageResult;
  createdAt: number;
}
