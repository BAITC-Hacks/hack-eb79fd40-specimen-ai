import pathologyMapJson from "../data/pathology_map.json";

import {
  extractAll,
  sanitizeEvidenceOutput,
  type ExtractionDependencies,
} from "./extract";
import {
  buildVector,
  loadArtifact,
  predict as predictModel,
  type ModelArtifact,
} from "./model";
import { assembleDeterministicAnamnesis } from "./deterministic";
import {
  PROCESSING_MODE,
  type ProcessingMode,
} from "./processing-mode";
import {
  ABSTAIN_HYPOTHESIS,
  DETERMINISTIC_HYPOTHESIS,
  DISCLAIMER,
  RULES_ONLY_HYPOTHESIS,
} from "./clinical-copy";
export {
  ABSTAIN_HYPOTHESIS,
  DETERMINISTIC_HYPOTHESIS,
  DISCLAIMER,
  RULES_ONLY_HYPOTHESIS,
} from "./clinical-copy";
import { contextFlags, detectRedFlags } from "./redflags";
import type {
  Anamnesis,
  ChatMessage,
  EvidenceVector,
  ModelPrediction,
  RedFlag,
  TriageResult,
  Urgency,
} from "./types";
import { normalizeAnamnesis } from "./types";

export interface LlmAnalysis {
  anamnesis: Anamnesis;
  evidence: EvidenceVector;
  unmapped: string[];
  urgency: Urgency;
  urgency_reasons: string[];
  routing: { specialty: string; confidence: number }[];
  hypothesis: { text: string; confidence: number };
}

export interface LlmPort {
  analyze(messages: readonly ChatMessage[]): Promise<LlmAnalysis>;
}

export interface ModelPortResult {
  prediction: ModelPrediction;
  /** Used by the analytical layer; prediction itself never owns abstain. */
  abstain_threshold?: number;
  /** Optional routing metadata supplied by injected adapters. */
  urgency?: Urgency;
  urgency_reasons?: string[];
  routing?: { specialty: string; confidence: number }[];
}

export interface ModelPort {
  predict(
    evidence: EvidenceVector,
    unmapped: readonly string[],
  ): Promise<ModelPortResult> | ModelPortResult;
}

const ANALYTICAL_HYPOTHESIS_PENDING =
  "Данные собраны; предварительную гипотезу уточняет врач.";

const RANK: Record<Urgency, number> = {
  routine: 0,
  planned: 1,
  urgent: 2,
  emergency: 3,
};

const SIGNIFICANT_PATHOLOGY_PROBABILITY = 0.15;
const MAX_MODEL_PATHOLOGIES = 5;
const MAX_ROUTES = 3;
const DEMOGRAPHIC_FEATURES = new Set(["age_norm", "sex_m", "sex_f"]);

interface PathologyMapRow {
  pathology: string;
  label_ru: string;
  specialty: string;
  specialty_alt: string[];
  urgency: Urgency;
  validated: boolean;
  icd10: string;
}

function loadPathologyMap(
  value: unknown,
  artifact: ModelArtifact,
): ReadonlyMap<string, Readonly<PathologyMapRow>> {
  if (!Array.isArray(value) || value.length !== artifact.class_order.length) {
    throw new Error("Pathology map must contain exactly the model class_order");
  }

  const rows = value as unknown[];
  const byPathology = new Map<string, Readonly<PathologyMapRow>>();
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Pathology map row must be an object");
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.pathology !== "string" ||
      typeof row.label_ru !== "string" ||
      typeof row.specialty !== "string" ||
      !Array.isArray(row.specialty_alt) ||
      row.specialty_alt.some((item) => typeof item !== "string") ||
      typeof row.urgency !== "string" ||
      !Object.prototype.hasOwnProperty.call(RANK, row.urgency) ||
      typeof row.validated !== "boolean" ||
      typeof row.icd10 !== "string"
    ) {
      throw new Error("Pathology map row violates the runtime contract");
    }
    if (byPathology.has(row.pathology)) {
      throw new Error(`Duplicate pathology map row: ${row.pathology}`);
    }
    byPathology.set(row.pathology, Object.freeze(row as unknown as PathologyMapRow));
  }

  if (artifact.class_order.some((pathology) => !byPathology.has(pathology))) {
    throw new Error("Pathology map and model class_order differ");
  }
  return byPathology;
}

const PRODUCTION_ARTIFACT = loadArtifact();
const PATHOLOGY_MAP = loadPathologyMap(pathologyMapJson, PRODUCTION_ARTIFACT);

