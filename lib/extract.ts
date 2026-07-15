import {
  EVIDENCE_DICTIONARY,
  type EvidenceDictionary,
  type EvidenceValue,
} from "./evidence-dictionary";
import {
  LlmError,
  structured,
  type LlmDependencies,
} from "./llm";
import type { Anamnesis, ChatMessage, EvidenceVector } from "./types";

export interface ExtractionOut {
  anamnesis: Anamnesis;
  evidence: EvidenceVector;
  unmapped: string[];
  extraction_ok: boolean;
}

export type EvidenceRejectionReason =
  | "invalid_entry"
  | "unexpected_fields"
  | "invalid_code_type"
  | "empty_code"
  | "compound_code"
  | "unknown_code"
  | "missing_value"
  | "unexpected_value"
  | "invalid_value_type"
  | "empty_value"
  | "unknown_value"
  | "duplicate";

export interface EvidenceRejection {
  raw_index: number;
  reason: EvidenceRejectionReason;
  code?: string;
  value?: EvidenceValue | null;
}

export interface EvidenceAcceptance {
  raw_index: number;
  code: string;
  value?: EvidenceValue;
}

export interface ExtractionAudit {
  accepted: EvidenceAcceptance[];
  rejected: EvidenceRejection[];
  unmapped_rejected_indexes: number[];
  failure?: "no_patient_messages" | "llm_error" | "invalid_output";
}

export interface ExtractionResult extends ExtractionOut {
  audit: ExtractionAudit;
}

export interface ExtractionDependencies extends LlmDependencies {
  onAudit?: (audit: Readonly<ExtractionAudit>) => void;
  warn?: (message: string, metadata: Readonly<Record<string, unknown>>) => void;
}

interface RawEvidenceEnvelope {
  evidences: unknown[];
  age: number | null;
  sex: EvidenceVector["sex"];
}

interface RawExtraction {
  anamnesis: Anamnesis;
  evidence: RawEvidenceEnvelope;
  unmapped: string[];
  unmappedRejectedIndexes: number[];
}

const BASE_CODE = /^E_\d+$/u;

const ANAMNESIS_SCHEMA: Record<string, unknown> = {
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
      required: [
        "onset",
        "location",
        "quality",
        "severity",
        "modifiers",
        "associated",
      ],
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
};

export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    anamnesis: ANAMNESIS_SCHEMA,
    evidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        evidences: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              value: { type: ["string", "number", "null"] },
            },
            required: ["code"],
          },
        },
        age: { type: ["integer", "null"] },
        sex: { type: "string", enum: ["m", "f", "unknown"] },
      },
      required: ["evidences", "age", "sex"],
    },
    unmapped: { type: "array", items: { type: "string" } },
  },
  required: ["anamnesis", "evidence", "unmapped"],
};

const EXTRACT_SYSTEM = `Ты — модуль извлечения признаков из русского медицинского опроса.
Ты не ставишь диагноз, не определяешь срочность и не выбираешь маршрут.

Верни один анамнез, EvidenceVector и unmapped по следующим правилам:
1. Выбирай только базовые коды E_... из словаря ниже.
2. Для B-кода не передавай value. Для C/M-кода value обязателен и выбирается только из перечисленных значений.
3. Код ставится только по подтверждённым словам пациента. Вопрос ассистента сам по себе не является признаком.
4. Отрицание означает отсутствие: отрицавшийся признак не добавляй. Не выводи значения «нет», «nowhere» и другие значения отсутствия как присутствующий признак.
5. Короткий ответ пациента можно раскрыть только через непосредственно предшествующий вопрос ассистента.
6. Симптом без точного кода запиши дословно в unmapped. Не заменяй его похожим кодом.
7. Ничего не додумывай. Возраст и пол оставляй unknown/null, если пациент их не сообщил.

ЕДИНСТВЕННО ДОПУСТИМЫЙ СЛОВАРЬ:
${EVIDENCE_DICTIONARY.prompt}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const current = value[key];
  if (typeof current !== "string") throw new Error(`${label}.${key} must be a string`);
  return current;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value];
}

function age(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer or null`);
  }
  return value;
}

