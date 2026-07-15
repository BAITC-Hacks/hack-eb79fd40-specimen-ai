import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildVector, loadArtifact, predict } from "../lib/model";
import { analyze, type LlmAnalysis, type LlmPort } from "../lib/triage";
import type {
  Anamnesis,
  ChatMessage,
  EvidenceVector,
  ModelPrediction,
  TriageResult,
  Urgency,
} from "../lib/types";

export type EvalMode = "no-llm";

interface EvalGold {
  pathology: string | null;
  differential?: string[];
  evidences?: EvidenceVector["evidences"];
  age?: number;
  sex?: EvidenceVector["sex"];
  specialty_set: string[];
  urgency: Urgency;
  emergency_expected: boolean;
  red_flag_codes?: string[];
}

export interface EvalCase {
  id: string;
  kind: "flat" | "dialog" | "redflag";
  lang: "ru";
  messages: ChatMessage[];
  gold: EvalGold;
  provenance: Record<string, unknown>;
}

interface PathologyMapRow {
  pathology: string;
  specialty: string;
  specialty_alt: string[];
  urgency: Urgency;
  validated: boolean;
}

interface Manifest {
  artifact: { path: string; sha256: string };
  dependencies: {
    artifact: { path: string; sha256: string; model_version: string };
    dictionary: { path: string; sha256: string };
    pathology_map: { path: string; sha256: string; validated: boolean };
  };
  selection: { count: number; n_by_kind: Record<string, number> };
}

type MetricState = "measured" | "not_run" | "UNVALIDATED" | "not_defined";

interface MetricStatus {
  state: MetricState;
  numerator?: number;
  denominator?: number;
  reason?: string;
  excluded_case_ids?: string[];
}

interface InvariantResult {
  id: string;
  passed: boolean;
  failures: string[];
}

interface PerCaseResult {
  id: string;
  kind: EvalCase["kind"];
  source: TriageResult["source"];
  gold_pathology: string | null;
  predicted_pathologies: string[];
  model_abstained: boolean | null;
  gold_urgency: Urgency;
  predicted_urgency: Urgency;
  predicted_routing: string[];
  gold_specialties_strict: string[];
  gold_specialties_differential: string[];
  emergency_expected: boolean;
  emergency_predicted: boolean;
  invariant_failures: string[];
}

