import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtractionResult } from "../../lib/extract";
import type { ChatMessage } from "../../lib/types";
import { fakeModel, type PortCounter } from "../fixtures/triage.ports";

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

describe("production extraction reachability", () => {
  beforeEach(() => {
    mocks.extractAll.mockReset();
    mocks.extractAll.mockResolvedValue({
      anamnesis: {
        chief_complaint: "Насморк",
        symptom: {
          onset: "сегодня",
          location: "нос",
          quality: "заложенность",
          severity: 2,
          modifiers: "",
          associated: [],
        },
        past_history: [],
        chronic: [],
        allergies: [],
        medications: [],
        context: {
          age: 30,
          sex: "f",
          pregnancy: "no",
          risk_factors: [],
        },
      },
      evidence: { evidences: [{ code: "E_181" }], age: 30, sex: "f" },
      unmapped: [],
      extraction_ok: true,
      audit: {
        accepted: [{ raw_index: 0, code: "E_181" }],
        rejected: [],
        unmapped_rejected_indexes: [],
      },
    });
  });

  it("uses extractAll on the default LLM path without a second adapter call", async () => {
    const modelCalls: PortCounter = { calls: 0 };

    const result = await analyze(MESSAGES, { model: fakeModel(modelCalls) });

    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(mocks.extractAll).toHaveBeenCalledWith(MESSAGES);
    expect(modelCalls.calls).toBe(1);
    expect(result.source).toBe("model");
  });
});
