import { describe, expect, it } from "vitest";
import {
  MODEL_IDS,
  handleModelBenchmarks,
  handleModelCatalog,
  handleModelDetail,
  type ModelApiDeps,
} from "../../lib/model-api";
import { WorkspaceAuthError, type WorkspaceActor } from "../../lib/workspace-auth";

const BASE = "https://workspace.example.test";
const roles = ["owner", "doctor", "analyst"] as const;

function request(path = "/api/models"): Request {
  return new Request(`${BASE}${path}`);
}

function actor(role: WorkspaceActor["role"] = "doctor"): WorkspaceActor {
  return { id: `${role}-test`, displayName: `Test ${role}`, role, organizationId: "clinic-a" };
}

function deps(role: WorkspaceActor["role"] = "doctor"): ModelApiDeps {
  return { actor: async () => actor(role) };
}

function unauthorized(): ModelApiDeps {
  return { actor: async () => { throw new WorkspaceAuthError(401, "UNAUTHORIZED"); } };
}

function collectKeys(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, result);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      result.add(key);
      collectKeys(child, result);
    }
  }
  return result;
}

describe("model API catalog", () => {
  it("catalog exposes every stable runtime and research id with an explicit lifecycle", async () => {
    const response = await handleModelCatalog(request(), deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload.schemaVersion).toBe(1);
    expect(payload.models.map((model: { id: string }) => model.id)).toEqual(MODEL_IDS);
    expect(new Set(payload.models.map((model: { id: string }) => model.id)).size).toBe(MODEL_IDS.length);
    for (const model of payload.models) {
      expect(["runtime", "measured", "unavailable"]).toContain(model.availability);
      expect(["active", "research_only", "blocked"]).toContain(model.runtimeActivation);
      expect(typeof model.researchOnly).toBe("boolean");
      expect(model.detailPath).toBe(`/api/models/${model.id}`);
    }
    expect(payload.models.find((model: { id: string }) => model.id === "triage-lr-v1")).toMatchObject({
      taskId: "A", kind: "runtime_classifier", availability: "runtime", runtimeActivation: "active",
      primaryMetric: { name: "pathology_top1", value: 1, state: "measured", rows: 40 },
    });
    expect(payload.models.find((model: { id: string }) => model.id === "redflags-rules-v1")).toMatchObject({
      availability: "runtime", runtimeActivation: "active", primaryMetric: { name: "recall", value: 1, rows: 160 },
    });
    expect(payload.models.find((model: { id: string }) => model.id === "d1-wait-time-v0")).toMatchObject({
      primaryMetric: { name: "mae_days", value: 3.576797, period: "2025-03", rows: 191573 },
      baseline: { name: "hierarchical_median_mae_days", value: 3.620706 },
    });
    expect(payload.models.find((model: { id: string }) => model.id === "b3-referral-refusal-v0")).toMatchObject({
      primaryMetric: { name: "pr_auc", value: 0.34820996, period: "2025-03", rows: 223353 },
      baseline: { name: "smoothed_pair_pr_auc", value: 0.31268672 },
    });
  });

  it("catalog reports measured Jev and preserves blocked D2 metrics as null instead of zero", async () => {
    const { models } = await (await handleModelCatalog(request(), deps())).json();
    expect(models.find((entry: { id: string }) => entry.id === "redflags-jev-1.13")).toMatchObject({
      availability: "measured", runtimeActivation: "research_only", metricStatus: "measured",
      primaryMetric: { name: "recall", value: 0.9875, rows: 160, reason: null },
    });
    const d2 = models.find((entry: { id: string }) => entry.id === "d2-laboratory-load-v0");
    expect(d2).toMatchObject({ availability: "unavailable", runtimeActivation: "blocked", metricStatus: "unavailable" });
    expect(d2.primaryMetric.value).toBeNull();
    expect(d2.primaryMetric.reason).toEqual(expect.any(String));
    expect(d2.primaryMetric.reason.length).toBeGreaterThan(0);
  });
});