export function createProductionLlm(
  deps: ExtractionDependencies = {},
): LlmPort {
  const hasInjectedDependencies = Object.keys(deps).length > 0;
  return {
    async analyze(messages) {
      const extraction = hasInjectedDependencies
        ? await extractAll(messages, deps)
        : await extractAll(messages);
      if (!extraction.extraction_ok) {
        throw new Error("production extraction unavailable");
      }
      return {
        anamnesis: normalizeAnamnesis(extraction.anamnesis),
        evidence: extraction.evidence,
        unmapped: extraction.unmapped,
        urgency: "planned",
        urgency_reasons: ["Срочность уточняется моделью и правилами."],
        routing: [],
        hypothesis: {
          text: ANALYTICAL_HYPOTHESIS_PENDING,
          confidence: 0,
        },
      };
    },
  };
}

const LIVE_LLM = createProductionLlm();

const LIVE_MODEL: ModelPort = {
  predict(evidence) {
    return {
      prediction: predictModel(
        buildVector(evidence, PRODUCTION_ARTIFACT),
        PRODUCTION_ARTIFACT,
      ),
      abstain_threshold: PRODUCTION_ARTIFACT.abstain_threshold,
    };
  },
};

const EMPTY_ANAMNESIS: Anamnesis = {
  chief_complaint: "",
  symptom: {
    onset: "",
    location: "",
    quality: "",
    severity: null,
    modifiers: "",
    associated: [],
  },
  past_history: [],
  chronic: [],
  allergies: [],
  medications: [],
  history_status: {
    past_history: "not_stated",
    chronic: "not_stated",
    allergies: "not_stated",
    medications: "not_stated",
  },
  negative_findings: [],
  context: {
    age: null,
    sex: "unknown",
    pregnancy: "na",
    risk_factors: [],
  },
};

function sortedRouting(
  routing: readonly { specialty: string; confidence: number }[],
): { specialty: string; confidence: number }[] {
  return [...routing]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

function fallbackRouting(
  urgency: Urgency,
): { specialty: string; confidence: number }[] {
  return [
    {
      specialty: urgency === "emergency"
        ? "скорая/приёмный покой"
        : "терапевт",
      confidence: 0,
    },
  ];
}

export function shouldAbstain(
  evidence: EvidenceVector,
  unmapped: readonly string[],
  prediction: ModelPrediction,
  threshold: number,
  artifact: ModelArtifact = PRODUCTION_ARTIFACT,
): ModelPrediction["abstain_reason"] | undefined {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new Error("Model abstain threshold must be inside (0, 1)");
  }
  const vector = buildVector(evidence, artifact);
  const activeEvidenceColumns = artifact.feature_order.reduce(
    (count, feature, index) =>
      !DEMOGRAPHIC_FEATURES.has(feature) && vector[index] !== 0
        ? count + 1
        : count,
    0,
  );
  if (
    activeEvidenceColumns < 2 ||
    unmapped.length / (activeEvidenceColumns + unmapped.length) > 0.5
  ) {
    return "out_of_label_space";
  }

  const topProbability = prediction.pathologies.reduce(
    (maximum, pathology) => Math.max(maximum, pathology.prob),
    0,
  );
  if (topProbability < threshold) return "low_confidence";
  return undefined;
}

interface ModelRoute {
  urgency: Urgency;
  urgency_reasons: string[];
  routing: { specialty: string; confidence: number }[];
}

function routeModelPrediction(
  prediction: ModelPrediction,
): ModelRoute | undefined {
  const pathologies = prediction.pathologies.slice(0, MAX_MODEL_PATHOLOGIES);
  const mapped = pathologies.map((pathology) => ({
    pathology,
    row: PATHOLOGY_MAP.get(pathology.code),
  }));
  if (mapped.some(({ row }) => row === undefined)) return undefined;

  const routeConfidence = new Map<string, number>();
  for (const { pathology, row } of mapped) {
    routeConfidence.set(
      row!.specialty,
      (routeConfidence.get(row!.specialty) ?? 0) + pathology.prob,
    );
  }
  const routing = [...routeConfidence]
    .map(([specialty, confidence]) => ({
      specialty,
      confidence: Math.min(Math.max(confidence, 0), 1),
    }))
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.specialty.localeCompare(right.specialty, "ru"),
    )
    .slice(0, MAX_ROUTES);

  const significant = mapped.filter(
    ({ pathology }) =>
      pathology.prob >= SIGNIFICANT_PATHOLOGY_PROBABILITY,
  );
  const urgency = significant.reduce<Urgency>(
    (worst, { row }) => (RANK[row!.urgency] > RANK[worst] ? row!.urgency : worst),
    "routine",
  );
  const urgencyReasons = significant.map(
    ({ pathology, row }) =>
      `модель: ${pathology.label_ru} (${Math.round(pathology.prob * 100)}%) — ${row!.urgency}`,
  );

  return {
    urgency,
    urgency_reasons:
      urgencyReasons.length > 0
        ? urgencyReasons
        : ["Модель не выделила состояние с вероятностью не менее 15%."],
    routing,
  };
}

