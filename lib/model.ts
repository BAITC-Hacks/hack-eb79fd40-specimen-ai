import evidencesJson from "../data/evidences_ru.json";
import pathologyMapJson from "../data/pathology_map.json";
import artifactJson from "../models/triage-lr-v1.json";

import type {
  EvidenceVector,
  FeatureContribution,
  ModelPrediction,
} from "./types";

export interface ModelArtifact {
  readonly schema_version: number;
  readonly model_version: string;
  readonly trained_at: string;
  readonly dataset_name: string;
  readonly dataset_sha256: string;
  readonly license: string;
  readonly n_train_rows: number;
  readonly feature_order: readonly string[];
  readonly class_order: readonly string[];
  readonly weights: readonly (readonly number[])[];
  readonly bias: readonly number[];
  readonly preprocessing: {
    readonly age_divisor: number;
    readonly age_missing: number;
    readonly sex_unknown_value: number;
  };
  readonly abstain_threshold: number;
  readonly train_metrics: {
    readonly top1: number;
    readonly top3: number;
    readonly n_test: number;
  };
}

type EvidenceDictionaryEntry = { readonly label_ru?: unknown };
type PathologyMapRow = {
  readonly pathology?: unknown;
  readonly label_ru?: unknown;
  readonly icd10?: unknown;
};

const ARTIFACT_KEYS = new Set([
  "schema_version",
  "model_version",
  "trained_at",
  "dataset_name",
  "dataset_sha256",
  "license",
  "n_train_rows",
  "feature_order",
  "class_order",
  "weights",
  "bias",
  "preprocessing",
  "abstain_threshold",
  "train_metrics",
]);
const PREPROCESSING_KEYS = new Set([
  "age_divisor",
  "age_missing",
  "sex_unknown_value",
]);
const TRAIN_METRIC_KEYS = new Set(["top1", "top3", "n_test"]);
const PRODUCTION_CLASS_COUNT = 47;
const PRODUCTION_FEATURE_COUNT = 975;
const TOP_PATHOLOGIES = 5;
const TOP_CONTRIBUTIONS = 5;
const DEMOGRAPHIC_LABELS: Readonly<Record<string, string>> = {
  age_norm: "возраст",
  sex_m: "пол: мужской",
  sex_f: "пол: женский",
};

const evidenceDictionary = evidencesJson as unknown as Readonly<
  Record<string, EvidenceDictionaryEntry>
>;
const pathologyRows = pathologyMapJson as unknown as readonly PathologyMapRow[];
const validatedArtifacts = new WeakSet<object>();
const featureIndexCache = new WeakMap<ModelArtifact, ReadonlyMap<string, number>>();
let productionArtifact: ModelArtifact | undefined;

function fail(message: string): never {
  throw new Error(`Invalid model artifact: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
  name: string,
): void {
  const actual = Object.keys(value);
  const missing = [...expected].filter((key) => !(key in value));
  const extra = actual.filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${name} keys differ: missing=${missing.join(",") || "none"}, extra=${extra.join(",") || "none"}`,
    );
  }
}

function assertFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${name} must be finite`);
  }
}

function assertProbability(value: unknown, name: string): asserts value is number {
  assertFiniteNumber(value, name);
  if (value < 0 || value > 1) {
    fail(`${name} must be inside [0, 1]`);
  }
}

function assertStringArray(value: unknown, name: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    fail(`${name} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${name} must contain unique values`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function validateArtifact(value: unknown): asserts value is ModelArtifact {
  if (!isObject(value)) {
    fail("root must be an object");
  }
  if (validatedArtifacts.has(value)) {
    return;
  }
  assertExactKeys(value, ARTIFACT_KEYS, "root");
  if (value.schema_version !== 1) {
    fail("schema_version must equal 1");
  }
  if (typeof value.model_version !== "string" || value.model_version.length === 0) {
    fail("model_version must be non-empty");
  }
  if (
    typeof value.trained_at !== "string" ||
    value.trained_at.length === 0 ||
    Number.isNaN(Date.parse(value.trained_at))
  ) {
    fail("trained_at must be an ISO timestamp");
  }
  if (typeof value.dataset_name !== "string" || value.dataset_name.length === 0) {
    fail("dataset_name must be non-empty");
  }
  if (
    typeof value.dataset_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.dataset_sha256)
  ) {
    fail("dataset_sha256 must be a lowercase SHA256");
  }
  if (typeof value.license !== "string" || value.license.trim().length === 0) {
    fail("license must be non-empty");
  }
  if (
    typeof value.n_train_rows !== "number" ||
    !Number.isInteger(value.n_train_rows) ||
    value.n_train_rows <= 0
  ) {
    fail("n_train_rows must be a positive integer");
  }
  assertStringArray(value.feature_order, "feature_order");
  assertStringArray(value.class_order, "class_order");
  for (const required of ["age_norm", "sex_m", "sex_f"]) {
    if (!value.feature_order.includes(required)) {
      fail(`feature_order lacks ${required}`);
    }
  }
  if (!Array.isArray(value.weights) || value.weights.length !== value.class_order.length) {
    fail("weights row count must equal class_order length");
  }
  for (const [rowIndex, row] of value.weights.entries()) {
    if (!Array.isArray(row) || row.length !== value.feature_order.length) {
      fail(`weights[${rowIndex}] width must equal feature_order length`);
    }
    for (const [columnIndex, weight] of row.entries()) {
      assertFiniteNumber(weight, `weights[${rowIndex}][${columnIndex}]`);
    }
  }
  if (!Array.isArray(value.bias) || value.bias.length !== value.class_order.length) {
    fail("bias length must equal class_order length");
  }
  for (const [index, bias] of value.bias.entries()) {
    assertFiniteNumber(bias, `bias[${index}]`);
  }
  if (!isObject(value.preprocessing)) {
    fail("preprocessing must be an object");
  }
  assertExactKeys(value.preprocessing, PREPROCESSING_KEYS, "preprocessing");
  assertFiniteNumber(value.preprocessing.age_divisor, "preprocessing.age_divisor");
  assertFiniteNumber(value.preprocessing.age_missing, "preprocessing.age_missing");
  assertFiniteNumber(
    value.preprocessing.sex_unknown_value,
    "preprocessing.sex_unknown_value",
  );
  if (value.preprocessing.age_divisor <= 0) {
    fail("preprocessing.age_divisor must be positive");
  }
  if (value.preprocessing.age_missing < 0 || value.preprocessing.age_missing > 1) {
    fail("preprocessing.age_missing must be inside [0, 1]");
  }
  if (
    value.preprocessing.sex_unknown_value < 0 ||
    value.preprocessing.sex_unknown_value > 1
  ) {
    fail("preprocessing.sex_unknown_value must be inside [0, 1]");
  }
  assertFiniteNumber(value.abstain_threshold, "abstain_threshold");
  if (value.abstain_threshold <= 0 || value.abstain_threshold >= 1) {
    fail("abstain_threshold must be inside (0, 1)");
  }
  if (!isObject(value.train_metrics)) {
    fail("train_metrics must be an object");
  }
  assertExactKeys(value.train_metrics, TRAIN_METRIC_KEYS, "train_metrics");
  assertProbability(value.train_metrics.top1, "train_metrics.top1");
  assertProbability(value.train_metrics.top3, "train_metrics.top3");
  if (
    typeof value.train_metrics.n_test !== "number" ||
    !Number.isInteger(value.train_metrics.n_test) ||
    value.train_metrics.n_test <= 0
  ) {
    fail("train_metrics.n_test must be a positive integer");
  }
  deepFreeze(value);
  validatedArtifacts.add(value);
}

function nonEmptyLabel(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${name} has no Russian label`);
  }
  return value;
}

function pathologyMap(): ReadonlyMap<string, PathologyMapRow> {
  if (!Array.isArray(pathologyRows)) {
    fail("pathology map must be an array");
  }
  const rows = new Map<string, PathologyMapRow>();
  for (const [index, row] of pathologyRows.entries()) {
    if (!isObject(row) || typeof row.pathology !== "string" || row.pathology.length === 0) {
      fail(`pathology map row ${index} has no pathology`);
    }
    if (rows.has(row.pathology)) {
      fail(`pathology map duplicates ${row.pathology}`);
    }
    nonEmptyLabel(row.label_ru, `pathology ${row.pathology}`);
    if (row.icd10 !== undefined && (typeof row.icd10 !== "string" || row.icd10.length === 0)) {
      fail(`pathology ${row.pathology} has invalid icd10`);
    }
    rows.set(row.pathology, row);
  }
  return rows;
}

const pathologyByCode = pathologyMap();

function validateProductionResources(artifact: ModelArtifact): void {
  if (artifact.class_order.length !== PRODUCTION_CLASS_COUNT) {
    fail(`production class_order must contain ${PRODUCTION_CLASS_COUNT} classes`);
  }
  if (artifact.feature_order.length !== PRODUCTION_FEATURE_COUNT) {
    fail(`production feature_order must contain ${PRODUCTION_FEATURE_COUNT} features`);
  }
  for (const feature of artifact.feature_order) {
    if (feature in DEMOGRAPHIC_LABELS) {
      continue;
    }
    nonEmptyLabel(evidenceDictionary[feature]?.label_ru, `feature ${feature}`);
  }
  for (const pathology of artifact.class_order) {
    if (!pathologyByCode.has(pathology)) {
      fail(`pathology map lacks ${pathology}`);
    }
  }
}

function featureIndex(artifact: ModelArtifact): ReadonlyMap<string, number> {
  let index = featureIndexCache.get(artifact);
  if (index === undefined) {
    index = new Map(artifact.feature_order.map((feature, position) => [feature, position]));
    featureIndexCache.set(artifact, index);
  }
  return index;
}

function normalizedAge(age: number | null, artifact: ModelArtifact): number {
  const preprocessing = artifact.preprocessing;
  if (age === null || Number.isNaN(age)) {
    return preprocessing.age_missing;
  }
  if (typeof age !== "number") {
    fail("EvidenceVector.age must be a number or null");
  }
  return (
    Math.min(Math.max(age, 0), preprocessing.age_divisor) /
    preprocessing.age_divisor
  );
}