describe("model API detail", () => {
  it("detail returns exact curated evidence for a known research item", async () => {
    const response = await handleModelDetail(request("/api/models/d1-wait-time-v0"), "d1-wait-time-v0", deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { model } = await response.json();
    expect(model.source).toEqual({
      artifacts: [{ path: "reports/wait-time-baseline-v0.json", sha256: null }],
      dataset: {
        name: "Ashyq Data planned hospitalization referrals",
        period: { from: "2025-01-01", to: "2025-03-31" },
        rows: 767130,
        licenseStatus: "not_verified",
      },
    });
    expect(model.evaluation.sampleSize).toBe(191573);
    expect(model.evaluation.metrics).toContainEqual(expect.objectContaining({ name: "mae_days", value: 3.576797, unit: "days" }));
    expect(model.evaluation.baselines.find((entry: { name: string }) => entry.name === "hierarchical_median_baseline").metrics)
      .toContainEqual(expect.objectContaining({ name: "mae_days", value: 3.620706 }));
    expect(model.configuration.selectedModel).toEqual({ family: "hist_gradient_ordinal_categorical", loss: "poisson", maxLeafNodes: 63 });
    expect(model.unavailable).toBeNull();
  });

  it("detail rejects an unknown id with the stable contract error", async () => {
    const response = await handleModelDetail(request("/api/models/not-a-model"), "not-a-model", deps());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "NOT_FOUND", error: "Модель не найдена" });
  });

  it("detail returns measured Jev evidence without activating it in runtime", async () => {
    const response = await handleModelDetail(request("/api/models/redflags-jev-1.13"), "redflags-jev-1.13", deps());
    const { model } = await response.json();
    expect(model).toMatchObject({ availability: "measured", runtimeActivation: "research_only", researchOnly: true });
    expect(model.evaluation.sampleSize).toBe(160);
    expect(model.evaluation.metrics).toContainEqual(expect.objectContaining({ name: "recall", value: 0.9875, state: "measured" }));
    expect(model.configuration.latency).toMatchObject({ requestCount: 16, totalMs: 3042, meanMs: 190.125, p50Ms: 182, p95Ms: 260 });
    expect(model.configuration.cost).toMatchObject({ currency: "USD", amount: 0.001810746, inputTokens: 43113, outputTokens: 3264 });
    expect(model.configuration.implementation).toMatchObject({
      provider: "Convex", requestedModel: "typesafe/jev-1.13", observedModel: "typesafe/jev-1.13-20260917",
      threshold: 0.5, questionSpecId: "redflags-eight-trigger-v1",
    });
    expect(model.unavailable).toBeNull();
  });

  it("detail preserves unvalidated triage metrics and labels training diagnostics separately", async () => {
    const response = await handleModelDetail(request("/api/models/triage-lr-v1"), "triage-lr-v1", deps());
    const { model } = await response.json();
    expect(model.evaluation.metrics.find((entry: { name: string }) => entry.name === "urgency_accuracy")).toMatchObject({
      value: 0.975,
      state: "unvalidated",
      numerator: 39,
      denominator: 40,
      reason: expect.stringContaining("невалидированной"),
    });
    expect(model.configuration.trainingDiagnostics).toMatchObject({ state: "training_only" });
    expect(model.configuration).not.toHaveProperty("weights");
    expect(model.configuration).not.toHaveProperty("bias");
  });

  it("detail keeps the D2 blocker and every unavailable metric explicit", async () => {
    const response = await handleModelDetail(request("/api/models/d2-laboratory-load-v0"), "d2-laboratory-load-v0", deps());
    const { model } = await response.json();
    expect(model).toMatchObject({ availability: "unavailable", runtimeActivation: "blocked", researchOnly: true });
    expect(model.evaluation.sampleSize).toBeNull();
    expect(model.evaluation.metrics).toHaveLength(4);
    for (const entry of model.evaluation.metrics) {
      expect(entry).toMatchObject({ value: null, state: "unavailable", reason: "no_observed_laboratory_target" });
    }
    expect(model.unavailable).toMatchObject({
      code: "MISSING_LABORATORY_DEMAND_TARGET",
      requiredInputs: expect.arrayContaining(["event_timestamp", "examination_code"]),
    });
  });

  it("detail fails closed when its versioned evidence is malformed", async () => {
    const response = await handleModelDetail(request("/api/models/d1-wait-time-v0"), "d1-wait-time-v0", {
      ...deps(), evidence: { waitTime: { status: "looks-valid-but-is-incomplete" } },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "MODEL_EVIDENCE_UNAVAILABLE", error: "Данные моделей недоступны" });
  });
});

