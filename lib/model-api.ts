import triageReportJson from "../eval/report.json";
import redFlagBenchmarkJson from "../reports/redflags/redflags-benchmark-v1.json";
import refusalReportJson from "../reports/referral-refusal-baseline-v0.json";
import waitTimeReportJson from "../reports/wait-time-baseline-v0.json";
import labLoadReportJson from "../reports/lab-load-v1.json";
import { loadArtifact } from "./model";
import {
  isWorkspaceAuthError,
  requireWorkspaceActor,
  WorkspaceAuthError,
  type WorkspaceActor,
} from "./workspace-auth";

export const MODEL_IDS = [
  "triage-lr-v1",
  "redflags-rules-baseline-v1",
  "redflags-rules-v1",
  "redflags-qwen2.5-7b-v1",
  "redflags-qwen2.5-14b-v1",
  "redflags-jev-1.13",
  "d1-wait-time-v0",
  "b3-referral-refusal-v0",
  "d2-laboratory-load-v0",
] as const;

export type ModelId = typeof MODEL_IDS[number];
export type MetricState = "measured" | "unvalidated" | "not_run" | "unavailable" | "training_only";

export interface ModelMetric {
  name: string;
  value: number | null;
  unit: string;
  state: MetricState;
  reason: string | null;
  period: string | null;
  rows: number | null;
  numerator: number | null;
  denominator: number | null;
}

export interface ModelCard {
  id: ModelId;
  taskId: "A" | "redflags" | "D1" | "B3" | "D2";
  title: string;
  kind: "runtime_classifier" | "deterministic_rules" | "benchmark_candidate" | "research_model" | "blocked_forecast";
  availability: "runtime" | "measured" | "unavailable";
  runtimeActivation: "active" | "research_only" | "blocked";
  researchOnly: boolean;
  metricStatus: "measured" | "unvalidated" | "not_run" | "unavailable";
  primaryMetric: ModelMetric | null;
  baseline: ModelMetric | null;
  limitations: string[];
  detailPath: string;
}

export interface ModelArtifactSource {
  path: string;
  sha256: string | null;
}

export interface ModelDetail extends ModelCard {
  source: {
    artifacts: ModelArtifactSource[];
    dataset: {
      name: string;
      period: { from: string; to: string } | null;
      rows: number | null;
      licenseStatus: string | null;
    };
  };
  evaluation: {
    design: string;
    split: Record<string, unknown> | null;
    sampleSize: number | null;
    metrics: ModelMetric[];
    baselines: { name: string; metrics: ModelMetric[] }[];
    slices: Record<string, unknown> | null;
    caveats: string[];
  };
  configuration: Record<string, unknown> | null;
  unavailable: { code: string; reason: string; requiredInputs: string[] } | null;
}

export interface RedFlagBenchmarkCandidate {
  modelId: ModelId;
  implementation: {
    kind: string;
    provider: string | null;
    requestedModel: string;
    observedModel: string;
    threshold: number | null;
    questionSpecId: string | null;
  };
  availability: "measured" | "unavailable";
  itemCount: number;
  metrics: {
    tp: number;
    fp: number;
    tn: number;
    fn: number;
    precision: number;
    recall: number;
    f1: number;
    falsePositiveRate: number;
  } | null;
  slices: Record<string, unknown> | null;
  latency: {
    measurementUnit: string;
    requestCount: number;
    totalMs: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    scope: string | null;
  } | null;
  cost: { currency: string; amount: number; basis: string; coverage: number | null; inputTokens: number | null; outputTokens: number | null } | null;
  structuredOutput: Record<string, unknown> | null;
  unavailableReason: string | null;
}

export interface RedFlagBenchmark {
  id: "redflags-ru-kk-v1";
  title: string;
  researchOnly: true;
  runtimeIntegration: "deterministic_rules_only";
  corpus: {
    itemCount: number;
    languageCounts: { ru: number; kk: number };
    classCounts: { positive: number; negative: number };
    sha256: string;
    frozenOn: string;
  };
  evaluationDesign: {
    sameFrozenSplit: boolean;
    rulesDevelopedAgainstCorpus: boolean;
    unseenGeneralizationClaim: boolean;
  };
  candidates: RedFlagBenchmarkCandidate[];
  limitations: string[];
}

export interface ModelApiDeps {
  actor?: (req: Request) => Promise<WorkspaceActor>;
  evidence?: Partial<ModelEvidence>;
}

interface ModelEvidence {
  triage: unknown;
  redFlags: unknown;
  refusal: unknown;
  waitTime: unknown;
  labLoad: unknown;
}

