import type { ChatMessage, TriageResult, Urgency } from "../../lib/types";

const URGENCIES: readonly Urgency[] = [
  "routine",
  "planned",
  "urgent",
  "emergency",
];

export function assertTriageInvariants(
  result: TriageResult,
  messages: readonly ChatMessage[],
): void {
  const fail = (message: string): never => {
    throw new Error(
      `[INVARIANT] ${message}\n${JSON.stringify(result, null, 2)}`,
    );
  };

  if (result.red_flags.some((flag) => flag.emergency)) {
    if (result.urgency !== "emergency") {
      fail("emergency red flag не повысил urgency до emergency");
    }
    if (result.urgency_reasons.length === 0) {
      fail("emergency не объяснён в urgency_reasons");
    }
  }

  for (const flag of result.red_flags) {
    if (!flag.code.trim() || !flag.label.trim()) {
      fail("red flag содержит пустой code/label");
    }
    if (typeof flag.emergency !== "boolean") {
      fail(`red flag ${flag.code}: emergency не boolean`);
    }
    if (!Number.isInteger(flag.source_message_index)) {
      fail(`red flag ${flag.code}: source_message_index не целый`);
    }
    if (flag.evidence.trim().length === 0) {
      fail(`red flag ${flag.code}: evidence пустой`);
    }
    if (flag.evidence_kind === "derived") {
      if (flag.source_message_index !== -1) {
        fail(`red flag ${flag.code}: derived требует индекс -1`);
      }
      continue;
    }
    if (flag.evidence_kind !== "quote") {
      fail(`red flag ${flag.code}: неизвестный evidence_kind`);
    }

    const source = messages[flag.source_message_index];
    if (!source || source.role !== "user") {
      fail(`red flag ${flag.code}: source_message_index не указывает на пациента`);
    }
    if (!source.content.includes(flag.evidence)) {
      fail(`red flag ${flag.code}: evidence не является голой подстрокой`);
    }
    const occurrences = [...source.content.matchAll(new RegExp(escapeRegex(flag.evidence), "gu"))];
    const hasWholeEnding = occurrences.some((match) => {
      const after = source.content[match.index + match[0].length];
      return after === undefined || !/\p{L}/u.test(after);
    });
    if (!hasWholeEnding) {
      fail(`red flag ${flag.code}: evidence обрывается посреди слова`);
    }
    if (flag.elicited_by !== undefined && flag.elicited_by.trim().length === 0) {
      fail(`red flag ${flag.code}: elicited_by задан пустым`);
    }
  }

  if (!URGENCIES.includes(result.urgency)) fail("urgency вне enum");
  const anamnesisKeys = [
    "chief_complaint",
    "symptom",
    "past_history",
    "chronic",
    "allergies",
    "medications",
    "context",
  ] as const;
  for (const key of anamnesisKeys) {
    if (!(key in result.anamnesis)) fail(`anamnesis.${key} отсутствует`);
  }
  for (const key of [
    "chief_complaint",
  ] as const) {
    if (typeof result.anamnesis[key] !== "string") {
      fail(`anamnesis.${key} не строка`);
    }
  }
  for (const key of ["onset", "location", "quality", "modifiers"] as const) {
    if (typeof result.anamnesis.symptom[key] !== "string") {
      fail(`anamnesis.symptom.${key} не строка`);
    }
  }
  if (!Array.isArray(result.anamnesis.past_history)) fail("past_history не массив");
  if (!Array.isArray(result.anamnesis.chronic)) fail("chronic не массив");
  if (!Array.isArray(result.anamnesis.allergies)) fail("allergies не массив");
  if (!Array.isArray(result.anamnesis.medications)) fail("medications не массив");
  if (!Array.isArray(result.anamnesis.symptom.associated)) fail("associated не массив");
  if (!Array.isArray(result.anamnesis.context.risk_factors)) fail("risk_factors не массив");
  if (
    result.anamnesis.symptom.severity !== null &&
    (!Number.isFinite(result.anamnesis.symptom.severity) ||
      !Number.isInteger(result.anamnesis.symptom.severity) ||
      result.anamnesis.symptom.severity < 0 ||
      result.anamnesis.symptom.severity > 10)
  ) {
    fail("severity вне 0..10 или null");
  }
  const { age, sex, pregnancy } = result.anamnesis.context;
  if (age !== null && (!Number.isFinite(age) || age < 0 || age > 120)) {
    fail("context.age вне 0..120 или null");
  }
  if (!["m", "f", "unknown"].includes(sex)) fail("context.sex вне enum");
  if (!["yes", "no", "na"].includes(pregnancy)) {
    fail("context.pregnancy вне enum");
  }
  if (!Array.isArray(result.red_flags)) fail("red_flags не массив");
  if (!Array.isArray(result.urgency_reasons)) fail("urgency_reasons не массив");
  if (result.urgency_reasons.some((reason) => typeof reason !== "string")) {
    fail("urgency_reasons содержит не строку");
  }
  if (!Array.isArray(result.routing)) fail("routing не массив");
  if (result.routing.length > 3) fail("routing длиннее top-3");
  if (result.source !== "rules_only" && result.routing.length === 0) {
    fail("routing пуст на успешном аналитическом пути");
  }
  for (let index = 0; index < result.routing.length; index += 1) {
    const route = result.routing[index];
    if (!route.specialty.trim()) fail("routing.specialty пуст");
    if (
      !Number.isFinite(route.confidence) ||
      route.confidence < 0 ||
      route.confidence > 1
    ) {
      fail("routing.confidence вне 0..1");
    }
    if (
      index > 0 &&
      result.routing[index - 1].confidence < route.confidence
    ) {
      fail("routing не отсортирован по убыванию confidence");
    }
  }
  if (!result.hypothesis.text.trim()) fail("hypothesis.text пустой");
  if (
    !Number.isFinite(result.hypothesis.confidence) ||
    result.hypothesis.confidence < 0 ||
    result.hypothesis.confidence > 1
  ) {
    fail("hypothesis.confidence вне 0..1");
  }
  if (!["model", "llm_fallback", "rules_only"].includes(result.source)) {
    fail("source вне enum");
  }

  if (result.model) {
    if (!result.model.model_version.trim()) fail("model.model_version пустой");
    if (!Array.isArray(result.model.pathologies)) {
      fail("model.pathologies не массив");
    }
    if (!Array.isArray(result.model.top_contributions)) {
      fail("model.top_contributions не плоский массив");
    }
    if (
      result.model.abstain_reason !== undefined &&
      !["low_confidence", "out_of_label_space"].includes(
        result.model.abstain_reason,
      )
    ) {
      fail("model.abstain_reason вне enum");
    }
  }

  if (result.source === "rules_only" && result.model !== undefined) {
    fail("rules_only содержит model, хотя модель не считалась");
  }
  if (result.source === "model") {
    const model = result.model;
    if (!model) {
      throw new Error('[INVARIANT] source="model" без model');
    }
    if (model.abstained) fail("source=model при abstained=true");
    if (model.pathologies.length === 0) fail("model.pathologies пуст");
    if (model.pathologies.length > 5) fail("model.pathologies длиннее top-5");
    if (!model.model_version.trim()) fail("model.model_version пустой");
    for (const pathology of model.pathologies) {
      if (!pathology.code.trim() || !pathology.label_ru.trim()) {
        fail("model.pathologies содержит пустой code/label_ru");
      }
      if (
        !Number.isFinite(pathology.prob) ||
        pathology.prob < 0 ||
        pathology.prob > 1
      ) {
        fail("model.pathologies.prob вне 0..1");
      }
    }
    if (!Array.isArray(model.top_contributions)) {
      fail("model.top_contributions не плоский массив");
    }
    for (const contribution of model.top_contributions) {
      if (
        !contribution.feature.trim() ||
        !contribution.label_ru.trim() ||
        !Number.isFinite(contribution.contribution)
      ) {
        fail("model.top_contributions содержит неполный вклад");
      }
    }
    if (
      Math.abs(
        result.hypothesis.confidence - model.pathologies[0].prob,
      ) > 1e-9
    ) {
      fail("model confidence не равен top-1 probability");
    }
  }
  if (result.source === "llm_fallback") {
    if (result.hypothesis.confidence > 0.5) {
      fail("llm_fallback confidence выше 0.5");
    }
    if (result.model) {
      if (!result.model.abstained) fail("llm_fallback model не abstained");
      if (
        result.model.pathologies.length !== 0 ||
        result.model.top_contributions.length !== 0
      ) {
        fail("abstained model раскрывает недоверенные числа");
      }
    }
  }
  if (result.source === "rules_only" && result.hypothesis.confidence !== 0) {
    fail("rules_only confidence не равен 0");
  }

  const disclaimer = result.hypothesis.disclaimer;
  if (!disclaimer.trim()) fail("hypothesis.disclaimer пустой");
  if (!/не\s+диагноз/iu.test(disclaimer) || !/решает\s+врач/iu.test(disclaimer)) {
    fail("disclaimer не содержит оговорку «не диагноз, решает врач»");
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
