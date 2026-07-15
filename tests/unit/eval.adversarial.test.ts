import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildVector, loadArtifact, predict } from "../../lib/model";
import {
  parseCases,
  runEvaluation,
  validateReportForReadme,
  type EvalReport,
} from "../../scripts/eval";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicationExpectation(report: EvalReport) {
  return {
    mode: "no-llm" as const,
    casesSha256: report.provenance.cases.sha256,
    modelSha256: report.provenance.model.sha256,
    mapSha256: report.provenance.pathology_map.sha256,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("offline evaluation adversarial methodology", () => {
  it("scores the production model on every native vector without using the expected class", async () => {
    const casesText = await readFile(path.join(ROOT, "eval/cases.jsonl"), "utf8");
    const cases = parseCases(casesText);
    const ddx = cases.filter((item) => item.kind !== "redflag");
    const artifact = loadArtifact();
    const { report } = await runEvaluation();
    const reported = new Map(report.per_case.map((item) => [item.id, item]));

    expect(ddx).toHaveLength(40);
    expect(new Set(ddx.map((item) => item.provenance.identity_digest_blake2b16))).toHaveLength(40);
    for (const item of ddx) {
      expect(item.provenance).toMatchObject({ dataset: "DDXPlus", split: "decontaminated_test" });
      const vector = buildVector(
        { evidences: item.gold.evidences!, age: item.gold.age!, sex: item.gold.sex! },
        artifact,
      );
      expect(reported.get(item.id)?.predicted_pathologies).toEqual(
        predict(vector, artifact).pathologies.map((entry) => entry.code),
      );
    }
  });

  it("does not filter a deliberately wrong expected class from the denominator", async () => {
    const baseline = await runEvaluation();
    const directory = await mkdtemp(path.join(tmpdir(), "demeu-eval-adversarial-"));
    temporaryDirectories.push(directory);
    const casesPath = path.join(directory, "cases.jsonl");
    const manifestPath = path.join(directory, "manifest.json");
    const cases = parseCases(await readFile(path.join(ROOT, "eval/cases.jsonl"), "utf8"));
    const manifest = JSON.parse(
      await readFile(path.join(ROOT, "eval/manifest.json"), "utf8"),
    ) as Record<string, unknown> & { artifact: { sha256: string } };
    const target = cases.find((item) => item.kind !== "redflag")!;
    const replacement = cases.find(
      (item) => item.kind !== "redflag" && item.gold.pathology !== target.gold.pathology,
    )!;
    target.gold.pathology = replacement.gold.pathology;
    const tamperedCases = `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
    manifest.artifact.sha256 = sha256(tamperedCases);
    await Promise.all([
      writeFile(casesPath, tamperedCases),
      writeFile(manifestPath, JSON.stringify(manifest)),
    ]);

    const { report } = await runEvaluation({ casesPath, manifestPath });
    const baselinePrediction = baseline.report.per_case.find((item) => item.id === target.id);
    const tamperedPrediction = report.per_case.find((item) => item.id === target.id);

    expect(report.per_case).toHaveLength(48);
    expect(tamperedPrediction?.predicted_pathologies).toEqual(
      baselinePrediction?.predicted_pathologies,
    );
    expect(report.metric_status.pathology_top1).toMatchObject({ numerator: 39, denominator: 40 });
    expect(report.metrics.pathology_top1).toBe(39 / 40);
  });

  it("publishes abstain, coverage and under-triage context beside headline model metrics", async () => {
    const { report, markdown } = await runEvaluation();

    expect(report.metric_status.abstain_rate).toMatchObject({ numerator: 0, denominator: 40 });
    expect(report.metric_status.coverage_adjusted_top1).toMatchObject({ numerator: 40, denominator: 40 });
    expect(report.metric_status.undertriage_rate).toMatchObject({ numerator: 0, denominator: 40 });
    expect(markdown).toContain("Abstain rate");
    expect(markdown).toContain("Coverage-adjusted top-1");
    expect(markdown).toContain("Under-triage rate");
  });

  it("blocks publication when the no-LLM upper-bound caveat is removed", async () => {
    const { report } = await runEvaluation();
    const withoutModeCaveat = structuredClone(report);
    withoutModeCaveat.caveats = withoutModeCaveat.caveats.filter(
      (item) => !item.includes("no-llm"),
    );

    expect(() =>
      validateReportForReadme(withoutModeCaveat, publicationExpectation(report)),
    ).toThrow(/no-llm|caveat|mode/u);
  });

  it("blocks publication when the reported top-1 is substituted", async () => {
    const { report } = await runEvaluation();
    const substituted = structuredClone(report);
    substituted.metrics.pathology_top1 = 10 / 40;
    substituted.metric_status.pathology_top1 = {
      state: "measured",
      numerator: 10,
      denominator: 40,
    };

    expect(() =>
      validateReportForReadme(substituted, publicationExpectation(report)),
    ).toThrow(/top-1|coherent|publication/u);
  });
});