function trustedPrediction(prediction: ModelPrediction): ModelPrediction {
  if (
    !prediction ||
    !Array.isArray(prediction.pathologies) ||
    !Array.isArray(prediction.top_contributions) ||
    typeof prediction.model_version !== "string" ||
    !prediction.model_version.trim() ||
    prediction.pathologies.some(
      (pathology) =>
        typeof pathology.code !== "string" ||
        !pathology.code.trim() ||
        typeof pathology.label_ru !== "string" ||
        !pathology.label_ru.trim() ||
        !Number.isFinite(pathology.prob) ||
        pathology.prob < 0 ||
        pathology.prob > 1,
    ) ||
    prediction.top_contributions.some(
      (contribution) =>
        typeof contribution.feature !== "string" ||
        !contribution.feature.trim() ||
        typeof contribution.label_ru !== "string" ||
        !contribution.label_ru.trim() ||
        !Number.isFinite(contribution.contribution),
    )
  ) {
    throw new Error("Model prediction violates the runtime contract");
  }
  return {
    ...prediction,
    pathologies: [...prediction.pathologies]
      .sort((left, right) => right.prob - left.prob)
      .slice(0, MAX_MODEL_PATHOLOGIES),
    top_contributions: [...prediction.top_contributions],
    abstained: false,
    abstain_reason: undefined,
  };
}

function redactedPrediction(
  prediction: ModelPrediction,
  reason: NonNullable<ModelPrediction["abstain_reason"]>,
): ModelPrediction {
  return {
    ...prediction,
    pathologies: [],
    top_contributions: [],
    abstained: true,
    abstain_reason: reason,
  };
}

export function mergeUrgency(
  baseUrgency: Urgency,
  baseReasons: readonly string[],
  flags: readonly RedFlag[],
): { urgency: Urgency; urgency_reasons: string[] } {
  const reasons = [...baseReasons];
  const emergencyFlags = flags.filter((flag) => flag.emergency);
  if (emergencyFlags.length > 0) {
    const compatibleReasons = reasons.filter(
      (reason) => !reason.toLocaleLowerCase("ru").includes("срочност"),
    );
    const flagReasons = emergencyFlags.map(
      (flag) =>
        `красный флаг: ${flag.label} — цитата пациента: «${flag.evidence}»`,
    );
    return {
      urgency: "emergency",
      urgency_reasons: [
        ...flagReasons,
        "Неотложный приоритет установлен правилами безопасности.",
        ...compatibleReasons,
      ],
    };
  }

  const riskFlags = flags.filter((flag) => !flag.emergency);
  if (riskFlags.length > 0 && RANK[baseUrgency] < RANK.urgent) {
    reasons.unshift(
      `фактор риска: ${riskFlags.map((flag) => flag.label).join(", ")}`,
    );
    return { urgency: "urgent", urgency_reasons: reasons };
  }

  return { urgency: baseUrgency, urgency_reasons: reasons };
}

function rulesOnlyResult(
  messages: ChatMessage[],
  regexFlags: RedFlag[],
  processingMode: ProcessingMode = "external_llm",
): TriageResult {
  const merged = mergeUrgency(
    "planned",
    [
      "признаки не извлечены — сводка построена только на правилах",
      "Контекстные факторы не проверялись: структурированный анамнез не извлечён.",
    ],
    regexFlags,
  );
  return {
    anamnesis: EMPTY_ANAMNESIS,
    red_flags: regexFlags,
    urgency: merged.urgency,
    urgency_reasons: merged.urgency_reasons,
    routing: [],
    hypothesis: {
      text: RULES_ONLY_HYPOTHESIS,
      confidence: 0,
      disclaimer: DISCLAIMER,
    },
    source: "rules_only",
    processing_mode: processingMode,
  };
}

function deterministicResult(
  messages: ChatMessage[],
  regexFlags: RedFlag[],
): TriageResult {
  const anamnesis = assembleDeterministicAnamnesis(messages);
  const flags = [...regexFlags, ...contextFlags(anamnesis, messages)];
  const merged = mergeUrgency(
    "planned",
    ["Плановый приоритет установлен детерминированным опросником; правила безопасности имеют приоритет."],
    flags,
  );
  return {
    anamnesis,
    red_flags: flags,
    urgency: merged.urgency,
    urgency_reasons: merged.urgency_reasons,
    routing: [],
    hypothesis: {
      text: DETERMINISTIC_HYPOTHESIS,
      confidence: 0,
      disclaimer: DISCLAIMER,
    },
    source: "rules_only",
    processing_mode: "deterministic",
  };
}

