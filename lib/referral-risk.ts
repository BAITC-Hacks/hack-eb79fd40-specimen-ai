import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RegistrationFeatures } from "./referrals/types";

export const REFERRAL_RISK_ARTIFACT_SHA256 = "c52267ac918981ec1ef7458c57eede369b66cde2a7de69142d9d14f8770c6bed";
export const REFERRAL_RISK_FEATURES = [
  "bed_profile", "icd10_ref_diag_code", "referring_mo", "hospital_mo",
  "territorial_type", "finance_source", "referral_purpose",
] as const;
export type ReferralRiskFeature = typeof REFERRAL_RISK_FEATURES[number];
export type ReferralRiskCoverage = "frequent" | "fallback_infrequent_or_unseen" | "unknown_all_zero" | "missing";
export type ReferralRiskBand = "below_working_threshold" | "at_or_above_working_threshold";

interface ArtifactField {
  name: ReferralRiskFeature;
  frequent: { token: string; weight: number }[];
  infrequentWeight: number | null;
  unseenPolicy: "infrequent" | "zero";
  missingTrained: boolean;
}
interface OracleInput { kind: "raw" | "token"; value?: string | null; token?: string }
export type ReferralRiskEncodedInputs = Record<ReferralRiskFeature, { token: string } | { missing: true }>;
interface OracleCase {
  name: string;
  inputs: Record<ReferralRiskFeature, OracleInput>;
  expected: { logit: number; probability: number; riskBand: ReferralRiskBand; coverage: Record<ReferralRiskFeature, ReferralRiskCoverage> };
}
export interface ReferralRiskArtifact {
  schemaVersion: 1;
  modelId: "referral-refusal-baseline-v0";
  task: "B3_referral_refusal_research_inference";
  researchOnly: true;
  target: "refusal_probability_among_mature_outcomes";
  featureOrder: ReferralRiskFeature[];
  normalization: { stringPolicy: "exact_utf8_no_trim_case_or_unicode_normalization"; nullValue: "__MISSING__" };
  tokenization: { algorithm: "sha256"; namespace: "demeu:b3:category:v1" };
  classifier: {
    kind: "one_hot_logistic_regression"; solver: "liblinear"; c: 1; classes: [0, 1]; positiveClass: 1; intercept: number;
    iterations: number; maxIterations: number; workingThreshold: number; fields: ArtifactField[];
  };
  oracle: { hashVector: { feature: ReferralRiskFeature; value: string; token: string }; cases: OracleCase[] };
  provenance: {
    joblibSha256: string; sourceReportSha256: string; semanticReportSha256: string; inputSha256: string;
    sourceReport: "reports/referral-refusal-baseline-v0.json"; licenseStatus: "not_verified"; sklearnVersion: string;
  };
  heldoutBenchmark: { period: string; rows: number; positives: number; prAuc: number; brier: number; previouslyExamined: true };
  privacy: { containsRowData: false; containsIdentifiers: false; containsCategoryValues: false; categoryRepresentation: "sha256_dictionary_matchable_tokens" };
}
export interface ReferralRiskScore {
  refusalProbabilityAmongMatureOutcomes: number;
  workingThreshold: number;
  riskBand: ReferralRiskBand;
  inputCoverage: Record<ReferralRiskFeature, ReferralRiskCoverage>;
}