function sex(value: unknown, label: string): EvidenceVector["sex"] {
  if (value !== "m" && value !== "f" && value !== "unknown") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function pregnancy(value: unknown): Anamnesis["context"]["pregnancy"] {
  if (value !== "yes" && value !== "no" && value !== "na") {
    throw new Error("anamnesis.context.pregnancy is invalid");
  }
  return value;
}

function parseAnamnesis(raw: unknown): Anamnesis {
  if (!isRecord(raw)) throw new Error("anamnesis must be an object");
  assertExactKeys(
    raw,
    [
      "chief_complaint",
      "symptom",
      "past_history",
      "chronic",
      "allergies",
      "medications",
      "context",
    ],
    "anamnesis",
  );
  if (!isRecord(raw.symptom)) throw new Error("anamnesis.symptom must be an object");
  assertExactKeys(
    raw.symptom,
    ["onset", "location", "quality", "severity", "modifiers", "associated"],
    "anamnesis.symptom",
  );
  const severity = raw.symptom.severity;
  if (
    typeof severity !== "number" ||
    !Number.isInteger(severity) ||
    severity < 0 ||
    severity > 10
  ) {
    throw new Error("anamnesis.symptom.severity must be an integer from 0 to 10");
  }
  if (!isRecord(raw.context)) throw new Error("anamnesis.context must be an object");
  assertExactKeys(raw.context, ["age", "sex", "pregnancy", "risk_factors"], "anamnesis.context");

  return {
    chief_complaint: stringField(raw, "chief_complaint", "anamnesis"),
    symptom: {
      onset: stringField(raw.symptom, "onset", "anamnesis.symptom"),
      location: stringField(raw.symptom, "location", "anamnesis.symptom"),
      quality: stringField(raw.symptom, "quality", "anamnesis.symptom"),
      severity,
      modifiers: stringField(raw.symptom, "modifiers", "anamnesis.symptom"),
      associated: stringArray(raw.symptom.associated, "anamnesis.symptom.associated"),
    },
    past_history: stringArray(raw.past_history, "anamnesis.past_history"),
    chronic: stringArray(raw.chronic, "anamnesis.chronic"),
    allergies: stringArray(raw.allergies, "anamnesis.allergies"),
    medications: stringArray(raw.medications, "anamnesis.medications"),
    context: {
      age: age(raw.context.age, "anamnesis.context.age"),
      sex: sex(raw.context.sex, "anamnesis.context.sex"),
      pregnancy: pregnancy(raw.context.pregnancy),
      risk_factors: stringArray(raw.context.risk_factors, "anamnesis.context.risk_factors"),
    },
  };
}

function parseRawExtraction(raw: unknown): RawExtraction {
  if (!isRecord(raw)) throw new Error("extraction must be an object");
  assertExactKeys(raw, ["anamnesis", "evidence", "unmapped"], "extraction");
  const anamnesis = parseAnamnesis(raw.anamnesis);
  if (!isRecord(raw.evidence)) throw new Error("evidence must be an object");
  assertExactKeys(raw.evidence, ["evidences", "age", "sex"], "evidence");
  if (!Array.isArray(raw.evidence.evidences)) {
    throw new Error("evidence.evidences must be an array");
  }
  const evidenceAge = age(raw.evidence.age, "evidence.age");
  const evidenceSex = sex(raw.evidence.sex, "evidence.sex");
  if (evidenceAge !== anamnesis.context.age || evidenceSex !== anamnesis.context.sex) {
    throw new Error("evidence demographics differ from anamnesis context");
  }
  if (!Array.isArray(raw.unmapped)) throw new Error("unmapped must be an array");
  const unmapped: string[] = [];
  const unmappedRejectedIndexes: number[] = [];
  raw.unmapped.forEach((item, index) => {
    if (typeof item === "string" && item.trim()) unmapped.push(item);
    else unmappedRejectedIndexes.push(index);
  });
  return {
    anamnesis,
    evidence: {
      evidences: raw.evidence.evidences,
      age: evidenceAge,
      sex: evidenceSex,
    },
    unmapped,
    unmappedRejectedIndexes,
  };
}

function rejectedReference(rejection: EvidenceRejection): string | undefined {
  if (
    rejection.reason === "duplicate" ||
    rejection.reason === "invalid_entry" ||
    rejection.reason === "unexpected_fields" ||
    rejection.reason === "empty_code"
  ) {
    return undefined;
  }
  const code = rejection.code?.trim();
  if (!code) return undefined;
  const value = rejection.value === undefined || rejection.value === null
    ? ""
    : `=${String(rejection.value)}`;
  return `непринятый признак ${code}${value}`;
}

function sanitizeEvidences(
  rawItems: readonly unknown[],
  dictionary: EvidenceDictionary,
): {
  evidences: EvidenceVector["evidences"];
  accepted: EvidenceAcceptance[];
  rejected: EvidenceRejection[];
} {
  const evidences: EvidenceVector["evidences"] = [];
  const accepted: EvidenceAcceptance[] = [];
  const rejected: EvidenceRejection[] = [];
  const seen = new Set<string>();

  const reject = (
    raw_index: number,
    reason: EvidenceRejectionReason,
    code?: string,
    value?: EvidenceValue | null,
  ): void => {
    rejected.push({ raw_index, reason, ...(code !== undefined ? { code } : {}), ...(value !== undefined ? { value } : {}) });
  };

  rawItems.forEach((item, rawIndex) => {
    if (!isRecord(item)) {
      reject(rawIndex, "invalid_entry");
      return;
    }
    const keys = Object.keys(item);
    if (keys.some((key) => key !== "code" && key !== "value")) {
      reject(rawIndex, "unexpected_fields");
      return;
    }
    if (typeof item.code !== "string") {
      reject(rawIndex, "invalid_code_type");
      return;
    }
    const code = item.code;
    if (!code.trim()) {
      reject(rawIndex, "empty_code", code);
      return;
    }
    if (!BASE_CODE.test(code)) {
      reject(rawIndex, code.includes("@") ? "compound_code" : "unknown_code", code);
      return;
    }
    const entry = dictionary.entries.get(code);
    if (!entry) {
      reject(rawIndex, "unknown_code", code);
      return;
    }

    const hasValue = Object.prototype.hasOwnProperty.call(item, "value") && item.value !== null;
    if (entry.data_type === "B") {
      if (hasValue) {
        const value = typeof item.value === "string" || typeof item.value === "number"
          ? item.value
          : undefined;
        reject(rawIndex, "unexpected_value", code, value);
        return;
      }
      if (seen.has(code)) {
        reject(rawIndex, "duplicate", code);
        return;
      }
      seen.add(code);
      evidences.push({ code });
      accepted.push({ raw_index: rawIndex, code });
      return;
    }

    if (!hasValue) {
      reject(rawIndex, "missing_value", code, null);
      return;
    }
    if (typeof item.value !== "string" && typeof item.value !== "number") {
      reject(rawIndex, "invalid_value_type", code);
      return;
    }
    if (
      (typeof item.value === "string" && !item.value.trim()) ||
      (typeof item.value === "number" && !Number.isFinite(item.value))
    ) {
      reject(rawIndex, "empty_value", code, item.value);
      return;
    }
    if (!entry.possible_values.some((value) => String(value) === String(item.value))) {
      reject(rawIndex, "unknown_value", code, item.value);
      return;
    }
    const key = `${code}@${String(item.value)}`;
    if (!dictionary.entries.has(key)) {
      reject(rawIndex, "unknown_value", code, item.value);
      return;
    }
    const deduplicationKey = entry.data_type === "C" ? code : key;
    if (seen.has(deduplicationKey)) {
      reject(rawIndex, "duplicate", code, item.value);
      return;
    }
    seen.add(deduplicationKey);
    evidences.push({ code, value: item.value });
    accepted.push({ raw_index: rawIndex, code, value: item.value });
  });

  return { evidences, accepted, rejected };
}

export function sanitizeEvidenceOutput(
  evidence: Pick<EvidenceVector, "age" | "sex"> & {
    evidences: readonly unknown[];
  },
  unmapped: readonly string[],
): {
  evidence: EvidenceVector;
  unmapped: string[];
  accepted: EvidenceAcceptance[];
  rejected: EvidenceRejection[];
} {
  const sanitized = sanitizeEvidences(
    evidence.evidences,
    EVIDENCE_DICTIONARY,
  );
  const rejectedUnmapped = sanitized.rejected
    .map(rejectedReference)
    .filter((value): value is string => value !== undefined);
  return {
    evidence: {
      evidences: sanitized.evidences,
      age: evidence.age,
      sex: evidence.sex,
    },
    unmapped: [...unmapped, ...rejectedUnmapped],
    accepted: sanitized.accepted,
    rejected: sanitized.rejected,
  };
}

function emptyAnamnesis(): Anamnesis {
  return {
    chief_complaint: "",
    symptom: {
      onset: "",
      location: "",
      quality: "",
      severity: 0,
      modifiers: "",
      associated: [],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: {
      age: null,
      sex: "unknown",
      pregnancy: "na",
      risk_factors: [],
    },
  };
}

function failedResult(
  failure: NonNullable<ExtractionAudit["failure"]>,
  onAudit?: ExtractionDependencies["onAudit"],
): ExtractionResult {
  const audit: ExtractionAudit = {
    accepted: [],
    rejected: [],
    unmapped_rejected_indexes: [],
    failure,
  };
  onAudit?.(audit);
  return {
    anamnesis: emptyAnamnesis(),
    evidence: { evidences: [], age: null, sex: "unknown" },
    unmapped: [],
    extraction_ok: false,
    audit,
  };
}

function renderTranscript(messages: readonly ChatMessage[]): string {
  return messages
    .map(
      (message, index) =>
        `[${index}] ${message.role === "user" ? "ПАЦИЕНТ" : "АССИСТЕНТ"}: ${message.content}`,
    )
    .join("\n");
}

export async function extractAll(
  messages: readonly ChatMessage[],
  deps: ExtractionDependencies = {},
): Promise<ExtractionResult> {
  const warn = deps.warn ?? console.warn;
  if (!messages.some((message) => message.role === "user" && message.content.trim())) {
    return failedResult("no_patient_messages", deps.onAudit);
  }

  try {
    const raw = await structured<unknown>(
      EXTRACT_SYSTEM,
      renderTranscript(messages),
      EXTRACT_SCHEMA,
      deps,
    );
    const parsed = parseRawExtraction(raw);
    const sanitized = sanitizeEvidenceOutput(parsed.evidence, parsed.unmapped);
    const audit: ExtractionAudit = {
      accepted: sanitized.accepted,
      rejected: sanitized.rejected,
      unmapped_rejected_indexes: parsed.unmappedRejectedIndexes,
    };
    deps.onAudit?.(audit);
    if (audit.rejected.length > 0 || audit.unmapped_rejected_indexes.length > 0) {
      const reasonCounts = audit.rejected.reduce<Record<string, number>>(
        (counts, rejection) => ({
          ...counts,
          [rejection.reason]: (counts[rejection.reason] ?? 0) + 1,
        }),
        {},
      );
      warn("[extract] rejected untrusted output entries", {
        reasons: reasonCounts,
        unmapped_rejected: audit.unmapped_rejected_indexes.length,
      });
    }
    return {
      anamnesis: parsed.anamnesis,
      evidence: sanitized.evidence,
      unmapped: sanitized.unmapped,
      extraction_ok: true,
      audit,
    };
  } catch (error) {
    const failure = error instanceof LlmError ? "llm_error" : "invalid_output";
    warn("[extract] adapter unavailable", { failure });
    return failedResult(failure, deps.onAudit);
  }
}
