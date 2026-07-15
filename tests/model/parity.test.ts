import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildVector, loadArtifact, predict } from "../../lib/model";
import type { EvidenceVector } from "../../lib/types";

const FIXTURE_PATH = "tests/fixtures/parity.golden.jsonl";
const VECTOR_TOLERANCE = 1e-7;
const LOGIT_TOLERANCE = 1e-7;
const PROBABILITY_TOLERANCE = 1e-9;

interface Manifest {
  readonly kind: "manifest";
  readonly schema_version: 1;
  readonly split: "decontaminated_test";
  readonly selection: {
    readonly count: number;
    readonly seed: number;
  };
  readonly coverage: {
    readonly class_count: number;
    readonly ground_truth: readonly string[];
    readonly argmax: readonly string[];
    readonly sex: readonly string[];
    readonly evidence_types: readonly string[];
  };
  readonly source: {
    readonly path: string;
    readonly sha256: string;
    readonly decontaminated_rows: number;
  };
  readonly artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly model_version: string;
  };
  readonly dictionary: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly feature_spec: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly feature_order: readonly string[];
  readonly class_order: readonly string[];
}

interface ParityCase {
  readonly kind: "case";
  readonly id: string;
  readonly provenance: {
    readonly split: "decontaminated_test";
    readonly test_index: number;
    readonly row_digest: string;
    readonly selection_seed: number;
    readonly ground_truth: string;
    readonly ground_truth_index: number;
  };
  readonly evidence_vector: EvidenceVector;
  readonly expected: {
    readonly vector: readonly number[];
    readonly logits: readonly number[];
    readonly probabilities: readonly number[];
    readonly argmax: string;
    readonly top3: readonly string[];
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertManifestCurrent(
  candidate: Manifest,
  currentArtifact: ReturnType<typeof loadArtifact>,
): void {
  const guards = [
    ["raw split", candidate.source.path, candidate.source.sha256],
    ["artifact", candidate.artifact.path, candidate.artifact.sha256],
    ["dictionary", candidate.dictionary.path, candidate.dictionary.sha256],
    ["feature_spec", candidate.feature_spec.path, candidate.feature_spec.sha256],
  ] as const;
  for (const [name, path, expected] of guards) {
    if (sha256(path) !== expected) {
      throw new Error(`stale parity ${name}`);
    }
  }
  if (JSON.stringify(candidate.feature_order) !== JSON.stringify(currentArtifact.feature_order)) {
    throw new Error("stale parity feature_order");
  }
  if (JSON.stringify(candidate.class_order) !== JSON.stringify(currentArtifact.class_order)) {
    throw new Error("stale parity class_order");
  }
}

function maxDelta(left: ArrayLike<number>, right: ArrayLike<number>): number {
  expect(left.length).toBe(right.length);
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  }
  return maximum;
}

function scoreFull(
  vector: Float64Array,
  artifact: ReturnType<typeof loadArtifact>,
): { readonly logits: number[]; readonly probabilities: number[] } {
  const logits = artifact.weights.map((weights, classIndex) => {
    let value = artifact.bias[classIndex];
    for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
      value += weights[featureIndex] * vector[featureIndex];
    }
    return value;
  });
  const maximum = Math.max(...logits);
  const exponentials = logits.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return {
    logits,
    probabilities: exponentials.map((value) => value / total),
  };
}

const [manifestLine, ...caseLines] = readFileSync(FIXTURE_PATH, "utf8")
  .trim()
  .split("\n");
const manifest = JSON.parse(manifestLine) as Manifest;
const cases = caseLines.map((line) => JSON.parse(line) as ParityCase);
const artifact = loadArtifact();