const EXACT_KEYS = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const close = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-12;
function assert(value: unknown, code = "INVALID_REFERRAL_RISK_ARTIFACT"): asserts value { if (!value) throw new Error(code); }
function shaEquals(actual: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/u.test(actual) && /^[a-f0-9]{64}$/u.test(expected)
    && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function referralRiskToken(feature: ReferralRiskFeature, value: string | null): string {
  return hash(`demeu:b3:category:v1\0${feature}\0${value === null ? "__MISSING__" : value}`);
}

function scoreInputs(
  inputs: Record<ReferralRiskFeature, OracleInput>, artifact: ReferralRiskArtifact,
): ReferralRiskScore & { logit: number } {
  let logit = artifact.classifier.intercept;
  const coverage = {} as Record<ReferralRiskFeature, ReferralRiskCoverage>;
  for (const field of artifact.classifier.fields) {
    const input = inputs[field.name];
    const raw = input.kind === "raw" ? input.value ?? null : "tokenized";
    const token = input.kind === "token" ? input.token! : referralRiskToken(field.name, raw);
    const match = field.frequent.find((entry) => entry.token === token);
    if (match) {
      logit += match.weight;
      coverage[field.name] = input.kind === "raw" && input.value === null ? "missing" : "frequent";
    } else if (field.unseenPolicy === "infrequent") {
      logit += field.infrequentWeight!;
      coverage[field.name] = "fallback_infrequent_or_unseen";
    } else coverage[field.name] = "unknown_all_zero";
  }
  const probability = logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
  return { logit, refusalProbabilityAmongMatureOutcomes: probability, workingThreshold: artifact.classifier.workingThreshold,
    riskBand: probability >= artifact.classifier.workingThreshold ? "at_or_above_working_threshold" : "below_working_threshold", inputCoverage: coverage };
}

export function validateReferralRiskArtifact(value: unknown): ReferralRiskArtifact {
  assert(object(value) && EXACT_KEYS(value, ["schemaVersion", "modelId", "task", "researchOnly", "target", "featureOrder", "normalization", "tokenization", "classifier", "oracle", "provenance", "heldoutBenchmark", "privacy"]));
  assert(value.schemaVersion === 1 && value.modelId === "referral-refusal-baseline-v0" && value.task === "B3_referral_refusal_research_inference"
    && value.researchOnly === true && value.target === "refusal_probability_among_mature_outcomes");
  assert(Array.isArray(value.featureOrder) && value.featureOrder.length === REFERRAL_RISK_FEATURES.length
    && value.featureOrder.every((entry, index) => entry === REFERRAL_RISK_FEATURES[index]));
  assert(object(value.normalization) && EXACT_KEYS(value.normalization, ["stringPolicy", "nullValue"])
    && value.normalization.stringPolicy === "exact_utf8_no_trim_case_or_unicode_normalization" && value.normalization.nullValue === "__MISSING__");
  assert(object(value.tokenization) && EXACT_KEYS(value.tokenization, ["algorithm", "namespace"])
    && value.tokenization.algorithm === "sha256" && value.tokenization.namespace === "demeu:b3:category:v1");
  const classifier = value.classifier;
  assert(object(classifier) && EXACT_KEYS(classifier, ["kind", "solver", "c", "classes", "positiveClass", "intercept", "iterations", "maxIterations", "workingThreshold", "fields"])
    && classifier.kind === "one_hot_logistic_regression" && classifier.solver === "liblinear" && classifier.c === 1
    && Array.isArray(classifier.classes) && classifier.classes.length === 2 && classifier.classes[0] === 0 && classifier.classes[1] === 1 && classifier.positiveClass === 1
    && finite(classifier.intercept) && Number.isSafeInteger(classifier.iterations) && Number.isSafeInteger(classifier.maxIterations)
    && Number(classifier.iterations) > 0 && Number(classifier.iterations) < Number(classifier.maxIterations)
    && classifier.intercept === -0.5447459873871785 && classifier.iterations === 16 && classifier.maxIterations === 300
    && classifier.workingThreshold === 0.1709380688837899 && Array.isArray(classifier.fields)
    && classifier.fields.length === REFERRAL_RISK_FEATURES.length);
  const tokens = new Set<string>();
  for (const [index, raw] of classifier.fields.entries()) {
    assert(object(raw) && EXACT_KEYS(raw, ["name", "frequent", "infrequentWeight", "unseenPolicy", "missingTrained"])
      && raw.name === REFERRAL_RISK_FEATURES[index] && Array.isArray(raw.frequent) && raw.frequent.length > 0
      && ["infrequent", "zero"].includes(String(raw.unseenPolicy)) && typeof raw.missingTrained === "boolean");
    for (const entry of raw.frequent) {
      assert(object(entry) && EXACT_KEYS(entry, ["token", "weight"]) && typeof entry.token === "string" && /^[a-f0-9]{64}$/u.test(entry.token)
        && finite(entry.weight) && !tokens.has(entry.token));
      tokens.add(entry.token);
    }
    assert(raw.unseenPolicy === "infrequent" ? finite(raw.infrequentWeight) : raw.infrequentWeight === null);
  }
  assert(classifier.fields.every((field, index) => object(field) && Array.isArray(field.frequent) && field.frequent.length === [91, 896, 897, 1074, 2, 3, 10][index]));
  assert(classifier.fields.filter((field) => object(field) && field.unseenPolicy === "infrequent").length === 4
    && classifier.fields.filter((field) => object(field) && field.unseenPolicy === "zero").length === 3);
  assert(tokens.size === 2973);
  const oracle = value.oracle;
  assert(object(oracle) && EXACT_KEYS(oracle, ["hashVector", "cases"]) && object(oracle.hashVector)
    && EXACT_KEYS(oracle.hashVector, ["feature", "value", "token"]) && oracle.hashVector.feature === "bed_profile"
    && typeof oracle.hashVector.value === "string" && typeof oracle.hashVector.token === "string"
    && referralRiskToken("bed_profile", oracle.hashVector.value) === oracle.hashVector.token && Array.isArray(oracle.cases) && oracle.cases.length >= 17);
  const artifact = value as unknown as ReferralRiskArtifact;
  const names = new Set<string>();
  for (const rawCase of oracle.cases) {
    assert(object(rawCase) && EXACT_KEYS(rawCase, ["name", "inputs", "expected"]) && typeof rawCase.name === "string" && !names.has(rawCase.name)
      && object(rawCase.inputs) && EXACT_KEYS(rawCase.inputs, REFERRAL_RISK_FEATURES) && object(rawCase.expected)
      && EXACT_KEYS(rawCase.expected, ["logit", "probability", "riskBand", "coverage"]) && finite(rawCase.expected.logit)
      && finite(rawCase.expected.probability) && ["below_working_threshold", "at_or_above_working_threshold"].includes(String(rawCase.expected.riskBand))
      && object(rawCase.expected.coverage) && EXACT_KEYS(rawCase.expected.coverage, REFERRAL_RISK_FEATURES));
    for (const feature of REFERRAL_RISK_FEATURES) {
      const input = rawCase.inputs[feature];
      assert(object(input) && (input.kind === "token" ? EXACT_KEYS(input, ["kind", "token"]) && typeof input.token === "string" && /^[a-f0-9]{64}$/u.test(input.token)
        : input.kind === "raw" && EXACT_KEYS(input, ["kind", "value"]) && (input.value === null || typeof input.value === "string")));
      assert(["frequent", "fallback_infrequent_or_unseen", "unknown_all_zero", "missing"].includes(String((rawCase.expected.coverage as Record<string, unknown>)[feature])));
    }
    const actual = scoreInputs(rawCase.inputs as OracleCase["inputs"], artifact);
    const expected = rawCase.expected as unknown as OracleCase["expected"];
    assert(close(actual.logit, rawCase.expected.logit as number) && close(actual.refusalProbabilityAmongMatureOutcomes, rawCase.expected.probability as number)
      && actual.riskBand === expected.riskBand && REFERRAL_RISK_FEATURES.every((feature) => actual.inputCoverage[feature] === expected.coverage[feature]));
    names.add(rawCase.name);
  }
  const expectedOracleNames = ["all_fields_low", "all_fields_high", ...REFERRAL_RISK_FEATURES.flatMap((feature, index) => [
    `frequent_${feature}`, `${index < 4 ? "infrequent" : "zero"}_${feature}`]), "missing_bed_profile"];
  assert(names.size === expectedOracleNames.length && expectedOracleNames.every((name) => names.has(name))
    && names.has("missing_bed_profile") && [...oracle.cases].some((entry) => object(entry) && object(entry.expected) && entry.expected.riskBand === "below_working_threshold")
    && [...oracle.cases].some((entry) => object(entry) && object(entry.expected) && entry.expected.riskBand === "at_or_above_working_threshold"));
  const provenance = value.provenance;
  assert(object(provenance) && EXACT_KEYS(provenance, ["joblibSha256", "sourceReportSha256", "semanticReportSha256", "inputSha256", "sourceReport", "licenseStatus", "sklearnVersion"])
    && provenance.joblibSha256 === "2ff0d5405d758b110d88b23b26b6f6e764f67aad65959a741ed7ab7da05097f3"
    && provenance.sourceReportSha256 === "d8b9a831af78e34cc78b641e29160bcd00d3a43b8332614dacd0ff64180a246a"
    && provenance.semanticReportSha256 === "8f0810cfa937d38817ed0caf8b1971d81093d6dd125b120b203a0a096c5a4f91"
    && provenance.inputSha256 === "c9386df30d37f3035aa653772abb74f648348a17b7de5497e9306b088bc01798"
    && provenance.sourceReport === "reports/referral-refusal-baseline-v0.json" && provenance.licenseStatus === "not_verified" && typeof provenance.sklearnVersion === "string");
  const benchmark = value.heldoutBenchmark;
  assert(object(benchmark) && EXACT_KEYS(benchmark, ["period", "rows", "positives", "prAuc", "brier", "previouslyExamined"])
    && benchmark.period === "2025-03" && benchmark.rows === 223353 && benchmark.positives === 24469
    && benchmark.prAuc === 0.34820996 && benchmark.brier === 0.08467742 && benchmark.previouslyExamined === true);
  const privacy = value.privacy;
  assert(object(privacy) && EXACT_KEYS(privacy, ["containsRowData", "containsIdentifiers", "containsCategoryValues", "categoryRepresentation"])
    && privacy.containsRowData === false && privacy.containsIdentifiers === false && privacy.containsCategoryValues === false
    && privacy.categoryRepresentation === "sha256_dictionary_matchable_tokens");
  return artifact;
}

export function scoreReferralRisk(features: RegistrationFeatures, artifact: ReferralRiskArtifact): ReferralRiskScore {
  assert(object(features) && EXACT_KEYS(features, REFERRAL_RISK_FEATURES)
    && REFERRAL_RISK_FEATURES.every((feature) => {
      const value = features[feature];
      return value === null ? feature === "bed_profile" : typeof value === "string" && value !== "__MISSING__" && value.trim().length > 0 && value.length <= 500 && !value.includes("\0");
    }), "INVALID_REFERRAL_RISK_INPUTS");
  const inputs = Object.fromEntries(REFERRAL_RISK_FEATURES.map((feature) => [feature, { kind: "raw", value: features[feature] }])) as Record<ReferralRiskFeature, OracleInput>;
  return scoreInputs(inputs, artifact);
}
export function scoreReferralRiskEncoded(inputs: ReferralRiskEncodedInputs, artifact: ReferralRiskArtifact): ReferralRiskScore {
  const normalized = Object.fromEntries(REFERRAL_RISK_FEATURES.map((feature) => [feature,
    "missing" in inputs[feature] ? { kind: "raw", value: null } : { kind: "token", token: inputs[feature].token }])) as Record<ReferralRiskFeature, OracleInput>;
  return scoreInputs(normalized, artifact);
}

let loaded: Promise<ReferralRiskArtifact> | null = null;
export function loadReferralRiskArtifact(path = resolve(process.cwd(), "models/referral-risk-v1.json")): Promise<ReferralRiskArtifact> {
  if (path !== resolve(process.cwd(), "models/referral-risk-v1.json")) return loadExact(path);
  loaded ??= loadExact(path).catch((error) => { loaded = null; throw error; });
  return loaded;
}
async function loadExact(path: string): Promise<ReferralRiskArtifact> {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1_000_000, "REFERRAL_RISK_ARTIFACT_UNAVAILABLE");
  const bytes = await readFile(path);
  assert(shaEquals(hash(bytes), REFERRAL_RISK_ARTIFACT_SHA256), "REFERRAL_RISK_ARTIFACT_SHA_MISMATCH");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("INVALID_REFERRAL_RISK_ARTIFACT"); }
  return deepFreeze(validateReferralRiskArtifact(parsed));
}
function deepFreeze<T>(value: T): T {
  if (object(value) || Array.isArray(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