describe("model API benchmarks", () => {
  it("benchmarks reproduce the versioned comparison and preserve unavailable values as null", async () => {
    const response = await handleModelBenchmarks(request("/api/models/benchmarks"), deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { benchmark } = await response.json();
    expect(benchmark).toMatchObject({
      id: "redflags-ru-kk-v1",
      researchOnly: true,
      runtimeIntegration: "deterministic_rules_only",
      corpus: {
        itemCount: 160,
        languageCounts: { ru: 80, kk: 80 },
        classCounts: { positive: 80, negative: 80 },
        sha256: "bafae774a648ccde988b4804a02d0d0adce983d7d979e6fcefcf230902ac5625",
        frozenOn: "2026-09-26",
      },
      evaluationDesign: { sameFrozenSplit: true, rulesDevelopedAgainstCorpus: true, unseenGeneralizationClaim: false },
    });
    expect(benchmark.limitations.join(" ")).toMatch(/Jev.*zero-shot.*alpha.*seed/iu);
    expect(benchmark.candidates.map((entry: { modelId: string }) => entry.modelId)).toEqual(MODEL_IDS.slice(1, 6));
    expect(benchmark.candidates.find((entry: { modelId: string }) => entry.modelId === "redflags-rules-baseline-v1").metrics)
      .toEqual({ tp: 45, fp: 27, tn: 53, fn: 35, precision: 0.625, recall: 0.5625, f1: 0.5921052631578947, falsePositiveRate: 0.3375 });
    expect(benchmark.candidates.find((entry: { modelId: string }) => entry.modelId === "redflags-rules-v1").metrics)
      .toMatchObject({ tp: 80, fp: 0, tn: 80, fn: 0, precision: 1, recall: 1, f1: 1, falsePositiveRate: 0 });
    expect(benchmark.candidates.find((entry: { modelId: string }) => entry.modelId === "redflags-qwen2.5-7b-v1").metrics)
      .toMatchObject({ precision: 0.96875, recall: 0.3875, f1: 0.5535714285714286 });
    expect(benchmark.candidates.find((entry: { modelId: string }) => entry.modelId === "redflags-qwen2.5-14b-v1").metrics)
      .toMatchObject({ precision: 0.8148148148148148, recall: 0.275, f1: 0.4112149532710281 });
    const jev = benchmark.candidates.find((entry: { modelId: string }) => entry.modelId === "redflags-jev-1.13");
    expect(jev).toMatchObject({
      availability: "measured",
      implementation: {
        provider: "Convex", requestedModel: "typesafe/jev-1.13", observedModel: "typesafe/jev-1.13-20260917",
        threshold: 0.5, questionSpecId: "redflags-eight-trigger-v1",
      },
      metrics: { tp: 79, fp: 0, tn: 80, fn: 1, precision: 1, recall: 0.9875, f1: 0.9937106918238994, falsePositiveRate: 0 },
      latency: { requestCount: 16, totalMs: 3042, meanMs: 190.125, p50Ms: 182, p95Ms: 260 },
      cost: { currency: "USD", amount: 0.001810746, inputTokens: 43113, outputTokens: 3264 },
      unavailableReason: null,
    });
    expect(jev.slices["language:ru"]).toMatchObject({ tp: 39, fn: 1, recall: 0.975, f1: 0.9873417721518987 });
    expect(jev.slices["language:kk"]).toMatchObject({ tp: 40, fn: 0, recall: 1, f1: 1 });
    expect(jev.slices["trigger:consciousness"]).toMatchObject({ tp: 9, fn: 1, recall: 0.9, f1: 0.9473684210526316 });
    expect(jev.slices["trigger:suicidal"]).toMatchObject({ tp: 10, fn: 0, recall: 1, f1: 1 });
  });
});

describe("model API authentication and privacy", () => {
  it.each(roles)("authentication allows the %s role to read every aggregate model surface", async (role) => {
    const responses = await Promise.all([
      handleModelCatalog(request(), deps(role)),
      handleModelBenchmarks(request("/api/models/benchmarks"), deps(role)),
      handleModelDetail(request("/api/models/triage-lr-v1"), "triage-lr-v1", deps(role)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.every((response) => response.headers.get("cache-control") === "no-store")).toBe(true);
  });

  it("authentication runs before reading any evidence", async () => {
    const blocked = { ...unauthorized(), evidence: { redFlags: null, triage: null, waitTime: null, refusal: null, labLoad: null } };
    for (const response of await Promise.all([
      handleModelCatalog(request(), blocked),
      handleModelBenchmarks(request("/api/models/benchmarks"), blocked),
      handleModelDetail(request("/api/models/triage-lr-v1"), "triage-lr-v1", blocked),
    ])) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "UNAUTHORIZED", error: "Требуется вход" });
    }
  });

  it("authentication preserves a fail-closed workspace configuration error", async () => {
    const response = await handleModelCatalog(request(), {
      actor: async () => { throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE"); },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "WORKSPACE_UNAVAILABLE", error: "Рабочее пространство недоступно" });
  });

  it("privacy projection excludes patient-level data, secrets, weights and absolute paths", async () => {
    const payloads = await Promise.all([
      handleModelCatalog(request(), deps()).then((response) => response.json()),
      handleModelBenchmarks(request("/api/models/benchmarks"), deps()).then((response) => response.json()),
      ...MODEL_IDS.map((id) => handleModelDetail(request(`/api/models/${id}`), id, deps()).then((response) => response.json())),
    ]);
    const forbidden = new Set([
      "password", "passwordHash", "telegramChatId", "doctorToken", "patientLabel", "messages", "predictions",
      "weights", "bias", "feature_order", "class_order", "actorId", "organizationId",
    ]);
    for (const payload of payloads) {
      for (const key of collectKeys(payload)) expect(forbidden.has(key), `forbidden key ${key}`).toBe(false);
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("/home/");
      expect(serialized).not.toMatch(/sk-ant-|bot[0-9]{8,}:/u);
    }
  });
});