describe("Python train-time -> TypeScript serve-time parity STOP gate", () => {
  it("fails loudly on stale artifacts and records exact held-out coverage", () => {
    assertManifestCurrent(manifest, artifact);
    expect(manifest.kind).toBe("manifest");
    expect(manifest.schema_version).toBe(1);
    expect(manifest.split).toBe("decontaminated_test");
    expect(cases).toHaveLength(manifest.selection.count);
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(manifest.coverage.class_count).toBe(artifact.class_order.length);
    expect([...manifest.feature_order]).toEqual(artifact.feature_order);
    expect([...manifest.class_order]).toEqual(artifact.class_order);
    expect(manifest.coverage.ground_truth).toEqual([...artifact.class_order].sort());
    expect(manifest.coverage.argmax).toEqual([...artifact.class_order].sort());
    expect(manifest.coverage.sex).toEqual(["f", "m"]);
    expect(manifest.coverage.evidence_types).toEqual(expect.arrayContaining(["B", "C", "M"]));
    expect(manifest.source.decontaminated_rows).toBeGreaterThan(cases.length);
    expect(manifest.artifact.model_version).toBe(artifact.model_version);
    expect(new Set(cases.map((row) => row.provenance.test_index)).size).toBe(cases.length);
    expect(cases.every((row) => row.provenance.selection_seed === manifest.selection.seed)).toBe(
      true,
    );
    expect(cases.every((row) => /^[0-9a-f]{32}$/u.test(row.provenance.row_digest))).toBe(true);
    expect(
      cases.every(
        (row) =>
          artifact.class_order[row.provenance.ground_truth_index] ===
          row.provenance.ground_truth,
      ),
    ).toBe(true);
    expect(cases.every((row) => row.expected.vector.length === artifact.feature_order.length)).toBe(
      true,
    );
    expect(cases.every((row) => row.expected.logits.length === artifact.class_order.length)).toBe(
      true,
    );
    expect(
      cases.every((row) => row.expected.probabilities.length === artifact.class_order.length),
    ).toBe(true);
    expect(
      cases.every(
        (row) =>
          Math.abs(row.expected.probabilities.reduce((sum, value) => sum + value, 0) - 1) <=
          1e-12,
      ),
    ).toBe(true);
  });

  it("turns red for an intentionally corrupted source hash or feature order", () => {
    const corruptedHash: Manifest = {
      ...manifest,
      source: { ...manifest.source, sha256: "0".repeat(64) },
    };
    const reordered = [...manifest.feature_order];
    [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
    const corruptedOrder: Manifest = { ...manifest, feature_order: reordered };

    expect(() => assertManifestCurrent(corruptedHash, artifact)).toThrow(/raw split/);
    expect(() => assertManifestCurrent(corruptedOrder, artifact)).toThrow(/feature_order/);
  });

  it("has zero aggregate argmax/top-3 mismatches and reports numeric deltas", () => {
    let argmaxMismatches = 0;
    let orderedTop3Mismatches = 0;
    let top3SetMismatches = 0;
    let maxVectorDelta = 0;
    let maxLogitDelta = 0;
    let maxProbabilityDelta = 0;
    let maxPredictProbabilityDelta = 0;

    for (const row of cases) {
      const vector = buildVector(row.evidence_vector, artifact);
      const scored = scoreFull(vector, artifact);
      const prediction = predict(vector, artifact);
      const actualTop3 = prediction.pathologies.slice(0, 3).map(({ code }) => code);
      if (actualTop3[0] !== row.expected.argmax) argmaxMismatches += 1;
      if (JSON.stringify(actualTop3) !== JSON.stringify(row.expected.top3)) {
        orderedTop3Mismatches += 1;
      }
      if (
        JSON.stringify([...actualTop3].sort()) !==
        JSON.stringify([...row.expected.top3].sort())
      ) {
        top3SetMismatches += 1;
      }
      maxVectorDelta = Math.max(maxVectorDelta, maxDelta(vector, row.expected.vector));
      maxLogitDelta = Math.max(maxLogitDelta, maxDelta(scored.logits, row.expected.logits));
      maxProbabilityDelta = Math.max(
        maxProbabilityDelta,
        maxDelta(scored.probabilities, row.expected.probabilities),
      );
      for (const pathology of prediction.pathologies) {
        const classIndex = artifact.class_order.indexOf(pathology.code);
        maxPredictProbabilityDelta = Math.max(
          maxPredictProbabilityDelta,
          Math.abs(pathology.prob - row.expected.probabilities[classIndex]),
        );
      }
    }

    console.info(
      `PARITY SUMMARY rows=${cases.length} argmax=${argmaxMismatches} ` +
        `ordered_top3=${orderedTop3Mismatches} set_top3=${top3SetMismatches} ` +
        `max_vector_delta=${maxVectorDelta} max_logit_delta=${maxLogitDelta} ` +
        `max_probability_delta=${maxProbabilityDelta} ` +
        `max_predict_probability_delta=${maxPredictProbabilityDelta}`,
    );
    expect(argmaxMismatches).toBe(0);
    expect(orderedTop3Mismatches).toBe(0);
    expect(top3SetMismatches).toBe(0);
    expect(maxVectorDelta).toBeLessThanOrEqual(VECTOR_TOLERANCE);
    expect(maxLogitDelta).toBeLessThanOrEqual(LOGIT_TOLERANCE);
    expect(maxProbabilityDelta).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
    expect(maxPredictProbabilityDelta).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
  });

  it.each(cases)("$id: vector, logits, probabilities, argmax, and ordered top3", (row) => {
    const vector = buildVector(row.evidence_vector, artifact);
    const scored = scoreFull(vector, artifact);
    const prediction = predict(vector, artifact);

    expect(
      maxDelta(vector, row.expected.vector),
      `${row.id}: Python train-time vector differs from TS buildVector`,
    ).toBeLessThanOrEqual(VECTOR_TOLERANCE);
    expect(
      maxDelta(scored.logits, row.expected.logits),
      `${row.id}: logits differ`,
    ).toBeLessThanOrEqual(LOGIT_TOLERANCE);
    expect(
      maxDelta(scored.probabilities, row.expected.probabilities),
      `${row.id}: probabilities differ`,
    ).toBeLessThanOrEqual(PROBABILITY_TOLERANCE);
    expect(prediction.pathologies[0].code).toBe(row.expected.argmax);
    expect(prediction.pathologies.slice(0, 3).map(({ code }) => code)).toEqual(
      row.expected.top3,
    );
    expect(prediction.model_version).toBe(artifact.model_version);
    expect(prediction.abstained).toBe(false);
  });
});