function featureLabel(feature: string): string {
  const demographic = DEMOGRAPHIC_LABELS[feature];
  if (demographic !== undefined) {
    return demographic;
  }
  return nonEmptyLabel(evidenceDictionary[feature]?.label_ru, `feature ${feature}`);
}

function stableSoftmax(logits: readonly number[]): number[] {
  if (logits.length === 0 || logits.some((value) => !Number.isFinite(value))) {
    fail("logits must be non-empty and finite");
  }
  const maximum = Math.max(...logits);
  const exponentials = logits.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    fail("softmax normalization failed");
  }
  const probabilities = exponentials.map((value) => value / total);
  if (probabilities.some((value) => !Number.isFinite(value))) {
    fail("softmax produced a non-finite probability");
  }
  return probabilities;
}

/** Static, bundler-safe access to the frozen production artifact. */
export function loadArtifact(): ModelArtifact {
  if (productionArtifact === undefined) {
    const candidate: unknown = artifactJson;
    validateArtifact(candidate);
    validateProductionResources(candidate);
    productionArtifact = candidate;
  }
  return productionArtifact;
}

/** Build the dense serve-time vector using only artifact-owned ordering and constants. */
export function buildVector(
  evidence: EvidenceVector,
  artifact: ModelArtifact,
): Float64Array {
  validateArtifact(artifact);
  const index = featureIndex(artifact);
  const vector = new Float64Array(artifact.feature_order.length);
  vector[index.get("age_norm")!] = normalizedAge(evidence.age, artifact);
  if (evidence.sex === "m") {
    vector[index.get("sex_m")!] = 1;
  } else if (evidence.sex === "f") {
    vector[index.get("sex_f")!] = 1;
  } else if (evidence.sex === "unknown") {
    vector[index.get("sex_m")!] = artifact.preprocessing.sex_unknown_value;
    vector[index.get("sex_f")!] = artifact.preprocessing.sex_unknown_value;
  } else {
    fail("EvidenceVector.sex is invalid");
  }

  for (const item of evidence.evidences) {
    const key =
      item.value === undefined || item.value === null
        ? item.code
        : `${item.code}@${item.value}`;
    const position = index.get(key);
    if (position === undefined) {
      console.warn(`[model] evidence key is outside feature_order: ${key}`);
      continue;
    }
    vector[position] = 1;
  }
  return vector;
}

/** Score multinomial LR; abstain remains owned exclusively by the analytical layer. */
export function predict(
  vector: Float64Array,
  artifact: ModelArtifact,
): ModelPrediction {
  validateArtifact(artifact);
  if (!(vector instanceof Float64Array) || vector.length !== artifact.feature_order.length) {
    fail("input vector length must equal feature_order length");
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    fail("input vector must contain only finite values");
  }

  const logits = artifact.weights.map((weights, classIndex) => {
    let value = artifact.bias[classIndex];
    for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
      if (vector[featureIndex] !== 0) {
        value += weights[featureIndex] * vector[featureIndex];
      }
    }
    if (!Number.isFinite(value)) {
      fail(`logit ${classIndex} is not finite`);
    }
    return value;
  });
  const probabilities = stableSoftmax(logits);
  const ranked = probabilities
    .map((probability, classIndex) => ({ classIndex, probability }))
    .sort(
      (left, right) =>
        right.probability - left.probability || left.classIndex - right.classIndex,
    );
  const winner = ranked[0].classIndex;
  const contributions: (FeatureContribution & { readonly featureIndex: number })[] = [];
  for (let featureIndex = 0; featureIndex < vector.length; featureIndex += 1) {
    const contribution = artifact.weights[winner][featureIndex] * vector[featureIndex];
    if (contribution !== 0) {
      const feature = artifact.feature_order[featureIndex];
      contributions.push({
        feature,
        label_ru: featureLabel(feature),
        contribution,
        featureIndex,
      });
    }
  }
  contributions.sort(
    (left, right) =>
      Math.abs(right.contribution) - Math.abs(left.contribution) ||
      left.featureIndex - right.featureIndex,
  );

  return {
    pathologies: ranked.slice(0, TOP_PATHOLOGIES).map(({ classIndex, probability }) => {
      const code = artifact.class_order[classIndex];
      const row = pathologyByCode.get(code);
      if (row === undefined) {
        fail(`pathology map lacks ${code}`);
      }
      const label_ru = nonEmptyLabel(row.label_ru, `pathology ${code}`);
      const icd10 = typeof row.icd10 === "string" ? row.icd10 : undefined;
      return {
        code,
        label_ru,
        prob: probability,
        ...(icd10 === undefined ? {} : { icd10 }),
      };
    }),
    top_contributions: contributions
      .slice(0, TOP_CONTRIBUTIONS)
      .map(({ feature, label_ru, contribution }) => ({
        feature,
        label_ru,
        contribution,
      })),
    abstained: false,
    model_version: artifact.model_version,
  };
}
