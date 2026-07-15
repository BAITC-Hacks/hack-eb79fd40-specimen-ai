import rawEvidenceDictionary from "@/data/evidences_ru.json";

export type EvidenceDataType = "B" | "C" | "M";
export type EvidenceValue = string | number;

export interface EvidenceDictionaryEntry {
  code: string;
  name: string;
  question_en: string;
  label_ru: string;
  question_ru: string;
  data_type: EvidenceDataType;
  possible_values: readonly EvidenceValue[];
  translation_status: "curated" | "mechanical_neutral";
  feature_value?: string;
  value_en?: string | null;
}

export interface EvidenceDictionary {
  entries: ReadonlyMap<string, EvidenceDictionaryEntry>;
  baseEntries: readonly EvidenceDictionaryEntry[];
  prompt: string;
}

const BASE_CODE = /^E_\d+$/u;
const FEATURE_CODE = /^(E_\d+)@(.+)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const current = value[key];
  if (typeof current !== "string" || !current.trim()) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return current;
}

function dataType(value: unknown, label: string): EvidenceDataType {
  if (value !== "B" && value !== "C" && value !== "M") {
    throw new Error(`${label}.data_type must be B, C, or M`);
  }
  return value;
}

function possibleValues(value: unknown, label: string): EvidenceValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}.possible_values must be an array`);
  }
  const result: EvidenceValue[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      (typeof item !== "string" || !item.trim()) &&
      (typeof item !== "number" || !Number.isFinite(item))
    ) {
      throw new Error(`${label}.possible_values contains an invalid value`);
    }
    const normalized = String(item);
    if (seen.has(normalized)) {
      throw new Error(`${label}.possible_values contains a duplicate`);
    }
    seen.add(normalized);
    result.push(item);
  }
  return result;
}

function parseEntry(
  code: string,
  raw: unknown,
): EvidenceDictionaryEntry {
  if (!isRecord(raw)) throw new Error(`${code} must be an object`);
  const type = dataType(raw.data_type, code);
  const values = possibleValues(raw.possible_values, code);
  if (type === "B" && values.length > 0) {
    throw new Error(`${code}: binary evidence cannot define values`);
  }
  if (type !== "B" && values.length === 0) {
    throw new Error(`${code}: categorical evidence must define values`);
  }
  const status = raw.translation_status;
  if (status !== "curated" && status !== "mechanical_neutral") {
    throw new Error(`${code}.translation_status is invalid`);
  }
  const featureMatch = FEATURE_CODE.exec(code);
  let featureValue: string | undefined;
  let valueEn: string | null | undefined;
  if (featureMatch) {
    featureValue = requiredString(raw, "feature_value", code);
    if (featureValue !== featureMatch[2]) {
      throw new Error(`${code}.feature_value does not match its key`);
    }
    if (raw.value_en !== null && typeof raw.value_en !== "string") {
      throw new Error(`${code}.value_en must be a string or null`);
    }
    valueEn = raw.value_en;
  }
  return {
    code,
    name: requiredString(raw, "name", code),
    question_en: requiredString(raw, "question_en", code),
    label_ru: requiredString(raw, "label_ru", code),
    question_ru: requiredString(raw, "question_ru", code),
    data_type: type,
    possible_values: values,
    translation_status: status,
    ...(featureValue !== undefined ? { feature_value: featureValue } : {}),
    ...(valueEn !== undefined ? { value_en: valueEn } : {}),
  };
}

function renderPrompt(
  bases: readonly EvidenceDictionaryEntry[],
  entries: ReadonlyMap<string, EvidenceDictionaryEntry>,
): string {
  return bases
    .map((entry) => {
      const values = entry.possible_values.map((value) => {
        const feature = entries.get(`${entry.code}@${String(value)}`);
        const source = feature?.value_en?.trim();
        const sourceSuffix = source ? ` [source: ${source}]` : "";
        return `${String(value)}=${feature?.label_ru ?? "недоступная подпись"}${sourceSuffix}`;
      });
      const valueSuffix = values.length > 0 ? ` | значения: ${values.join("; ")}` : "";
      return [
        entry.code,
        entry.data_type,
        entry.label_ru,
        `вопрос-источник: ${entry.question_en}`,
      ].join(" | ") + valueSuffix;
    })
    .join("\n");
}

export function validateEvidenceDictionary(raw: unknown): EvidenceDictionary {
  if (!isRecord(raw)) throw new Error("evidence dictionary must be an object");
  if (!isRecord(raw._meta) || raw._meta.frozen !== true) {
    throw new Error("evidence dictionary must have frozen _meta");
  }

  const entries = new Map<string, EvidenceDictionaryEntry>();
  for (const [code, value] of Object.entries(raw).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (code === "_meta") continue;
    if (!BASE_CODE.test(code) && !FEATURE_CODE.test(code)) {
      throw new Error(`invalid dictionary key: ${code}`);
    }
    entries.set(code, parseEntry(code, value));
  }

  const bases = [...entries.values()].filter((entry) => BASE_CODE.test(entry.code));
  if (bases.length === 0) throw new Error("evidence dictionary has no base codes");

  for (const base of bases) {
    if (base.name !== base.code) {
      throw new Error(`${base.code}.name must match its code`);
    }
    for (const value of base.possible_values) {
      const featureCode = `${base.code}@${String(value)}`;
      const feature = entries.get(featureCode);
      if (!feature) throw new Error(`missing dictionary feature ${featureCode}`);
      if (feature.name !== base.code || feature.data_type !== base.data_type) {
        throw new Error(`${featureCode} does not match its base evidence`);
      }
    }
  }

  for (const entry of entries.values()) {
    const match = FEATURE_CODE.exec(entry.code);
    if (!match) continue;
    const [, baseCode, rawValue] = match;
    const base = entries.get(baseCode);
    if (!base || !base.possible_values.some((value) => String(value) === rawValue)) {
      throw new Error(`${entry.code} is not declared by its base evidence`);
    }
  }

  return {
    entries,
    baseEntries: bases,
    prompt: renderPrompt(bases, entries),
  };
}

export const EVIDENCE_DICTIONARY = validateEvidenceDictionary(
  rawEvidenceDictionary as unknown,
);