export async function analyze(
  messages: ChatMessage[],
  deps?: {
    llm?: LlmPort;
    model?: ModelPort;
    processingMode?: ProcessingMode;
  },
): Promise<TriageResult> {
  const regexFlags = detectRedFlags(messages);
  const processingMode = deps?.processingMode ?? PROCESSING_MODE;
  if (processingMode === "deterministic") {
    return deterministicResult(messages, regexFlags);
  }
  let out: LlmAnalysis;
  let derivedFlags: RedFlag[];

  try {
    out = await (deps?.llm ?? LIVE_LLM).analyze(messages);
    if (
      !out ||
      !out.anamnesis ||
      !out.evidence ||
      !Array.isArray(out.evidence.evidences) ||
      !Array.isArray(out.unmapped) ||
      !RANK.hasOwnProperty(out.urgency) ||
      !Array.isArray(out.urgency_reasons) ||
      !Array.isArray(out.routing)
    ) {
      throw new Error("invalid LLM analysis");
    }
    const sanitized = sanitizeEvidenceOutput(out.evidence, out.unmapped);
    out = {
      ...out,
      evidence: sanitized.evidence,
      unmapped: sanitized.unmapped,
    };
    out = {
      ...out,
      anamnesis: normalizeAnamnesis(out.anamnesis),
    };
    derivedFlags = contextFlags(out.anamnesis, messages);
  } catch {
    return rulesOnlyResult(messages, regexFlags, processingMode);
  }

  const redFlags = [...regexFlags, ...derivedFlags];
  let source: TriageResult["source"] = "llm_fallback";
  let baseUrgency = out.urgency;
  let baseReasons = [...out.urgency_reasons];
  let routing: { specialty: string; confidence: number }[] = [];
  let model: ModelPrediction | undefined;
  let modelConfidence: number | undefined;

  try {
    const modelOut = await (deps?.model ?? LIVE_MODEL).predict(
      out.evidence,
      out.unmapped,
    );
    const candidate = trustedPrediction(modelOut.prediction);
    const abstainReason = shouldAbstain(
      out.evidence,
      out.unmapped,
      candidate,
      modelOut.abstain_threshold ?? PRODUCTION_ARTIFACT.abstain_threshold,
    );
    if (abstainReason) {
      model = redactedPrediction(candidate, abstainReason);
      baseReasons.unshift("Модель воздержалась от ранжирования.");
    } else {
      const canonicalRoute = routeModelPrediction(candidate);
      const adapterRoute =
        modelOut.urgency && modelOut.urgency_reasons && modelOut.routing
          ? {
              urgency: modelOut.urgency,
              urgency_reasons: modelOut.urgency_reasons,
              routing: modelOut.routing,
            }
          : undefined;
      const route = canonicalRoute ?? adapterRoute;
      if (!route || route.routing.length === 0) {
        throw new Error("Model output cannot be routed");
      }
      model = candidate;
      source = "model";
      baseUrgency = route.urgency;
      baseReasons = [...route.urgency_reasons];
      routing = sortedRouting(route.routing);
      modelConfidence = model.pathologies[0]?.prob;
    }
  } catch {
    model = undefined;
    baseReasons.unshift(
      "Модель недоступна — использован результат LLM-адаптера.",
    );
  }

  const merged = mergeUrgency(baseUrgency, baseReasons, redFlags);
  const llmConfidence = Number.isFinite(out.hypothesis?.confidence)
    ? out.hypothesis.confidence
    : 0;
  const hypothesisConfidence = model?.abstained
    ? 0
    : source === "model"
      ? (modelConfidence ?? 0)
      : Math.min(Math.max(llmConfidence, 0), 0.5);
  const hypothesisText = model?.abstained
    ? ABSTAIN_HYPOTHESIS
    : typeof out.hypothesis?.text === "string" && out.hypothesis.text.trim()
      ? out.hypothesis.text
      : ANALYTICAL_HYPOTHESIS_PENDING;
  if (source === "llm_fallback") {
    routing = fallbackRouting(merged.urgency);
  }

  return {
    anamnesis: out.anamnesis,
    red_flags: redFlags,
    urgency: merged.urgency,
    urgency_reasons: merged.urgency_reasons,
    routing,
    hypothesis: {
      text: hypothesisText,
      confidence: hypothesisConfidence,
      disclaimer: DISCLAIMER,
    },
    ...(model ? { model } : {}),
    source,
    processing_mode: processingMode,
  };
}
