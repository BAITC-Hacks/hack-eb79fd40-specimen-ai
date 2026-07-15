import { describe, expect, it } from "vitest";

import { buildVector, loadArtifact, predict } from "../../lib/model";
import { analyze, type LlmAnalysis } from "../../lib/triage";
import type { EvidenceVector, ModelPrediction } from "../../lib/types";
import {
  assertPredictionIntegrity,
  runEvaluation,
  validateReportForReadme,
} from "../../scripts/eval";

const EMPTY_ANALYSIS: LlmAnalysis = {
  anamnesis: {
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
  },
  evidence: { evidences: [], age: null, sex: "unknown" },
  unmapped: [],
  urgency: "planned",
  urgency_reasons: ["test"],
  routing: [{ specialty: "терапевт", confidence: 0.1 }],
  hypothesis: { text: "test", confidence: 0.1 },
};

describe("offline evaluation", () => {
  it("runs every canonical case deterministically and labels unavailable metrics honestly", async () => {
    const first = await runEvaluation();
    const second = await runEvaluation();

    expect(second).toEqual(first);
    expect(first.report.mode).toBe("no-llm");
    expect(first.report.n).toMatchObject({ total: 48, flat: 28, dialog: 12, redflag: 8 });
    expect(first.report.per_case).toHaveLength(48);
    expect(first.report.invariants.all_passed).toBe(true);
    expect(first.report.metrics.extraction_f1_flat).toBeNull();
    expect(first.report.metric_status.extraction_f1_flat).toMatchObject({ state: "not_run" });
    expect(first.report.metric_status.routing_top3_strict).toMatchObject({ state: "UNVALIDATED" });
    expect(first.markdown.startsWith("mode: no-llm\n")).toBe(true);
  });

  it("rejects stale inputs and publication of unvalidated metrics", async () => {
    const { report } = await runEvaluation();
    const expected = {
      mode: "no-llm" as const,
      casesSha256: report.provenance.cases.sha256,
      modelSha256: report.provenance.model.sha256,
      mapSha256: report.provenance.pathology_map.sha256,
    };
    expect(() => validateReportForReadme(report, expected)).not.toThrow();

    const stale = structuredClone(report);
    stale.cases_sha256 = "0".repeat(64);
    expect(() => validateReportForReadme(stale, expected)).toThrow(/stale/u);

    const leaked = structuredClone(report);
    leaked.readme_guard.allowed_metrics.push("routing_top3_strict");
    expect(() => validateReportForReadme(leaked, expected)).toThrow(/publication-allowed/u);

    const duplicate = structuredClone(report);
    duplicate.per_case[1].id = duplicate.per_case[0].id;
    expect(() => validateReportForReadme(duplicate, expected)).toThrow(/duplicate or missing/u);

    const wrongMode = structuredClone(report) as unknown as {
      mode: string;
      readme_guard: { required_mode: string };
    };
    wrongMode.mode = "full";
    wrongMode.readme_guard.required_mode = "full";
    expect(() => validateReportForReadme(wrongMode as typeof report, expected)).toThrow(/mode/u);

    const fabricatedExtraction = structuredClone(report);
    fabricatedExtraction.metrics.extraction_f1_flat = 1;
    fabricatedExtraction.metric_status.extraction_f1_flat = {
      state: "measured",
      numerator: 28,
      denominator: 28,
    };
    expect(() => validateReportForReadme(fabricatedExtraction, expected)).toThrow(/extraction/u);

    const staleDictionary = structuredClone(report);
    staleDictionary.provenance.dictionary.sha256 = "0".repeat(64);
    staleDictionary.readme_guard.required_hashes.dictionary = "0".repeat(64);
    expect(() => validateReportForReadme(staleDictionary, expected)).toThrow(/dictionary.*stale/u);

    const incoherentAbstain = structuredClone(report);
    incoherentAbstain.metric_status.abstain_rate.numerator = 1;
    incoherentAbstain.metrics.abstain_rate = 1 / 40;
    expect(() => validateReportForReadme(incoherentAbstain, expected)).toThrow(
      /headline|coherent|publication/u,
    );

    for (const name of Object.keys(report.metrics)) {
      const status = report.metric_status[name];
      if (report.metrics[name] === null || status.denominator === undefined) continue;
      const tampered = structuredClone(report);
      const denominator = status.denominator;
      const numerator = status.numerator ?? 0;
      const substitutedNumerator = numerator === 0 ? 1 : numerator - 1;
      tampered.metric_status[name].numerator = substitutedNumerator;
      tampered.metrics[name] = substitutedNumerator / denominator;
      expect(
        () => validateReportForReadme(tampered, expected),
        `${name} headline substitution must be rejected`,
      ).toThrow(/headline|coherent|publication/u);
    }
  });

  it("guards class codes, finite probabilities and the full distribution", () => {
    const artifact = loadArtifact();
    const evidence: EvidenceVector = {
      evidences: [{ code: "E_53" }],
      age: 40,
      sex: "f",
    };
    const vector = buildVector(evidence, artifact);
    const prediction = predict(vector, artifact);

    expect(() => assertPredictionIntegrity(prediction, vector)).not.toThrow();
    expect(prediction.pathologies.reduce((sum, item) => sum + item.prob, 0)).toBeLessThan(1);

    const unknownCode: ModelPrediction = structuredClone(prediction);
    unknownCode.pathologies[0].code = "E_NOT_REAL";
    expect(() => assertPredictionIntegrity(unknownCode, vector)).toThrow(/unknown codes/u);

    const nonFinite: ModelPrediction = structuredClone(prediction);
    nonFinite.pathologies[0].prob = Number.NaN;
    expect(() => assertPredictionIntegrity(nonFinite, vector)).toThrow(/invalid probabilities/u);
  });

  it("keeps unknown evidence outside the model result and redacts abstained output", async () => {
    const result = await analyze(
      [{ role: "user", content: "Неспецифическая жалоба." }],
      {
        llm: {
          async analyze() {
            return {
              ...EMPTY_ANALYSIS,
              evidence: {
                evidences: [{ code: "E_NOT_REAL" }],
                age: null,
                sex: "unknown",
              },
            };
          },
        },
      },
    );

    expect(result.source).toBe("llm_fallback");
    expect(result.model).toMatchObject({
      abstained: true,
      abstain_reason: "out_of_label_space",
      pathologies: [],
      top_contributions: [],
    });
  });
});