const DEFAULT_EVIDENCE: ModelEvidence = {
  triage: triageReportJson,
  redFlags: redFlagBenchmarkJson,
  refusal: refusalReportJson,
  waitTime: waitTimeReportJson,
  labLoad: labLoadReportJson,
};
const MODEL_ID_SET = new Set<string>(MODEL_IDS);
const NO_STORE = { "Cache-Control": "no-store" } as const;

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid ${field}`);
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${field}`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid ${field}`);
  return value;
}

function fraction(value: unknown, field: string): number {
  const result = finite(value, field);
  if (result < 0 || result > 1) throw new Error(`invalid ${field}`);
  return result;
}

function integer(value: unknown, field: string): number {
  const result = finite(value, field);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`invalid ${field}`);
  return result;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}

function nullableFinite(value: unknown, field: string): number | null {
  return value === null ? null : finite(value, field);
}

function strings(value: unknown, field: string): string[] {
  return array(value, field).map((entry, index) => text(entry, `${field}[${index}]`));
}

function evidence(deps: ModelApiDeps): ModelEvidence {
  return { ...DEFAULT_EVIDENCE, ...deps.evidence };
}

function projectConfusionSlices(value: unknown, field: string): Record<string, unknown> {
  const source = object(value, field);
  const result: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (!/^(language:(ru|kk)|trigger:[a-z_]+)$/u.test(name)) throw new Error(`invalid ${field} key`);
    const slice = object(raw, `${field}.${name}`);
    result[name] = {
      tp: integer(slice.tp, `${field}.${name}.tp`),
      fp: integer(slice.fp, `${field}.${name}.fp`),
      tn: integer(slice.tn, `${field}.${name}.tn`),
      fn: integer(slice.fn, `${field}.${name}.fn`),
      precision: fraction(slice.precision, `${field}.${name}.precision`),
      recall: fraction(slice.recall, `${field}.${name}.recall`),
      f1: fraction(slice.f1, `${field}.${name}.f1`),
      falsePositiveRate: fraction(slice.false_positive_rate, `${field}.${name}.false_positive_rate`),
    };
  }
  return result;
}

function projectPartition(value: unknown, field: string): Record<string, unknown> {
  const source = object(value, field);
  return {
    period: text(source.period, `${field}.period`),
    rows: integer(source.rows, `${field}.rows`),
    ...(source.positives === undefined ? {} : { positives: integer(source.positives, `${field}.positives`) }),
    ...(source.prevalence === undefined ? {} : { prevalence: finite(source.prevalence, `${field}.prevalence`) }),
    ...(source.used_for === undefined ? {} : { usedFor: text(source.used_for, `${field}.used_for`) }),
    ...(source.used_for_selection === undefined ? {} : { usedForSelection: boolean(source.used_for_selection, `${field}.used_for_selection`) }),
    ...(source.used_for_model_selection_in_this_pipeline === undefined ? {} : {
      usedForModelSelectionInThisPipeline: boolean(source.used_for_model_selection_in_this_pipeline, `${field}.used_for_model_selection_in_this_pipeline`),
    }),
    ...(source.previously_examined_in_source_handoff === undefined ? {} : {
      previouslyExaminedInSourceHandoff: boolean(source.previously_examined_in_source_handoff, `${field}.previously_examined_in_source_handoff`),
    }),
    ...(source.evaluated_once_after_selection === undefined ? {} : {
      evaluatedOnceAfterSelection: boolean(source.evaluated_once_after_selection, `${field}.evaluated_once_after_selection`),
    }),
    ...(source.evaluation_role === undefined ? {} : { evaluationRole: text(source.evaluation_role, `${field}.evaluation_role`) }),
  };
}

function projectSplit(value: unknown, field: string): Record<string, unknown> {
  const source = object(value, field);
  return {
    strategy: text(source.strategy, `${field}.strategy`),
    train: projectPartition(source.train, `${field}.train`),
    validation: projectPartition(source.validation, `${field}.validation`),
    test: projectPartition(source.test, `${field}.test`),
  };
}

function projectRefusalCohort(value: unknown): Record<string, unknown> {
  const source = object(value, "refusal.cohort");
  const byMonth = object(source.by_month, "refusal.cohort.by_month");
  const months: Record<string, unknown> = {};
  for (const [month, raw] of Object.entries(byMonth)) {
    if (!/^20[0-9]{2}-(0[1-9]|1[0-2])$/u.test(month)) throw new Error("invalid cohort month");
    const row = object(raw, `cohort.by_month.${month}`);
    months[month] = {
      inputRows: integer(row.input_rows, `${month}.input_rows`),
      matureRows: integer(row.mature_rows, `${month}.mature_rows`),
      refusedOnly: integer(row.refused_only, `${month}.refused_only`),
      hospitalizedOnly: integer(row.hospitalized_only, `${month}.hospitalized_only`),
      censoredNeither: integer(row.censored_neither, `${month}.censored_neither`),
      conflictingBoth: integer(row.conflicting_both, `${month}.conflicting_both`),
    };
  }
  return {
    sourceRowsBeforeDuplicatePolicy: integer(source.source_rows_before_duplicate_policy, "cohort.source_rows_before_duplicate_policy"),
    inputRows: integer(source.input_rows, "cohort.input_rows"),
    matureRows: integer(source.mature_rows, "cohort.mature_rows"),
    refusedOnly: integer(source.refused_only, "cohort.refused_only"),
    hospitalizedOnly: integer(source.hospitalized_only, "cohort.hospitalized_only"),
    byMonth: months,
  };
}

function metric(
  name: string,
  value: number | null,
  unit: string,
  state: MetricState,
  options: Partial<Pick<ModelMetric, "reason" | "period" | "rows" | "numerator" | "denominator">> = {},
): ModelMetric {
  return {
    name,
    value,
    unit,
    state,
    reason: options.reason ?? null,
    period: options.period ?? null,
    rows: options.rows ?? null,
    numerator: options.numerator ?? null,
    denominator: options.denominator ?? null,
  };
}

function redFlagId(candidateId: string): ModelId {
  const mapping: Record<string, ModelId> = {
    rules_baseline: "redflags-rules-baseline-v1",
    rules: "redflags-rules-v1",
    "qwen2.5:7b": "redflags-qwen2.5-7b-v1",
    "qwen2.5:14b": "redflags-qwen2.5-14b-v1",
    jev: "redflags-jev-1.13",
  };
  const result = mapping[candidateId];
  if (!result) throw new Error("unknown red-flag candidate");
  return result;
}

function redFlagCandidate(value: unknown, index: number): RedFlagBenchmarkCandidate {
  const source = object(value, `redFlags.candidates[${index}]`);
  const id = redFlagId(text(source.id, "candidate.id"));
  const availability = text(source.availability, "candidate.availability");
  if (availability !== "measured" && availability !== "unavailable") throw new Error("invalid candidate availability");
  let metrics: RedFlagBenchmarkCandidate["metrics"] = null;
  if (source.metrics !== null) {
    const values = object(source.metrics, "candidate.metrics");
    metrics = {
      tp: integer(values.tp, "metrics.tp"),
      fp: integer(values.fp, "metrics.fp"),
      tn: integer(values.tn, "metrics.tn"),
      fn: integer(values.fn, "metrics.fn"),
      precision: fraction(values.precision, "metrics.precision"),
      recall: fraction(values.recall, "metrics.recall"),
      f1: fraction(values.f1, "metrics.f1"),
      falsePositiveRate: fraction(values.false_positive_rate, "metrics.false_positive_rate"),
    };
  }
  if ((availability === "measured") !== (metrics !== null)) throw new Error("candidate availability and metrics disagree");
  let latency: RedFlagBenchmarkCandidate["latency"] = null;
  if (source.latency_ms !== null) {
    const values = object(source.latency_ms, "candidate.latency_ms");
    latency = {
      measurementUnit: text(values.measurement_unit, "latency.measurement_unit"),
      requestCount: integer(values.request_count, "latency.request_count"),
      totalMs: finite(values.total, "latency.total"),
      meanMs: finite(values.mean, "latency.mean"),
      p50Ms: finite(values.p50, "latency.p50"),
      p95Ms: finite(values.p95, "latency.p95"),
      scope: values.scope === undefined ? null : nullableText(values.scope, "latency.scope"),
    };
  }
  let structuredOutput: Record<string, unknown> | null = null;
  if (source.structured_output !== undefined && source.structured_output !== null) {
    const output = object(source.structured_output, "candidate.structured_output");
    const rejected = output.rejected_response_count ?? output.rejected_malformed_response_count;
    structuredOutput = {
      logicalBatchCount: integer(output.logical_batch_count, "structured_output.logical_batch_count"),
      acceptedRequestCount: integer(output.accepted_request_count, "structured_output.accepted_request_count"),
      rejectedResponseCount: integer(rejected, "structured_output.rejected_response_count"),
      inputTokens: output.input_tokens === undefined ? null : integer(output.input_tokens, "structured_output.input_tokens"),
      outputTokens: output.output_tokens === undefined ? null : integer(output.output_tokens, "structured_output.output_tokens"),
    };
  }
  let cost: RedFlagBenchmarkCandidate["cost"] = null;
  if (source.cost !== null) {
    const values = object(source.cost, "candidate.cost");
    cost = {
      currency: text(values.currency, "cost.currency"),
      amount: finite(values.amount, "cost.amount"),
      basis: text(values.basis, "cost.basis"),
      coverage: values.coverage === undefined ? null : finite(values.coverage, "cost.coverage"),
      inputTokens: structuredOutput?.inputTokens === null || structuredOutput?.inputTokens === undefined
        ? null : integer(structuredOutput.inputTokens, "structured_output.inputTokens"),
      outputTokens: structuredOutput?.outputTokens === null || structuredOutput?.outputTokens === undefined
        ? null : integer(structuredOutput.outputTokens, "structured_output.outputTokens"),
    };
  }
  return {
    modelId: id,
    implementation: {
      kind: text(source.kind, "candidate.kind"),
      provider: source.provider === undefined ? null : text(source.provider, "candidate.provider"),
      requestedModel: text(source.model, "candidate.model"),
      observedModel: text(source.version, "candidate.version"),
      threshold: source.threshold === undefined ? null : finite(source.threshold, "candidate.threshold"),
      questionSpecId: source.question_spec_id === undefined ? null : text(source.question_spec_id, "candidate.question_spec_id"),
    },
    availability,
    itemCount: integer(source.item_count, "candidate.item_count"),
    metrics,
    slices: source.slices === null ? null : projectConfusionSlices(source.slices, "candidate.slices"),
    latency,
    cost,
    structuredOutput,
    unavailableReason: source.unavailable_reason === undefined ? null : nullableText(source.unavailable_reason, "candidate.unavailable_reason"),
  };
}

function buildRedFlagBenchmark(sourceValue: unknown): RedFlagBenchmark {
  const source = object(sourceValue, "redFlags");
  if (source.schema_version !== "redflags-benchmark-v1") throw new Error("invalid red-flag evidence version");
  const corpus = object(source.corpus, "redFlags.corpus");
  const design = object(source.evaluation_design, "redFlags.evaluation_design");
  const candidates = array(source.candidates, "redFlags.candidates").map(redFlagCandidate);
  if (candidates.length !== 5 || new Set(candidates.map((candidate) => candidate.modelId)).size !== candidates.length) {
    throw new Error("invalid red-flag candidate set");
  }
  const measured = candidates.find((candidate) => candidate.metrics !== null);
  if (!measured?.metrics) throw new Error("red-flag reference candidate unavailable");
  const ruSlice = object(object(array(source.candidates, "redFlags.candidates")[0], "candidate").slices, "candidate.slices")["language:ru"];
  const kkSlice = object(object(array(source.candidates, "redFlags.candidates")[0], "candidate").slices, "candidate.slices")["language:kk"];
  const sliceCount = (slice: unknown, name: string) => {
    const values = object(slice, name);
    return integer(values.tp, `${name}.tp`) + integer(values.fp, `${name}.fp`) +
      integer(values.tn, `${name}.tn`) + integer(values.fn, `${name}.fn`);
  };
  return {
    id: "redflags-ru-kk-v1",
    title: text(source.benchmark_title, "redFlags.benchmark_title"),
    researchOnly: true,
    runtimeIntegration: "deterministic_rules_only",
    corpus: {
      itemCount: integer(corpus.item_count, "corpus.item_count"),
      languageCounts: { ru: sliceCount(ruSlice, "language:ru"), kk: sliceCount(kkSlice, "language:kk") },
      classCounts: {
        positive: measured.metrics.tp + measured.metrics.fn,
        negative: measured.metrics.tn + measured.metrics.fp,
      },
      sha256: text(corpus.sha256, "corpus.sha256"),
      frozenOn: text(corpus.frozen_on, "corpus.frozen_on"),
    },
    evaluationDesign: {
      sameFrozenSplit: boolean(object(source.method, "redFlags.method").same_frozen_split, "method.same_frozen_split"),
      rulesDevelopedAgainstCorpus: boolean(design.rules_developed_against_this_corpus, "evaluation_design.rules_developed_against_this_corpus"),
      unseenGeneralizationClaim: boolean(design.unseen_generalization_claim, "evaluation_design.unseen_generalization_claim"),
    },
    candidates,
    limitations: strings(source.limitations, "redFlags.limitations"),
  };
}

function redFlagCard(candidate: RedFlagBenchmarkCandidate, limitations: string[]): ModelCard {
  const labels: Record<ModelId, string> = {
    "triage-lr-v1": "Модель предварительной гипотезы и маршрутизации",
    "redflags-rules-baseline-v1": "Красные флаги: правила до усиления",
    "redflags-rules-v1": "Красные флаги: усиленные правила",
    "redflags-qwen2.5-7b-v1": "Красные флаги: Qwen 2.5 7B",
    "redflags-qwen2.5-14b-v1": "Красные флаги: Qwen 2.5 14B",
    "redflags-jev-1.13": "Красные флаги: Jev 1.13",
    "d1-wait-time-v0": "D1: срок до госпитализации",
    "b3-referral-refusal-v0": "B3: риск зафиксированного отказа",
    "d2-laboratory-load-v0": "D2: нагрузка лабораторий",
  };
  const active = candidate.modelId === "redflags-rules-v1";
  const unavailable = candidate.availability === "unavailable";
  return {
    id: candidate.modelId,
    taskId: "redflags",
    title: labels[candidate.modelId],
    kind: candidate.modelId.includes("rules") ? "deterministic_rules" : "benchmark_candidate",
    availability: active ? "runtime" : candidate.availability,
    runtimeActivation: active ? "active" : unavailable ? "blocked" : "research_only",
    researchOnly: !active,
    metricStatus: unavailable ? "unavailable" : "measured",
    primaryMetric: metric(
      "recall",
      candidate.metrics?.recall ?? null,
      "fraction",
      unavailable ? "unavailable" : "measured",
      { reason: candidate.unavailableReason, rows: candidate.metrics ? candidate.itemCount : null },
    ),
    baseline: null,
    limitations: [...limitations, ...(candidate.unavailableReason ? [candidate.unavailableReason] : [])],
    detailPath: `/api/models/${candidate.modelId}`,
  };
}

function triageCard(sourceValue: unknown): ModelCard {
  const source = object(sourceValue, "triage");
  if (source.schema_version !== 1 || source.model_version !== "lr-v1") throw new Error("invalid triage evidence version");
  const metrics = object(source.metrics, "triage.metrics");
  const status = object(object(source.metric_status, "triage.metric_status").pathology_top1, "triage.metric_status.pathology_top1");
  return {
    id: "triage-lr-v1",
    taskId: "A",
    title: "Модель предварительной гипотезы и маршрутизации",
    kind: "runtime_classifier",
    availability: "runtime",
    runtimeActivation: "active",
    researchOnly: false,
    metricStatus: "measured",
    primaryMetric: metric("pathology_top1", nullableFinite(metrics.pathology_top1, "metrics.pathology_top1"), "fraction", "measured", {
      numerator: integer(status.numerator, "metric_status.pathology_top1.numerator"),
      denominator: integer(status.denominator, "metric_status.pathology_top1.denominator"),
      rows: integer(status.denominator, "metric_status.pathology_top1.denominator"),
    }),
    baseline: null,
    limitations: strings(source.caveats, "triage.caveats"),
    detailPath: "/api/models/triage-lr-v1",
  };
}

function waitTimeCard(sourceValue: unknown): ModelCard {
  const source = object(sourceValue, "waitTime");
  if (source.schema_version !== 1 || source.task !== "D1_wait_time_research_benchmark") throw new Error("invalid D1 evidence version");
  const test = object(source.test, "waitTime.test");
  const model = object(test.model, "waitTime.test.model");
  const baseline = object(test.hierarchical_median_baseline, "waitTime.test.hierarchical_median_baseline");
  const split = object(object(source.split, "waitTime.split").test, "waitTime.split.test");
  return {
    id: "d1-wait-time-v0",
    taskId: "D1",
    title: "D1: срок до госпитализации",
    kind: "research_model",
    availability: "measured",
    runtimeActivation: "research_only",
    researchOnly: true,
    metricStatus: "measured",
    primaryMetric: metric("mae_days", finite(model.mae_days, "test.model.mae_days"), "days", "measured", {
      period: text(split.period, "split.test.period"), rows: integer(model.rows, "test.model.rows"),
    }),
    baseline: metric("hierarchical_median_mae_days", finite(baseline.mae_days, "baseline.mae_days"), "days", "measured", {
      period: text(split.period, "split.test.period"), rows: integer(baseline.rows, "baseline.rows"),
    }),
    limitations: strings(source.limitations, "waitTime.limitations"),
    detailPath: "/api/models/d1-wait-time-v0",
  };
}

function refusalCard(sourceValue: unknown): ModelCard {
  const source = object(sourceValue, "refusal");
  if (source.schema_version !== 1 || source.task !== "B3_referral_refusal_offline_benchmark") throw new Error("invalid B3 evidence version");
  const test = object(source.test, "refusal.test");
  const model = object(object(test.one_hot_logistic_regression, "refusal.test.one_hot_logistic_regression").metrics, "refusal.test.model.metrics");
  const baseline = object(object(test.smoothed_pair_baseline, "refusal.test.smoothed_pair_baseline").metrics, "refusal.test.baseline.metrics");
  const split = object(object(source.split, "refusal.split").test, "refusal.split.test");
  return {
    id: "b3-referral-refusal-v0",
    taskId: "B3",
    title: "B3: риск зафиксированного отказа",
    kind: "research_model",
    availability: "runtime",
    runtimeActivation: "research_only",
    researchOnly: true,
    metricStatus: "measured",
    primaryMetric: metric("pr_auc", finite(model.pr_auc, "test.model.pr_auc"), "fraction", "measured", {
      period: text(split.period, "split.test.period"), rows: integer(model.rows, "test.model.rows"),
    }),
    baseline: metric("smoothed_pair_pr_auc", finite(baseline.pr_auc, "test.baseline.pr_auc"), "fraction", "measured", {
      period: text(split.period, "split.test.period"), rows: integer(baseline.rows, "test.baseline.rows"),
    }),
    limitations: strings(source.limitations, "refusal.limitations"),
    detailPath: "/api/models/b3-referral-refusal-v0",
  };
}

function labLoadCard(sourceValue: unknown): ModelCard {
  const source = object(sourceValue, "labLoad");
  if (source.schema_version !== 1 || source.task !== "D2_laboratory_load_forecast") throw new Error("invalid D2 evidence version");
  const benchmark = object(source.temporal_benchmark, "labLoad.temporal_benchmark");
  const target = object(source.target, "labLoad.target");
  return {
    id: "d2-laboratory-load-v0",
    taskId: "D2",
    title: "D2: нагрузка лабораторий",
    kind: "blocked_forecast",
    availability: "unavailable",
    runtimeActivation: "blocked",
    researchOnly: true,
    metricStatus: "unavailable",
    primaryMetric: metric("mae", null, "units", "unavailable", {
      reason: text(benchmark.blocker, "temporal_benchmark.blocker"),
    }),
    baseline: null,
    limitations: [text(target.proxy_rejection, "target.proxy_rejection")],
    detailPath: "/api/models/d2-laboratory-load-v0",
  };
}

function buildCatalog(values: ModelEvidence): ModelCard[] {
  const benchmark = buildRedFlagBenchmark(values.redFlags);
  return [
    triageCard(values.triage),
    ...benchmark.candidates.map((candidate) => redFlagCard(candidate, benchmark.limitations)),
    waitTimeCard(values.waitTime),
    refusalCard(values.refusal),
    labLoadCard(values.labLoad),
  ];
}

function metricState(value: unknown): MetricState {
  const state = text(value, "metric.state");
  if (state === "measured") return state;
  if (state === "UNVALIDATED") return "unvalidated";
  if (state === "not_run") return state;
  throw new Error("invalid metric state");
}

function triageDetail(card: ModelCard, sourceValue: unknown): ModelDetail {
  const source = object(sourceValue, "triage");
  const values = object(source.metrics, "triage.metrics");
  const statuses = object(source.metric_status, "triage.metric_status");
  const provenance = object(source.provenance, "triage.provenance");
  const artifact = loadArtifact();
  const metrics = Object.keys(values).sort().map((name) => {
    const status = object(statuses[name], `metric_status.${name}`);
    const state = metricState(status.state);
    const value = nullableFinite(values[name], `metrics.${name}`);
    if ((state === "not_run") !== (value === null)) throw new Error(`metric state and value disagree: ${name}`);
    return metric(name, value, "fraction", state, {
      reason: status.reason === undefined ? null : nullableText(status.reason, `metric_status.${name}.reason`),
      numerator: status.numerator === undefined ? null : integer(status.numerator, `metric_status.${name}.numerator`),
      denominator: status.denominator === undefined ? null : integer(status.denominator, `metric_status.${name}.denominator`),
      rows: status.denominator === undefined ? null : integer(status.denominator, `metric_status.${name}.denominator`),
    });
  });
  const modelProvenance = object(provenance.model, "triage.provenance.model");
  const casesProvenance = object(provenance.cases, "triage.provenance.cases");
  return {
    ...card,
    source: {
      artifacts: [
        { path: "models/triage-lr-v1.json", sha256: text(modelProvenance.sha256, "provenance.model.sha256") },
        { path: "eval/report.json", sha256: null },
        { path: "eval/cases.jsonl", sha256: text(casesProvenance.sha256, "provenance.cases.sha256") },
      ],
      dataset: { name: artifact.dataset_name, period: null, rows: artifact.n_train_rows, licenseStatus: artifact.license },
    },
    evaluation: {
      design: text(source.mode, "triage.mode"),
      split: null,
      sampleSize: integer(object(source.n, "triage.n").total, "triage.n.total"),
      metrics,
      baselines: [],
      slices: null,
      caveats: strings(source.caveats, "triage.caveats"),
    },
    configuration: {
      schemaVersion: artifact.schema_version,
      modelVersion: artifact.model_version,
      trainedAt: artifact.trained_at,
      featureCount: artifact.feature_order.length,
      classCount: artifact.class_order.length,
      nTrainRows: artifact.n_train_rows,
      abstainThreshold: artifact.abstain_threshold,
      trainingDiagnostics: {
        state: "training_only",
        top1: artifact.train_metrics.top1,
        top3: artifact.train_metrics.top3,
        nTest: artifact.train_metrics.n_test,
      },
    },
    unavailable: null,
  };
}

function measures(values: Record<string, unknown>, period: string | null, rows: number | null): ModelMetric[] {
  return Object.keys(values).filter((name) => typeof values[name] === "number").sort().map((name) =>
    metric(name, finite(values[name], name), name.includes("days") ? "days" : "fraction", "measured", { period, rows }));
}

function redFlagDetail(card: ModelCard, benchmark: RedFlagBenchmark): ModelDetail {
  const candidate = benchmark.candidates.find((entry) => entry.modelId === card.id);
  if (!candidate) throw new Error("candidate missing");
  const metrics = candidate.metrics
    ? Object.entries(candidate.metrics).map(([name, value]) => metric(name, value, name.startsWith("t") || ["fp", "fn"].includes(name) ? "count" : "fraction", "measured", { rows: candidate.itemCount }))
    : [metric("recall", null, "fraction", "unavailable", { reason: candidate.unavailableReason })];
  return {
    ...card,
    source: {
      artifacts: [{ path: "reports/redflags/redflags-benchmark-v1.json", sha256: null }],
      dataset: { name: "Synthetic RU/KK emergency regression corpus", period: null, rows: benchmark.corpus.itemCount, licenseStatus: null },
    },
    evaluation: {
      design: benchmark.title,
      split: { ...benchmark.evaluationDesign },
      sampleSize: candidate.metrics ? candidate.itemCount : null,
      metrics,
      baselines: [],
      slices: candidate.slices,
      caveats: [...benchmark.limitations, ...(candidate.unavailableReason ? [candidate.unavailableReason] : [])],
    },
    configuration: {
      implementation: candidate.implementation,
      latency: candidate.latency,
      cost: candidate.cost,
      structuredOutput: candidate.structuredOutput,
    },
    unavailable: candidate.availability === "unavailable" ? {
      code: "CREDENTIALS_OR_PROVIDER_UNAVAILABLE",
      reason: candidate.unavailableReason ?? "Candidate was not measured.",
      requiredInputs: ["configured Convex deployment", "short-lived AI Gateway token", "paid AI Gateway access"],
    } : null,
  };
}

function waitTimeDetail(card: ModelCard, sourceValue: unknown): ModelDetail {
  const source = object(sourceValue, "waitTime");
  const sourceInfo = object(source.source, "waitTime.source");
  const period = object(sourceInfo.period, "waitTime.source.period");
  const split = projectSplit(source.split, "waitTime.split");
  const test = object(source.test, "waitTime.test");
  const model = object(test.model, "waitTime.test.model");
  const testPeriod = text(object(object(source.split, "waitTime.split").test, "waitTime.split.test").period, "split.test.period");
  return {
    ...card,
    source: {
      artifacts: [{ path: "reports/wait-time-baseline-v0.json", sha256: null }],
      dataset: {
        name: "Ashyq Data planned hospitalization referrals",
        period: { from: text(period.registration_min, "source.period.registration_min"), to: text(period.registration_max, "source.period.registration_max") },
        rows: integer(sourceInfo.rows, "source.rows"),
        licenseStatus: text(sourceInfo.license_status, "source.license_status"),
      },
    },
    evaluation: {
      design: "calendar_months",
      split,
      sampleSize: integer(model.rows, "test.model.rows"),
      metrics: measures(model, testPeriod, integer(model.rows, "test.model.rows")),
      baselines: ["hierarchical_median_baseline", "global_median_baseline"].map((name) => {
        const values = object(test[name], `test.${name}`);
        return { name, metrics: measures(values, testPeriod, integer(values.rows, `${name}.rows`)) };
      }),
      slices: null,
      caveats: strings(source.limitations, "waitTime.limitations"),
    },
    configuration: {
      selectedModel: (() => {
        const selected = object(object(source.selection, "waitTime.selection").selected_model, "selection.selected_model");
        return {
          family: text(selected.family, "selected_model.family"),
          loss: text(selected.loss, "selected_model.loss"),
          maxLeafNodes: integer(selected.max_leaf_nodes, "selected_model.max_leaf_nodes"),
        };
      })(),
    },
    unavailable: null,
  };
}

function refusalDetail(card: ModelCard, sourceValue: unknown): ModelDetail {
  const source = object(sourceValue, "refusal");
  const sourceInfo = object(source.source, "refusal.source");
  const period = object(sourceInfo.period, "refusal.source.period");
  const test = object(source.test, "refusal.test");
  const model = object(object(test.one_hot_logistic_regression, "test.one_hot_logistic_regression").metrics, "test.model.metrics");
  const testPeriod = text(object(object(source.split, "refusal.split").test, "refusal.split.test").period, "split.test.period");
  const baselineNames = ["smoothed_pair_baseline", "constant_baseline"];
  return {
    ...card,
    source: {
      artifacts: [
        { path: "reports/referral-refusal-baseline-v0.json", sha256: null },
        { path: "models/referral-risk-v1.json", sha256: "c52267ac918981ec1ef7458c57eede369b66cde2a7de69142d9d14f8770c6bed" },
      ],
      dataset: {
        name: "Ashyq Data planned hospitalization referrals",
        period: { from: text(period.registration_min, "source.period.registration_min"), to: text(period.registration_max, "source.period.registration_max") },
        rows: integer(sourceInfo.rows, "source.rows"),
        licenseStatus: text(sourceInfo.license_status, "source.license_status"),
      },
    },
    evaluation: {
      design: "calendar_months",
      split: projectSplit(source.split, "refusal.split"),
      sampleSize: integer(model.rows, "test.model.rows"),
      metrics: measures(model, testPeriod, integer(model.rows, "test.model.rows")),
      baselines: baselineNames.map((name) => {
        const values = object(object(test[name], `test.${name}`).metrics, `test.${name}.metrics`);
        return { name, metrics: measures(values, testPeriod, integer(values.rows, `${name}.rows`)) };
      }),
      slices: { cohort: projectRefusalCohort(source.cohort) },
      caveats: strings(source.limitations, "refusal.limitations"),
    },
    configuration: {
      selectedCandidate: text(object(source.decision, "refusal.decision").selected_candidate, "decision.selected_candidate"),
      target: (() => {
        const target = object(source.target, "refusal.target");
        return {
          field: text(target.field, "target.field"),
          definition: text(target.definition, "target.definition"),
          predictionTime: text(target.prediction_time, "target.prediction_time"),
          evaluationPopulation: text(target.evaluation_population, "target.evaluation_population"),
          positiveRows: integer(target.positive_rows, "target.positive_rows"),
          negativeRows: integer(target.negative_rows, "target.negative_rows"),
        };
      })(),
    },
    unavailable: null,
  };
}

function labLoadDetail(card: ModelCard, sourceValue: unknown): ModelDetail {
  const source = object(sourceValue, "labLoad");
  const sourceInfo = object(source.source, "labLoad.source");
  const benchmark = object(source.temporal_benchmark, "labLoad.temporal_benchmark");
  const heldOut = object(benchmark.held_out_metrics, "temporal_benchmark.held_out_metrics");
  const lag = object(source.referral_flow_lag, "labLoad.referral_flow_lag");
  const reason = text(benchmark.blocker, "temporal_benchmark.blocker");
  const metrics = ["mae", "rmse", "peak_recall"].map((name) =>
    metric(name, nullableFinite(heldOut[name], `held_out_metrics.${name}`), name === "peak_recall" ? "fraction" : "units", "unavailable", { reason }));
  metrics.push(metric("referral_flow_correlation", nullableFinite(lag.correlation, "referral_flow_lag.correlation"), "correlation", "unavailable", { reason }));
  const months = strings(sourceInfo.calendar_months, "source.calendar_months");
  return {
    ...card,
    source: {
      artifacts: [{ path: "reports/lab-load-v1.json", sha256: null }],
      dataset: {
        name: "Ashyq Data referral flow only",
        period: { from: months[0], to: months.at(-1) ?? months[0] },
        rows: integer(sourceInfo.referral_rows, "source.referral_rows"),
        licenseStatus: text(sourceInfo.license_status, "source.license_status"),
      },
    },
    evaluation: {
      design: "not_executed_missing_observed_laboratory_target",
      split: null,
      sampleSize: null,
      metrics,
      baselines: [],
      slices: null,
      caveats: strings(lag.limitations, "referral_flow_lag.limitations"),
    },
    configuration: {
      target: (() => {
        const target = object(source.target, "labLoad.target");
        return {
          available: boolean(target.available, "target.available"),
          definition: text(target.definition, "target.definition"),
          missingGroups: strings(target.missing_groups, "target.missing_groups"),
          proxyAllowed: boolean(target.proxy_allowed, "target.proxy_allowed"),
          proxyRejection: text(target.proxy_rejection, "target.proxy_rejection"),
        };
      })(),
      futureMetricContract: (() => {
        const contract = object(benchmark.future_metric_contract, "temporal_benchmark.future_metric_contract");
        return {
          mae: text(contract.mae, "future_metric_contract.mae"),
          rmse: text(contract.rmse, "future_metric_contract.rmse"),
          peakRecall: text(contract.peak_recall, "future_metric_contract.peak_recall"),
          peakDefinition: text(contract.peak_definition, "future_metric_contract.peak_definition"),
        };
      })(),
      nextDataGate: (() => {
        const gate = object(source.next_data_gate, "labLoad.next_data_gate");
        return {
          requiredFields: strings(gate.required_fields, "next_data_gate.required_fields"),
          minimumHistory: text(gate.minimum_history, "next_data_gate.minimum_history"),
          preferredHistory: text(gate.preferred_history, "next_data_gate.preferred_history"),
          acceptance: strings(gate.acceptance, "next_data_gate.acceptance"),
        };
      })(),
    },
    unavailable: {
      code: "MISSING_LABORATORY_DEMAND_TARGET",
      reason,
      requiredInputs: strings(object(source.next_data_gate, "labLoad.next_data_gate").required_fields, "next_data_gate.required_fields"),
    },
  };
}

function buildDetail(id: ModelId, values: ModelEvidence): ModelDetail {
  const benchmark = () => buildRedFlagBenchmark(values.redFlags);
  if (id === "triage-lr-v1") return triageDetail(triageCard(values.triage), values.triage);
  if (id.startsWith("redflags-")) {
    const report = benchmark();
    const candidate = report.candidates.find((entry) => entry.modelId === id);
    if (!candidate) throw new Error("candidate missing");
    return redFlagDetail(redFlagCard(candidate, report.limitations), report);
  }
  if (id === "d1-wait-time-v0") return waitTimeDetail(waitTimeCard(values.waitTime), values.waitTime);
  if (id === "b3-referral-refusal-v0") return refusalDetail(refusalCard(values.refusal), values.refusal);
  return labLoadDetail(labLoadCard(values.labLoad), values.labLoad);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: NO_STORE });
}

async function boundary(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (isWorkspaceAuthError(error)) {
      const messages: Record<string, string> = {
        UNAUTHORIZED: "Требуется вход",
        WORKSPACE_UNAVAILABLE: "Рабочее пространство недоступно",
        NOT_FOUND: "Модель не найдена",
      };
      return json({ code: error.code, error: messages[error.code] ?? "Нет доступа" }, error.status);
    }
    return json({ code: "MODEL_EVIDENCE_UNAVAILABLE", error: "Данные моделей недоступны" }, 503);
  }
}

async function authorize(req: Request, deps: ModelApiDeps): Promise<void> {
  await (deps.actor ?? requireWorkspaceActor)(req);
}

export function handleModelCatalog(req: Request, deps: ModelApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    await authorize(req, deps);
    return json({ schemaVersion: 1, models: buildCatalog(evidence(deps)) });
  });
}

export function handleModelBenchmarks(req: Request, deps: ModelApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    await authorize(req, deps);
    return json({ schemaVersion: 1, benchmark: buildRedFlagBenchmark(evidence(deps).redFlags) });
  });
}

export function handleModelDetail(req: Request, id: string, deps: ModelApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    await authorize(req, deps);
    if (!MODEL_ID_SET.has(id)) throw new WorkspaceAuthError(404, "NOT_FOUND");
    return json({ schemaVersion: 1, model: buildDetail(id as ModelId, evidence(deps)) });
  });
}
