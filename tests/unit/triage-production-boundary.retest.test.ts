import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtractionResult } from "../../lib/extract";
import type { ModelPort, ModelPortResult } from "../../lib/triage";
import type { ChatMessage, EvidenceVector } from "../../lib/types";
import { BASE_LLM_ANALYSIS } from "../fixtures/triage.ports";

const mocks = vi.hoisted(() => ({
  extractAll: vi.fn<(messages: readonly ChatMessage[]) => Promise<ExtractionResult>>(),
}));

vi.mock("../../lib/extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/extract")>()),
  extractAll: mocks.extractAll,
}));

import { analyze } from "../../lib/triage";

const MESSAGES: ChatMessage[] = [
  { role: "assistant", content: "Что вас беспокоит?" },
  { role: "user", content: "Беспокоит насморк." },
];

const PREDICTION: ModelPortResult = {
  prediction: {
    pathologies: [
      { code: "Bronchitis", label_ru: "Бронхит", prob: 0.9 },
    ],
    top_contributions: [],
    abstained: false,
    model_version: "boundary-test-v1",
  },
  abstain_threshold: 0.5,
};

function extraction(evidence: EvidenceVector): ExtractionResult {
  return {
    anamnesis: BASE_LLM_ANALYSIS.anamnesis,
    evidence,
    unmapped: [],
    extraction_ok: true,
    audit: {
      accepted: [],
      rejected: [],
      unmapped_rejected_indexes: [],
    },
  };
}

describe("production extraction boundary retest", () => {
  beforeEach(() => {
    mocks.extractAll.mockReset();
  });

  it("calls the accepted extractor once and moves invented evidence to OOL before thresholding", async () => {
    mocks.extractAll.mockResolvedValue(
      extraction({ evidences: [{ code: "E_NOT_REAL" }], age: 49, sex: "f" }),
    );
    const predict = vi.fn<ModelPort["predict"]>(() => PREDICTION);

    const result = await analyze(MESSAGES, { model: { predict } });

    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(mocks.extractAll).toHaveBeenCalledWith(MESSAGES);
    expect(predict).toHaveBeenCalledOnce();
    expect(predict.mock.calls[0][0]).toEqual({
      evidences: [],
      age: 49,
      sex: "f",
    });
    expect(predict.mock.calls[0][1]).toHaveLength(1);
    expect(predict.mock.calls[0][1][0]).toContain("E_NOT_REAL");
    expect(result.source).toBe("llm_fallback");
    expect(result.model).toMatchObject({
      abstained: true,
      abstain_reason: "out_of_label_space",
      pathologies: [],
      top_contributions: [],
    });
  });

  it("preserves valid base and categorical code/value pairs when the boundary re-sanitizes", async () => {
    const accepted: EvidenceVector = {
      evidences: [{ code: "E_14" }, { code: "E_55", value: "V_101" }],
      age: 58,
      sex: "m",
    };
    mocks.extractAll.mockResolvedValue(extraction(accepted));
    const predict = vi.fn<ModelPort["predict"]>(() => PREDICTION);

    const result = await analyze(MESSAGES, { model: { predict } });

    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(predict).toHaveBeenCalledWith(accepted, []);
    expect(result.source).toBe("model");
  });
});