export interface EvalReport {
  schema_version: 1;
  run_id: string;
  commit: string;
  mode: EvalMode;
  model_version: string;
  cases_sha256: string;
  pathology_map_validated: boolean;
  provenance: {
    cases: { path: string; sha256: string };
    manifest: { path: string; sha256: string };
    model: { path: string; sha256: string };
    dictionary: { path: string; sha256: string };
    pathology_map: { path: string; sha256: string };
    evaluator: { path: string; sha256: string };
  };
  n: {
    total: number;
    flat: number;
    dialog: number;
    redflag: number;
    pathology_gold: number;
    manual_positive: number;
    manual_negative: number;
  };
  invariants: { all_passed: boolean; checks: InvariantResult[] };
  metrics: Record<string, number | null>;
  metric_status: Record<string, MetricStatus>;
  caveats: string[];
  readme_guard: {
    status: "PARTIAL" | "BLOCKED";
    required_mode: EvalMode;
    required_hashes: Record<string, string>;
    allowed_metrics: string[];
    blocked_metrics: Record<string, string>;
  };
  per_case: PerCaseResult[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP_CAVEAT =
  "метрики urgency/routing — против невалидированной врачами таблицы `data/pathology_map.json`";
const NO_LLM_CAVEAT =
  "top-1/top-3 измерены при ИДЕАЛЬНОМ извлечении (mode=no-llm): LLM-адаптер не участвовал, сквозное качество ниже; extraction_f1 не измерялся";

const EMPTY_ANAMNESIS: Anamnesis = {
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
  context: { age: null, sex: "unknown", pregnancy: "na", risk_factors: [] },
};

function fail(message: string): never {
  throw new Error(`Eval contract error: ${message}`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filename: string): Promise<string> {
  return sha256(await readFile(filename));
}

function finiteRatio(numerator: number, denominator: number, name: string): number {
  if (!Number.isInteger(numerator) || numerator < 0) fail(`${name} numerator is invalid`);
  if (!Number.isInteger(denominator) || denominator <= 0) fail(`${name} denominator is invalid`);
  if (numerator > denominator) fail(`${name} numerator exceeds denominator`);
  const value = numerator / denominator;
  if (!Number.isFinite(value)) fail(`${name} is non-finite`);
  return value;
}

function safeRatio(
  numerator: number,
  denominator: number,
  name: string,
): { value: number | null; status: MetricStatus } {
  if (denominator === 0) {
    return {
      value: null,
      status: { state: "not_defined", numerator, denominator, reason: `${name}: denominator is zero` },
    };
  }
  return {
    value: finiteRatio(numerator, denominator, name),
    status: { state: "measured", numerator, denominator },
  };
}

function canonicalJson(value: unknown): string {
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return input;
  }
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function parseJsonObject<T>(text: string, name: string): T {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${name} is not an object`);
    return parsed as T;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Eval contract error:")) throw error;
    fail(`${name} is invalid JSON`);
  }
}

export function parseCases(text: string): EvalCase[] {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const cases = lines.map((line, index) => {
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      fail(`cases line ${index + 1} is invalid JSON`);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`cases line ${index + 1} is not an object`);
    const candidate = item as Partial<EvalCase>;
    if (
      typeof candidate.id !== "string" ||
      !["flat", "dialog", "redflag"].includes(candidate.kind ?? "") ||
      !Array.isArray(candidate.messages) ||
      candidate.messages.some(
        (message) =>
          !message ||
          !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string",
      ) ||
      !candidate.gold ||
      typeof candidate.gold.emergency_expected !== "boolean" ||
      !Array.isArray(candidate.gold.specialty_set) ||
      !["routine", "planned", "urgent", "emergency"].includes(candidate.gold.urgency)
    ) {
      fail(`cases line ${index + 1} violates schema`);
    }
    return candidate as EvalCase;
  });
  const ids = cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) fail("case ids are not unique");
  return cases;
}

function evidenceFor(item: EvalCase): EvidenceVector {
  if (item.kind === "redflag") return { evidences: [], age: null, sex: "unknown" };
  if (!Array.isArray(item.gold.evidences) || typeof item.gold.age !== "number" || !item.gold.sex) {
    fail(`${item.id} lacks native evidence gold`);
  }
  return { evidences: item.gold.evidences, age: item.gold.age, sex: item.gold.sex };
}

function goldPort(item: EvalCase): LlmPort {
  const evidence = evidenceFor(item);
  const analysis: LlmAnalysis = {
    anamnesis: {
      ...EMPTY_ANAMNESIS,
      context: { ...EMPTY_ANAMNESIS.context, age: evidence.age, sex: evidence.sex },
    },
    evidence,
    unmapped: [],
    urgency: "planned",
    urgency_reasons: ["Срочность LLM не измеряется в режиме no-llm."],
    routing: [{ specialty: "не измерено", confidence: 0 }],
    hypothesis: { text: "Предварительная гипотеза формируется моделью.", confidence: 0 },
  };
  return { async analyze() { return analysis; } };
}

function fullProbabilities(vector: Float64Array): number[] {
  const artifact = loadArtifact();
  const logits = artifact.weights.map((weights, classIndex) => {
    let value = artifact.bias[classIndex];
    for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
      value += weights[featureIndex] * vector[featureIndex];
    }
    return value;
  });
  if (logits.some((value) => !Number.isFinite(value))) fail("full scorer produced non-finite logits");
  const maximum = Math.max(...logits);
  const exponents = logits.map((value) => Math.exp(value - maximum));
  const total = exponents.reduce((sum, value) => sum + value, 0);
  const probabilities = exponents.map((value) => value / total);
  const sum = probabilities.reduce((accumulator, value) => accumulator + value, 0);
  if (!Number.isFinite(sum) || Math.abs(sum - 1) > 1e-12) fail("full distribution does not sum to one");
  return probabilities;
}

export function assertPredictionIntegrity(
  prediction: ModelPrediction,
  vector: Float64Array,
): void {
  const artifact = loadArtifact();
  const classSet = new Set(artifact.class_order);
  if (
    prediction.pathologies.length === 0 ||
    prediction.pathologies.length > 5 ||
    prediction.pathologies.some(
      (item) => !classSet.has(item.code) || !Number.isFinite(item.prob) || item.prob < 0 || item.prob > 1,
    )
  ) {
    fail("production prediction contains unknown codes or invalid probabilities");
  }
  for (let index = 1; index < prediction.pathologies.length; index += 1) {
    if (prediction.pathologies[index].prob > prediction.pathologies[index - 1].prob) {
      fail("production prediction is not sorted");
    }
  }
  const all = fullProbabilities(vector);
  const ranked = all
    .map((probability, classIndex) => ({ probability, code: artifact.class_order[classIndex], classIndex }))
    .sort((left, right) => right.probability - left.probability || left.classIndex - right.classIndex)
    .slice(0, prediction.pathologies.length);
  prediction.pathologies.forEach((item, index) => {
    if (item.code !== ranked[index].code || Math.abs(item.prob - ranked[index].probability) > 1e-12) {
      fail("production top-5 differs from the full scorer distribution");
    }
  });
  // The public prediction is top-5. Its sum is intentionally not constrained to one.
}

function invariantFailures(
  item: EvalCase,
  result: TriageResult,
  modelVersion: string,
): string[] {
  const failures: string[] = [];
  if (result.red_flags.some((flag) => flag.emergency) && result.urgency !== "emergency") {
    failures.push("I1");
  }
  for (const flag of result.red_flags) {
    if (flag.evidence_kind === "quote") {
      const source = item.messages[flag.source_message_index];
      const positions: number[] = [];
      if (source) {
        let position = source.content.indexOf(flag.evidence);
        while (position >= 0) {
          positions.push(position);
          position = source.content.indexOf(flag.evidence, position + 1);
        }
      }
      const hasWholeOccurrence = positions.some((position) => {
        const before = source!.content[position - 1] ?? "";
        const after = source!.content[position + flag.evidence.length] ?? "";
        return !/\p{L}/u.test(before) && !/\p{L}/u.test(after);
      });
      if (!source || source.role !== "user" || !hasWholeOccurrence) failures.push("I2");
    } else if (flag.source_message_index !== -1) {
      failures.push("I2b");
    }
  }
  const restrictedWord = "\u0434\u0438\u0430\u0433\u043d\u043e\u0437";
  const serialized = JSON.stringify(result).toLocaleLowerCase("ru");
  let restrictedIndex = serialized.indexOf(restrictedWord);
  while (restrictedIndex >= 0) {
    const prefix = serialized.slice(Math.max(0, restrictedIndex - 5), restrictedIndex);
    if (!/\u043d\u0435\s*$/u.test(prefix)) failures.push("I5");
    restrictedIndex = serialized.indexOf(restrictedWord, restrictedIndex + restrictedWord.length);
  }
  if (
    !result.hypothesis.disclaimer.trim() ||
    !result.hypothesis.disclaimer.toLocaleLowerCase("ru").includes(`\u043d\u0435 ${restrictedWord}`)
  ) {
    failures.push("I3");
  }
  if (
    result.routing.length > 3 ||
    result.routing.some((route, index) => index > 0 && route.confidence > result.routing[index - 1].confidence)
  ) {
    failures.push("I4");
  }
  if (
    (result.source === "rules_only" && result.model !== undefined) ||
    (result.source !== "rules_only" && result.model === undefined) ||
    (result.model !== undefined && result.model.model_version !== modelVersion)
  ) {
    failures.push("I6");
  }
  if (result.model?.abstained && (result.model.pathologies.length > 0 || result.model.top_contributions.length > 0)) {
    failures.push("I6");
  }
  if (result.source === "model") {
    if (
      result.model?.pathologies[0] === undefined ||
      result.hypothesis.confidence !== result.model.pathologies[0].prob
    ) {
      failures.push("I7");
    }
  } else if (
    (result.source === "llm_fallback" && result.hypothesis.confidence > 0.5) ||
    (result.source === "rules_only" && result.hypothesis.confidence !== 0)
  ) {
    failures.push("I7");
  }
  return [...new Set(failures)];
}

function countKinds(cases: readonly EvalCase[]): Record<EvalCase["kind"], number> {
  return {
    flat: cases.filter((item) => item.kind === "flat").length,
    dialog: cases.filter((item) => item.kind === "dialog").length,
    redflag: cases.filter((item) => item.kind === "redflag").length,
  };
}

function strictSpecialties(item: EvalCase, map: ReadonlyMap<string, PathologyMapRow>): string[] {
  const row = item.gold.pathology ? map.get(item.gold.pathology) : undefined;
  return row ? [row.specialty, ...row.specialty_alt] : [];
}

function isUndertriage(predicted: Urgency, gold: Urgency): boolean {
  const rank: Record<Urgency, number> = { routine: 0, planned: 1, urgent: 2, emergency: 3 };
  return rank[predicted] < rank[gold];
}

function metric(
  metrics: Record<string, number | null>,
  statuses: Record<string, MetricStatus>,
  name: string,
  numerator: number,
  denominator: number,
  state: MetricState = "measured",
  reason?: string,
  excludedCaseIds?: string[],
): void {
  const ratio = safeRatio(numerator, denominator, name);
  metrics[name] = ratio.value;
  statuses[name] = {
    ...ratio.status,
    state: ratio.value === null ? "not_defined" : state,
    ...(reason ? { reason } : {}),
    ...(excludedCaseIds && excludedCaseIds.length > 0 ? { excluded_case_ids: excludedCaseIds } : {}),
  };
}

function reportMarkdown(report: EvalReport): string {
  const m = report.metrics;
  const pct = (name: string): string =>
    m[name] === null ? "not_run" : `${((m[name] as number) * 100).toFixed(1)}%`;
  const fraction = (name: string): string => {
    const status = report.metric_status[name];
    return `${status.numerator ?? "—"}/${status.denominator ?? "—"}`;
  };
  const fn = report.per_case
    .filter((item) => item.kind === "redflag" && item.emergency_expected && !item.emergency_predicted)
    .map((item) => item.id);
  return [
    `mode: ${report.mode}`,
    "",
    "# Demeu evaluation report",
    "",
    `Run: \`${report.run_id}\`; cases SHA256: \`${report.cases_sha256}\`; model: \`${report.model_version}\`.`,
    "",
    `> ${NO_LLM_CAVEAT}`,
    `> ${MAP_CAVEAT}`,
    "",
    "## Measured metrics",
    "",
    "| Metric | Value | Numerator/denominator | Status |",
    "|---|---:|---:|---|",
    `| Pathology top-1 | ${pct("pathology_top1")} | ${fraction("pathology_top1")} | measured; no-llm ideal-extraction upper-bound |`,
    `| M11 Abstain rate | ${pct("abstain_rate")} | ${fraction("abstain_rate")} | measured beside top-1 |`,
    `| M12 Coverage-adjusted top-1 | ${pct("coverage_adjusted_top1")} | ${fraction("coverage_adjusted_top1")} | measured beside top-1; no-llm ideal-extraction upper-bound |`,
    `| M6 Under-triage rate | ${pct("undertriage_rate")} | ${fraction("undertriage_rate")} | UNVALIDATED; ${MAP_CAVEAT} |`,
    `| Pathology top-3 | ${pct("pathology_top3")} | ${fraction("pathology_top3")} | measured; no-llm ideal-extraction upper-bound |`,
    `| Routing top-1 strict | ${pct("routing_top1_strict")} | ${fraction("routing_top1_strict")} | UNVALIDATED |`,
    `| Routing top-3 strict | ${pct("routing_top3_strict")} | ${fraction("routing_top3_strict")} | UNVALIDATED |`,
    `| Routing top-3 differential | ${pct("routing_top3_differential")} | ${fraction("routing_top3_differential")} | UNVALIDATED |`,
    `| Urgency accuracy | ${pct("urgency_accuracy")} | ${fraction("urgency_accuracy")} | UNVALIDATED |`,
    `| Emergency recall, manual P | ${pct("emergency_recall_manual")} | ${fraction("emergency_recall_manual")} | measured; FN: ${fn.join(", ") || "none"} |`,
    `| Emergency precision, manual P/N | ${pct("emergency_precision_manual")} | ${fraction("emergency_precision_manual")} | measured |`,
    `| Emergency specificity, manual N | ${pct("emergency_specificity_manual")} | ${fraction("emergency_specificity_manual")} | measured |`,
    `| M7b emergency recall, table-derived DDX | ${pct("emergency_recall_table_ddx")} | ${fraction("emergency_recall_table_ddx")} | UNVALIDATED |`,
    `| Extraction F1 flat | not_run | —/${report.n.flat} | ${report.metric_status.extraction_f1_flat.reason} |`,
    `| Extraction F1 dialog | not_run | —/${report.n.dialog} | ${report.metric_status.extraction_f1_dialog.reason} |`,
    "",
    "## Golden invariants",
    "",
    `Overall: **${report.invariants.all_passed ? "PASS" : "FAIL"}**.`,
    ...report.invariants.checks.map(
      (check) => `- ${check.id}: ${check.passed ? "PASS" : `FAIL (${check.failures.join(", ")})`}`,
    ),
    "",
    "## Publication guard",
    "",
    `Status: **${report.readme_guard.status}**. Routing and urgency values must not be described as clinician-validated.`,
    "",
  ].join("\n");
}

export async function runEvaluation(options?: {
  casesPath?: string;
  manifestPath?: string;
  mode?: EvalMode;
}): Promise<{ report: EvalReport; markdown: string }> {
  const mode = options?.mode ?? "no-llm";
  if (mode !== "no-llm") fail("only no-llm is enabled while live credentials are revoked");
  const casesPath = path.resolve(ROOT, options?.casesPath ?? "eval/cases.jsonl");
  const manifestPath = path.resolve(ROOT, options?.manifestPath ?? "eval/manifest.json");
  const [casesBytes, manifestBytes, evaluatorBytes] = await Promise.all([
    readFile(casesPath),
    readFile(manifestPath),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  const manifest = parseJsonObject<Manifest>(manifestBytes.toString("utf8"), "manifest");
  const casesSha = sha256(casesBytes);
  if (casesSha !== manifest.artifact.sha256) fail("cases hash is stale against manifest");
  const cases = parseCases(casesBytes.toString("utf8"));
  const kindCounts = countKinds(cases);
  if (
    cases.length !== manifest.selection.count ||
    Object.entries(kindCounts).some(([kind, count]) => manifest.selection.n_by_kind[kind] !== count)
  ) {
    fail("case counts differ from manifest; skipped cases are forbidden");
  }

  const modelPath = path.resolve(ROOT, manifest.dependencies.artifact.path);
  const dictionaryPath = path.resolve(ROOT, manifest.dependencies.dictionary.path);
  const mapPath = path.resolve(ROOT, manifest.dependencies.pathology_map.path);
  const [modelSha, dictionarySha, mapSha, mapText] = await Promise.all([
    fileSha256(modelPath), fileSha256(dictionaryPath), fileSha256(mapPath), readFile(mapPath, "utf8"),
  ]);
  if (modelSha !== manifest.dependencies.artifact.sha256) fail("model hash is stale against manifest");
  if (dictionarySha !== manifest.dependencies.dictionary.sha256) fail("dictionary hash is stale against manifest");
  if (mapSha !== manifest.dependencies.pathology_map.sha256) fail("pathology map hash is stale against manifest");
  const artifact = loadArtifact();
  if (artifact.model_version !== manifest.dependencies.artifact.model_version) fail("model version differs from manifest");
  const mapRows = JSON.parse(mapText) as PathologyMapRow[];
  const map = new Map(mapRows.map((row) => [row.pathology, row]));
  const mapValidated = mapRows.length > 0 && mapRows.every((row) => row.validated);
  if (mapValidated !== manifest.dependencies.pathology_map.validated) fail("map validation status differs from manifest");

  const perCase: PerCaseResult[] = [];
  for (const item of cases) {
    const evidence = evidenceFor(item);
    const vector = buildVector(evidence, artifact);
    const rawPrediction = predict(vector, artifact);
    assertPredictionIntegrity(rawPrediction, vector);
    const result = await analyze(item.messages, { llm: goldPort(item) });
    perCase.push({
      id: item.id,
      kind: item.kind,
      source: result.source,
      gold_pathology: item.gold.pathology,
      predicted_pathologies: result.model?.pathologies.map((entry) => entry.code) ?? [],
      model_abstained: result.model?.abstained ?? null,
      gold_urgency: item.gold.urgency,
      predicted_urgency: result.urgency,
      predicted_routing: result.routing.map((entry) => entry.specialty),
      gold_specialties_strict: strictSpecialties(item, map),
      gold_specialties_differential: [...item.gold.specialty_set],
      emergency_expected: item.gold.emergency_expected,
      emergency_predicted: result.urgency === "emergency",
      invariant_failures: invariantFailures(item, result, artifact.model_version),
    });
  }
  if (perCase.length !== cases.length) fail("not every case produced a result");
  perCase.sort((left, right) => left.id.localeCompare(right.id));

  const metrics: Record<string, number | null> = {};
  const statuses: Record<string, MetricStatus> = {};
  const ddx = perCase.filter((item) => item.kind !== "redflag");
  const scored = ddx.filter((item) => !item.model_abstained && item.predicted_pathologies.length > 0);
  const excluded = ddx.filter((item) => !scored.includes(item)).map((item) => item.id);
  metric(metrics, statuses, "pathology_top1", scored.filter((item) => item.predicted_pathologies[0] === item.gold_pathology).length, scored.length, "measured", scored.length < ddx.length ? "coverage excludes abstained cases" : undefined, excluded);
  metric(metrics, statuses, "pathology_top3", scored.filter((item) => item.gold_pathology !== null && item.predicted_pathologies.slice(0, 3).includes(item.gold_pathology)).length, scored.length, "measured", scored.length < ddx.length ? "coverage excludes abstained cases" : undefined, excluded);

  const evaluatedRoutes = ddx.filter((item) => item.source === "model");
  const routeExcluded = ddx.filter((item) => item.source !== "model").map((item) => item.id);
  const caseById = new Map(cases.map((item) => [item.id, item]));
  const routeReason = mapValidated ? undefined : MAP_CAVEAT;
  const routeState: MetricState = mapValidated ? "measured" : "UNVALIDATED";
  metric(metrics, statuses, "routing_top1_strict", evaluatedRoutes.filter((item) => strictSpecialties(caseById.get(item.id)!, map).includes(item.predicted_routing[0])).length, evaluatedRoutes.length, routeState, routeReason, routeExcluded);
  metric(metrics, statuses, "routing_top3_strict", evaluatedRoutes.filter((item) => item.predicted_routing.slice(0, 3).some((specialty) => strictSpecialties(caseById.get(item.id)!, map).includes(specialty))).length, evaluatedRoutes.length, routeState, routeReason, routeExcluded);
  metric(metrics, statuses, "routing_top3_differential", evaluatedRoutes.filter((item) => item.predicted_routing.slice(0, 3).some((specialty) => caseById.get(item.id)!.gold.specialty_set.includes(specialty))).length, evaluatedRoutes.length, routeState, routeReason, routeExcluded);
  metric(metrics, statuses, "urgency_accuracy", evaluatedRoutes.filter((item) => item.predicted_urgency === caseById.get(item.id)!.gold.urgency).length, evaluatedRoutes.length, routeState, routeReason, routeExcluded);
  metric(metrics, statuses, "undertriage_rate", evaluatedRoutes.filter((item) => isUndertriage(item.predicted_urgency, caseById.get(item.id)!.gold.urgency)).length, evaluatedRoutes.length, routeState, routeReason, routeExcluded);

  const manual = perCase.filter((item) => item.kind === "redflag");
  const manualPositive = manual.filter((item) => item.emergency_expected);
  const manualNegative = manual.filter((item) => !item.emergency_expected);
  const manualPredictedPositive = manual.filter((item) => item.emergency_predicted);
  metric(metrics, statuses, "emergency_recall_manual", manualPositive.filter((item) => item.emergency_predicted).length, manualPositive.length);
  metric(metrics, statuses, "emergency_precision_manual", manualPredictedPositive.filter((item) => item.emergency_expected).length, manualPredictedPositive.length);
  metric(metrics, statuses, "emergency_specificity_manual", manualNegative.filter((item) => !item.emergency_predicted).length, manualNegative.length);
  const tableEmergency = ddx.filter((item) => item.emergency_expected);
  metric(metrics, statuses, "emergency_recall_table_ddx", tableEmergency.filter((item) => item.emergency_predicted).length, tableEmergency.length, routeState, routeReason);

  const modelPresent = ddx.filter((item) => item.model_abstained !== null);
  metric(metrics, statuses, "abstain_rate", modelPresent.filter((item) => item.model_abstained).length, modelPresent.length);
  metric(metrics, statuses, "rules_only_rate", ddx.filter((item) => item.source === "rules_only").length, ddx.length);
  metrics.coverage_adjusted_top1 = metrics.pathology_top1 === null ? null : metrics.pathology_top1 * (scored.length / ddx.length);
  statuses.coverage_adjusted_top1 = { state: "measured", numerator: scored.filter((item) => item.predicted_pathologies[0] === item.gold_pathology).length, denominator: ddx.length };

  for (const kind of ["flat", "dialog"] as const) {
    for (const name of ["precision", "recall", "f1"]) {
      const key = `extraction_${name}_${kind}`;
      metrics[key] = null;
      statuses[key] = { state: "not_run", reason: `actual LLM extraction was not run in mode ${mode}` };
    }
  }

  const invariantNames = ["I1", "I2", "I2b", "I3", "I4", "I5", "I6", "I7"];
  const checks = invariantNames.map((id) => {
    const failures = perCase.filter((item) => item.invariant_failures.includes(id)).map((item) => item.id);
    return { id, passed: failures.length === 0, failures };
  });
  const evaluatorSha = sha256(evaluatorBytes);
  const manifestSha = sha256(manifestBytes);
  const runId = `no-llm-${sha256([casesSha, manifestSha, modelSha, mapSha, evaluatorSha].join(":" )).slice(0, 16)}`;
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    // Provenance remains explicit even outside a Git checkout.
  }
  const blockedMetrics = mapValidated
    ? {}
    : Object.fromEntries(
        ["routing_top1_strict", "routing_top3_strict", "routing_top3_differential", "urgency_accuracy", "undertriage_rate", "emergency_recall_table_ddx"].map((name) => [name, MAP_CAVEAT]),
      );
  const report: EvalReport = {
    schema_version: 1,
    run_id: runId,
    commit,
    mode,
    model_version: artifact.model_version,
    cases_sha256: casesSha,
    pathology_map_validated: mapValidated,
    provenance: {
      cases: { path: path.relative(ROOT, casesPath), sha256: casesSha },
      manifest: { path: path.relative(ROOT, manifestPath), sha256: manifestSha },
      model: { path: manifest.dependencies.artifact.path, sha256: modelSha },
      dictionary: { path: manifest.dependencies.dictionary.path, sha256: dictionarySha },
      pathology_map: { path: manifest.dependencies.pathology_map.path, sha256: mapSha },
      evaluator: { path: "scripts/eval.ts", sha256: evaluatorSha },
    },
    n: {
      total: cases.length,
      ...kindCounts,
      pathology_gold: ddx.length,
      manual_positive: manualPositive.length,
      manual_negative: manualNegative.length,
    },
    invariants: { all_passed: checks.every((check) => check.passed), checks },
    metrics,
    metric_status: statuses,
    caveats: [NO_LLM_CAVEAT, ...(mapValidated ? [] : [MAP_CAVEAT])],
    readme_guard: {
      status: checks.every((check) => check.passed) ? "PARTIAL" : "BLOCKED",
      required_mode: mode,
      required_hashes: {
        cases: casesSha,
        manifest: manifestSha,
        model: modelSha,
        dictionary: dictionarySha,
        pathology_map: mapSha,
        evaluator: evaluatorSha,
      },
      allowed_metrics: checks.every((check) => check.passed)
        ? ["pathology_top1", "pathology_top3", "coverage_adjusted_top1", "abstain_rate", "rules_only_rate", "emergency_recall_manual", "emergency_precision_manual", "emergency_specificity_manual"]
        : [],
      blocked_metrics: blockedMetrics,
    },
    per_case: perCase,
  };
  return { report, markdown: reportMarkdown(report) };
}

export function validateReportForReadme(
  report: EvalReport,
  expected: { mode: EvalMode; casesSha256: string; modelSha256: string; mapSha256: string },
): void {
  if (
    expected.mode !== "no-llm" ||
    report.mode !== "no-llm" ||
    report.mode !== expected.mode ||
    report.readme_guard.required_mode !== report.mode
  ) {
    fail("report mode is not the exact requested no-llm publication mode");
  }
  if (
    report.cases_sha256 !== expected.casesSha256 ||
    report.provenance.cases.sha256 !== report.cases_sha256 ||
    report.provenance.model.sha256 !== expected.modelSha256 ||
    report.provenance.pathology_map.sha256 !== expected.mapSha256
  ) {
    fail("report input hashes are stale");
  }
  const provenanceEntries = Object.entries(report.provenance) as [
    keyof EvalReport["provenance"],
    { path: string; sha256: string },
  ][];
  for (const [name, entry] of provenanceEntries) {
    const currentPath = path.resolve(ROOT, entry.path);
    let currentHash: string;
    try {
      currentHash = sha256(readFileSync(currentPath));
    } catch {
      fail(`report ${name} input is unavailable`);
    }
    if (entry.sha256 !== currentHash || report.readme_guard.required_hashes[name] !== currentHash) {
      fail(`report ${name} input hash is stale`);
    }
  }
  let currentMap: PathologyMapRow[];
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.resolve(ROOT, report.provenance.pathology_map.path), "utf8"),
    );
    if (!Array.isArray(parsed)) fail("pathology map is not an array");
    currentMap = parsed as PathologyMapRow[];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Eval contract error:")) {
      throw error;
    }
    fail("pathology map is invalid JSON");
  }
  const currentMapValidated =
    currentMap.length > 0 && currentMap.every((row) => row.validated);
  if (report.pathology_map_validated !== currentMapValidated) {
    fail("publication pathology-map validation status is incoherent");
  }
  if (report.model_version !== loadArtifact().model_version) fail("report model version is stale");
  if (!report.caveats.includes(NO_LLM_CAVEAT)) fail("required no-llm ideal-extraction caveat is missing");
  if (!report.pathology_map_validated && !report.caveats.includes(MAP_CAVEAT)) {
    fail("required unvalidated pathology-map caveat is missing");
  }
  if (!report.invariants.all_passed || report.per_case.length !== report.n.total) fail("report is incomplete or has failed invariants");
  if (new Set(report.per_case.map((item) => item.id)).size !== report.n.total) fail("report has duplicate or missing case ids");

  const extractionMetrics = [
    "extraction_precision_flat",
    "extraction_recall_flat",
    "extraction_f1_flat",
    "extraction_precision_dialog",
    "extraction_recall_dialog",
    "extraction_f1_dialog",
  ];
  for (const name of extractionMetrics) {
    const status = report.metric_status[name];
    if (
      report.metrics[name] !== null ||
      status?.state !== "not_run" ||
      !status.reason?.includes("no-llm")
    ) {
      fail(`no-llm extraction metric ${name} must be null/not_run with a reason`);
    }
  }

  const expectedN = {
    total: report.per_case.length,
    flat: report.per_case.filter((item) => item.kind === "flat").length,
    dialog: report.per_case.filter((item) => item.kind === "dialog").length,
    redflag: report.per_case.filter((item) => item.kind === "redflag").length,
    pathology_gold: report.per_case.filter((item) => item.kind !== "redflag").length,
    manual_positive: report.per_case.filter(
      (item) => item.kind === "redflag" && item.emergency_expected,
    ).length,
    manual_negative: report.per_case.filter(
      (item) => item.kind === "redflag" && !item.emergency_expected,
    ).length,
  };
  if (canonicalJson(report.n) !== canonicalJson(expectedN)) {
    fail("publication case counts are incoherent with per_case");
  }

  const invariantNames = ["I1", "I2", "I2b", "I3", "I4", "I5", "I6", "I7"];
  const expectedChecks = invariantNames.map((id) => {
    const failures = report.per_case
      .filter((item) => item.invariant_failures.includes(id))
      .map((item) => item.id);
    return { id, passed: failures.length === 0, failures };
  });
  const expectedInvariants = {
    all_passed: expectedChecks.every((check) => check.passed),
    checks: expectedChecks,
  };
  if (canonicalJson(report.invariants) !== canonicalJson(expectedInvariants)) {
    fail("publication invariant headline is incoherent with per_case");
  }

  const expectedMetrics: Record<string, number | null> = {};
  const expectedStatuses: Record<string, MetricStatus> = {};
  const ddx = report.per_case.filter((item) => item.kind !== "redflag");
  const scored = ddx.filter(
    (item) => !item.model_abstained && item.predicted_pathologies.length > 0,
  );
  const excluded = ddx.filter((item) => !scored.includes(item)).map((item) => item.id);
  metric(
    expectedMetrics,
    expectedStatuses,
    "pathology_top1",
    scored.filter((item) => item.predicted_pathologies[0] === item.gold_pathology).length,
    scored.length,
    "measured",
    scored.length < ddx.length ? "coverage excludes abstained cases" : undefined,
    excluded,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "pathology_top3",
    scored.filter(
      (item) =>
        item.gold_pathology !== null &&
        item.predicted_pathologies.slice(0, 3).includes(item.gold_pathology),
    ).length,
    scored.length,
    "measured",
    scored.length < ddx.length ? "coverage excludes abstained cases" : undefined,
    excluded,
  );

  const evaluatedRoutes = ddx.filter((item) => item.source === "model");
  const routeExcluded = ddx
    .filter((item) => item.source !== "model")
    .map((item) => item.id);
  const routeState: MetricState = currentMapValidated ? "measured" : "UNVALIDATED";
  const routeReason = currentMapValidated ? undefined : MAP_CAVEAT;
  metric(
    expectedMetrics,
    expectedStatuses,
    "routing_top1_strict",
    evaluatedRoutes.filter((item) =>
      item.gold_specialties_strict.includes(item.predicted_routing[0]),
    ).length,
    evaluatedRoutes.length,
    routeState,
    routeReason,
    routeExcluded,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "routing_top3_strict",
    evaluatedRoutes.filter((item) =>
      item.predicted_routing
        .slice(0, 3)
        .some((specialty) => item.gold_specialties_strict.includes(specialty)),
    ).length,
    evaluatedRoutes.length,
    routeState,
    routeReason,
    routeExcluded,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "routing_top3_differential",
    evaluatedRoutes.filter((item) =>
      item.predicted_routing
        .slice(0, 3)
        .some((specialty) => item.gold_specialties_differential.includes(specialty)),
    ).length,
    evaluatedRoutes.length,
    routeState,
    routeReason,
    routeExcluded,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "urgency_accuracy",
    evaluatedRoutes.filter((item) => item.predicted_urgency === item.gold_urgency).length,
    evaluatedRoutes.length,
    routeState,
    routeReason,
    routeExcluded,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "undertriage_rate",
    evaluatedRoutes.filter((item) =>
      isUndertriage(item.predicted_urgency, item.gold_urgency),
    ).length,
    evaluatedRoutes.length,
    routeState,
    routeReason,
    routeExcluded,
  );

  const manual = report.per_case.filter((item) => item.kind === "redflag");
  const manualPositive = manual.filter((item) => item.emergency_expected);
  const manualNegative = manual.filter((item) => !item.emergency_expected);
  const manualPredictedPositive = manual.filter((item) => item.emergency_predicted);
  metric(
    expectedMetrics,
    expectedStatuses,
    "emergency_recall_manual",
    manualPositive.filter((item) => item.emergency_predicted).length,
    manualPositive.length,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "emergency_precision_manual",
    manualPredictedPositive.filter((item) => item.emergency_expected).length,
    manualPredictedPositive.length,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "emergency_specificity_manual",
    manualNegative.filter((item) => !item.emergency_predicted).length,
    manualNegative.length,
  );
  const tableEmergency = ddx.filter((item) => item.emergency_expected);
  metric(
    expectedMetrics,
    expectedStatuses,
    "emergency_recall_table_ddx",
    tableEmergency.filter((item) => item.emergency_predicted).length,
    tableEmergency.length,
    routeState,
    routeReason,
  );

  const modelPresent = ddx.filter((item) => item.model_abstained !== null);
  metric(
    expectedMetrics,
    expectedStatuses,
    "abstain_rate",
    modelPresent.filter((item) => item.model_abstained).length,
    modelPresent.length,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "rules_only_rate",
    ddx.filter((item) => item.source === "rules_only").length,
    ddx.length,
  );
  metric(
    expectedMetrics,
    expectedStatuses,
    "coverage_adjusted_top1",
    ddx.filter((item) => item.predicted_pathologies[0] === item.gold_pathology).length,
    ddx.length,
  );

  for (const kind of ["flat", "dialog"] as const) {
    for (const name of ["precision", "recall", "f1"]) {
      const key = `extraction_${name}_${kind}`;
      expectedMetrics[key] = null;
      expectedStatuses[key] = {
        state: "not_run",
        reason: `actual LLM extraction was not run in mode ${report.mode}`,
      };
    }
  }
  if (
    canonicalJson(report.metrics) !== canonicalJson(expectedMetrics) ||
    canonicalJson(report.metric_status) !== canonicalJson(expectedStatuses)
  ) {
    fail(
      "publication headline metrics are incoherent with per_case (top-1/top-3/manual/routing/urgency/coverage)",
    );
  }

  const expectedAllowedMetrics = expectedInvariants.all_passed
    ? [
        "pathology_top1",
        "pathology_top3",
        "coverage_adjusted_top1",
        "abstain_rate",
        "rules_only_rate",
        "emergency_recall_manual",
        "emergency_precision_manual",
        "emergency_specificity_manual",
      ]
    : [];
  const unvalidatedNames = [
    "routing_top1_strict",
    "routing_top3_strict",
    "routing_top3_differential",
    "urgency_accuracy",
    "undertriage_rate",
    "emergency_recall_table_ddx",
  ];
  const expectedBlockedMetrics = currentMapValidated
    ? {}
    : Object.fromEntries(unvalidatedNames.map((name) => [name, MAP_CAVEAT]));
  if (
    report.readme_guard.status !==
      (expectedInvariants.all_passed ? "PARTIAL" : "BLOCKED") ||
    canonicalJson(report.readme_guard.allowed_metrics) !==
      canonicalJson(expectedAllowedMetrics) ||
    canonicalJson(report.readme_guard.blocked_metrics) !==
      canonicalJson(expectedBlockedMetrics)
  ) {
    fail("publication-allowed/block headline is incoherent with per_case");
  }
  for (const [name, status] of Object.entries(report.metric_status)) {
    if (report.metrics[name] === null && !status.reason) fail(`null metric ${name} has no reason`);
    if (status.state === "UNVALIDATED" && !report.readme_guard.blocked_metrics[name]) fail(`unvalidated metric ${name} is not publication-blocked`);
    if (status.state === "UNVALIDATED" && report.readme_guard.allowed_metrics.includes(name)) fail(`unvalidated metric ${name} is publication-allowed`);
  }
}

