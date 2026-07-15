import { describe, expect, it, vi } from "vitest";

import * as modelModule from "../../lib/model";
import {
  buildVector,
  loadArtifact,
  predict,
  type ModelArtifact,
} from "../../lib/model";

import type { EvidenceVector } from "../../lib/types";

const CLASSES = [
  "Acute COPD exacerbation / infection",
  "Acute dystonic reactions",
  "Acute laryngitis",
  "Acute otitis media",
  "Acute pulmonary edema",
  "Acute rhinosinusitis",
] as const;

type MutableArtifact = Omit<
  ModelArtifact,
  | "feature_order"
  | "class_order"
  | "weights"
  | "bias"
  | "preprocessing"
  | "train_metrics"
  | "abstain_threshold"
> & {
  feature_order: string[];
  class_order: string[];
  weights: number[][];
  bias: number[];
  preprocessing: {
    age_divisor: number;
    age_missing: number;
    sex_unknown_value: number;
  };
  abstain_threshold: number;
  train_metrics: { top1: number; top3: number; n_test: number };
};

function makeArtifact(): MutableArtifact {
  return {
    schema_version: 1,
    model_version: "unit-test-v1",
    trained_at: "2026-07-14T00:00:00.000Z",
    dataset_name: "DDXPlus",
    dataset_sha256: "a".repeat(64),
    license: "CC BY 4.0",
    n_train_rows: 42,
    feature_order: [
      "age_norm",
      "sex_m",
      "sex_f",
      "E_14",
      "E_130@V_86",
      "E_55@V_40",
      "E_181",
    ],
    class_order: [...CLASSES],
    weights: [
      [2, 0.5, 0, 2, 0.25, -1, 0],
      [0, 0, 0, 0.2, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0.2],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, -0.2, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, -0.2],
    ],
    bias: [0.1, 0, -0.1, -0.2, -0.3, -0.4],
    preprocessing: {
      age_divisor: 200,
      age_missing: 0.25,
      sex_unknown_value: 0.4,
    },
    abstain_threshold: 0.99,
    train_metrics: { top1: 0.5, top3: 0.8, n_test: 10 },
  };
}

function evidence(overrides: Partial<EvidenceVector> = {}): EvidenceVector {
  return {
    age: 100,
    sex: "m",
    evidences: [
      { code: "E_14" },
      { code: "E_130", value: "V_86" },
      { code: "E_55", value: "V_40" },
      { code: "E_181" },
    ],
    ...overrides,
  };
}

function fullSoftmaxDistribution(
  vector: Float64Array,
  artifact: ModelArtifact,
): { code: string; prob: number }[] {
  const logits = artifact.weights.map(
    (row, classIndex) =>
      artifact.bias[classIndex] +
      row.reduce((sum, weight, featureIndex) => sum + weight * vector[featureIndex], 0),
  );
  const maximum = Math.max(...logits);
  const exponentials = logits.map((logit) => Math.exp(logit - maximum));
  const denominator = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value, classIndex) => ({
    code: artifact.class_order[classIndex],
    prob: value / denominator,
  }));
}

function expectTopFiveMatchesFullDistribution(
  actual: readonly { code: string; prob: number }[],
  fullDistribution: readonly { code: string; prob: number }[],
): void {
  const expected = [...fullDistribution]
    .sort((left, right) => right.prob - left.prob)
    .slice(0, 5);
  expect(actual.map(({ code }) => code)).toEqual(expected.map(({ code }) => code));
  for (const [index, item] of actual.entries()) {
    expect(item.prob).toBeCloseTo(expected[index].prob, 14);
  }
}

describe("model artifact loading", () => {
  it("exposes only the frozen scoring API and loads the production dimensions", () => {
    expect(Object.keys(modelModule).sort()).toEqual([
      "buildVector",
      "loadArtifact",
      "predict",
    ]);

    const first = loadArtifact();
    const second = loadArtifact();
    expect(second).toBe(first);
    expect(first.class_order).toHaveLength(47);
    expect(first.feature_order).toHaveLength(975);
    expect(first.preprocessing.sex_unknown_value).toBe(0.5);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.weights)).toBe(true);
  });
});