interface CliOptions {
  allowUnvalidated: boolean;
  casesPath?: string;
  manifestPath?: string;
  outPath: string;
  markdownPath: string;
  check: boolean;
}

function cliOptions(argv: string[]): CliOptions {
  const result: CliOptions = {
    allowUnvalidated: false,
    outPath: "eval/report.json",
    markdownPath: "eval/report.md",
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-llm" || argument === "--mode" && argv[index + 1] === "no-llm") {
      if (argument === "--mode") index += 1;
    } else if (argument === "--allow-unvalidated") result.allowUnvalidated = true;
    else if (argument === "--check") result.check = true;
    else if (["--cases", "--manifest", "--out", "--markdown"].includes(argument)) {
      const value = argv[++index];
      if (!value) fail(`${argument} needs a value`);
      if (argument === "--cases") result.casesPath = value;
      if (argument === "--manifest") result.manifestPath = value;
      if (argument === "--out") result.outPath = value;
      if (argument === "--markdown") result.markdownPath = value;
    } else if (argument === "--mode") {
      fail("live/full mode is disabled while credentials are revoked");
    } else {
      fail(`unknown argument ${argument}`);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const options = cliOptions(process.argv.slice(2));
  const manifestPath = path.resolve(ROOT, options.manifestPath ?? "eval/manifest.json");
  const manifest = parseJsonObject<Manifest>(await readFile(manifestPath, "utf8"), "manifest");
  if (!manifest.dependencies.pathology_map.validated && !options.allowUnvalidated) {
    process.stderr.write(`${MAP_CAVEAT}\nPass --allow-unvalidated to run without treating these metrics as validated.\n`);
    process.exitCode = 2;
    return;
  }
  const { report, markdown } = await runEvaluation({
    casesPath: options.casesPath,
    manifestPath: options.manifestPath,
    mode: "no-llm",
  });
  validateReportForReadme(report, {
    mode: "no-llm",
    casesSha256: report.provenance.cases.sha256,
    modelSha256: report.provenance.model.sha256,
    mapSha256: report.provenance.pathology_map.sha256,
  });
  const json = canonicalJson(report);
  const outPath = path.resolve(ROOT, options.outPath);
  const markdownPath = path.resolve(ROOT, options.markdownPath);
  if (options.check) {
    const [oldJson, oldMarkdown] = await Promise.all([readFile(outPath, "utf8"), readFile(markdownPath, "utf8")]);
    if (oldJson !== json || oldMarkdown !== markdown) fail("checked reports are stale or non-deterministic");
    process.stdout.write(`verified ${path.relative(ROOT, outPath)} and ${path.relative(ROOT, markdownPath)}\n`);
    return;
  }
  await Promise.all([writeFile(outPath, json), writeFile(markdownPath, markdown)]);
  process.stdout.write(`wrote ${path.relative(ROOT, outPath)} and ${path.relative(ROOT, markdownPath)} (${report.n.total} cases, mode=${report.mode})\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