describe("buildVector", () => {
  it("uses artifact ordering and preprocessing for binary, categorical, and multi-value keys", () => {
    const artifact = makeArtifact();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vector = buildVector(
      evidence({ evidences: [...evidence().evidences, { code: "E_999" }] }),
      artifact,
    );

    expect([...vector]).toEqual([0.5, 1, 0, 1, 1, 1, 1]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[model] evidence key is outside feature_order: E_999",
    );
    warn.mockRestore();
  });

  it("distinguishes known sex from unknown and handles missing/clamped age", () => {
    const artifact = makeArtifact();

    expect([...buildVector(evidence({ sex: "f", evidences: [] }), artifact)].slice(0, 3)).toEqual([
      0.5,
      0,
      1,
    ]);
    expect(
      [...buildVector(evidence({ sex: "unknown", evidences: [] }), artifact)].slice(0, 3),
    ).toEqual([0.5, 0.4, 0.4]);
    expect([...buildVector(evidence({ age: null, evidences: [] }), artifact)].slice(0, 3)).toEqual([
      0.25,
      1,
      0,
    ]);
    expect(buildVector(evidence({ age: -10, evidences: [] }), artifact)[0]).toBe(0);
    expect(buildVector(evidence({ age: 400, evidences: [] }), artifact)[0]).toBe(1);
    expect(buildVector(evidence({ age: Number.NaN, evidences: [] }), artifact)[0]).toBe(0.25);
  });

  it("uses the production artifact value for unknown sex without shifting known features", () => {
    const artifact = loadArtifact();
    const knownFeature = artifact.feature_order.indexOf("E_14");
    const vector = buildVector(
      evidence({ age: null, sex: "unknown", evidences: [{ code: "E_14" }] }),
      artifact,
    );

    expect(vector[artifact.feature_order.indexOf("age_norm")]).toBe(
      artifact.preprocessing.age_missing,
    );
    expect(vector[artifact.feature_order.indexOf("sex_m")]).toBe(
      artifact.preprocessing.sex_unknown_value,
    );
    expect(vector[artifact.feature_order.indexOf("sex_f")]).toBe(
      artifact.preprocessing.sex_unknown_value,
    );
    expect(vector[knownFeature]).toBe(1);
    expect([...vector].filter((value) => value !== 0)).toHaveLength(4);
  });
});

describe("predict", () => {
  it("returns deterministic top-5 pathologies and signed weight-times-value contributions", () => {
    const artifact = makeArtifact();
    const vector = buildVector(evidence(), artifact);
    const result = predict(vector, artifact);

    expect(result).toEqual(predict(vector, artifact));
    expect(result.pathologies).toHaveLength(5);
    expect(result.pathologies[0].code).toBe(CLASSES[0]);
    expect(result.pathologies.every(({ label_ru }) => label_ru.length > 0)).toBe(true);
    expect(result.pathologies.reduce((sum, item) => sum + item.prob, 0)).toBeLessThan(1);
    const expected = fullSoftmaxDistribution(vector, artifact);
    expect(expected.reduce((sum, item) => sum + item.prob, 0)).toBeCloseTo(1, 6);
    expectTopFiveMatchesFullDistribution(result.pathologies, expected);
    expect(result.abstained).toBe(false);
    expect(result).not.toHaveProperty("abstain_reason");
    expect(result.model_version).toBe("unit-test-v1");
    expect(result.top_contributions).toEqual([
      { feature: "E_14", label_ru: "боль в груди в покое", contribution: 2 },
      { feature: "age_norm", label_ru: "возраст", contribution: 1 },
      {
        feature: "E_55@V_40",
        label_ru: "локализация боли: поясничный отдел позвоночника",
        contribution: -1,
      },
      { feature: "sex_m", label_ru: "пол: мужской", contribution: 0.5 },
      {
        feature: "E_130@V_86",
        label_ru: expect.any(String),
        contribution: 0.25,
      },
    ]);
  });

  it("keeps softmax finite for extreme logits and never owns abstention", () => {
    const artifact = makeArtifact();
    artifact.bias = [1000, 0, -1000, -500, 500, 250];
    artifact.abstain_threshold = 0.999999;
    const vector = buildVector(evidence(), artifact);
    const result = predict(vector, artifact);

    expect(result.pathologies.every(({ prob }) => Number.isFinite(prob))).toBe(true);
    expect(result.pathologies[0].prob).toBeCloseTo(1, 12);
    expect(result.abstained).toBe(false);
    const expected = fullSoftmaxDistribution(vector, artifact);
    expect(expected.reduce((sum, item) => sum + item.prob, 0)).toBeCloseTo(1, 6);
    expectTopFiveMatchesFullDistribution(result.pathologies, expected);
  });

  it("scores the real artifact with mapped labels and a normalized full distribution", () => {
    const artifact = loadArtifact();
    const vector = buildVector(
      { age: 58, sex: "m", evidences: [{ code: "E_14" }, { code: "E_181" }] },
      artifact,
    );
    const result = predict(vector, artifact);

    expect(result.pathologies).toHaveLength(5);
    expect(result.pathologies.every(({ prob, label_ru }) => Number.isFinite(prob) && label_ru.length > 0)).toBe(
      true,
    );
    expect(result.top_contributions.length).toBeGreaterThan(0);
    expect(result.top_contributions.every(({ label_ru }) => label_ru.length > 0)).toBe(true);
    const expected = fullSoftmaxDistribution(vector, artifact);
    expect(expected.reduce((sum, item) => sum + item.prob, 0)).toBeCloseTo(1, 6);
    expectTopFiveMatchesFullDistribution(result.pathologies, expected);
  });
});

describe("artifact and input validation", () => {
  it("rejects duplicate features, wrong matrix width, and non-finite vectors", () => {
    const duplicate = makeArtifact();
    duplicate.feature_order = ["age_norm", "sex_m", "sex_f", "E_14", "E_14"];
    expect(() => buildVector(evidence(), duplicate)).toThrow(/unique/);

    const wrongWidth = makeArtifact();
    wrongWidth.weights[0] = [1];
    expect(() => predict(new Float64Array(7), wrongWidth)).toThrow(/width/);

    const vector = new Float64Array(7);
    vector[0] = Number.NaN;
    expect(() => predict(vector, makeArtifact())).toThrow(/finite/);
  });

  it.each([
    [
      "duplicate classes",
      (artifact: MutableArtifact) => {
        artifact.class_order[1] = artifact.class_order[0];
      },
      /unique/,
    ],
    [
      "a missing sex column",
      (artifact: MutableArtifact) => {
        artifact.feature_order = artifact.feature_order.filter((feature) => feature !== "sex_f");
        artifact.weights = artifact.weights.map((row) => row.slice(0, -1));
      },
      /sex_f/,
    ],
    [
      "a mismatched bias",
      (artifact: MutableArtifact) => {
        artifact.bias.pop();
      },
      /bias length/,
    ],
    [
      "a mismatched class matrix",
      (artifact: MutableArtifact) => {
        artifact.weights.pop();
      },
      /row count/,
    ],
    [
      "a non-finite weight",
      (artifact: MutableArtifact) => {
        artifact.weights[0][0] = Number.POSITIVE_INFINITY;
      },
      /finite/,
    ],
    [
      "invalid preprocessing",
      (artifact: MutableArtifact) => {
        artifact.preprocessing.age_divisor = 0;
      },
      /positive/,
    ],
    [
      "a missing preprocessing key",
      (artifact: MutableArtifact) => {
        delete (artifact.preprocessing as Partial<MutableArtifact["preprocessing"]>)
          .sex_unknown_value;
      },
      /preprocessing keys differ/,
    ],
    [
      "an unexpected root key",
      (artifact: MutableArtifact) => {
        (artifact as MutableArtifact & { unexpected?: boolean }).unexpected = true;
      },
      /root keys differ/,
    ],
  ] as const)("fails loudly for %s", (_name, corrupt, message) => {
    const artifact = makeArtifact();
    corrupt(artifact);
    expect(() => buildVector(evidence(), artifact)).toThrow(message);
  });

  it("rejects a scored feature without a Russian dictionary label", () => {
    const artifact = makeArtifact();
    artifact.feature_order[6] = "E_999";
    artifact.weights[0][6] = 1;
    const vector = buildVector(evidence({ evidences: [{ code: "E_999" }] }), artifact);

    expect(() => predict(vector, artifact)).toThrow(/Russian label/);
  });
});
