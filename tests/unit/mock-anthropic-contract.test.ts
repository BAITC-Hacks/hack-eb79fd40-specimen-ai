import { describe, expect, it } from "vitest";

import {
  analysisFor,
  assertAnalysisContract,
} from "../../scripts/mock-anthropic.mjs";

const PATIENT_MESSAGES = [
  { role: "user", content: "Мне трудно спать последние три дня." },
  { role: "assistant", content: "Есть ли другие симптомы, лекарства или аллергии?" },
  { role: "user", content: "Других симптомов нет, лекарства не принимаю." },
];

describe("mock Anthropic extraction contract", () => {
  it.each(["chest-pain", "back-pain", "rhinitis", "unknown"])(
    "keeps the Task A anamnesis fields in %s",
    (scenario) => {
      expect(() => assertAnalysisContract(
        analysisFor(scenario, PATIENT_MESSAGES),
      )).not.toThrow();
    },
  );

  it("preserves explicit generic-flow negatives and medication denial", () => {
    const { anamnesis } = analysisFor("unknown", PATIENT_MESSAGES);

    expect(anamnesis.history_status.medications).toBe("denied");
    expect(anamnesis.negative_findings).toEqual(["Других симптомов нет"]);
  });

  it("fails closed when a mock payload drifts back to the legacy shape", () => {
    const analysis = analysisFor("unknown", PATIENT_MESSAGES);
    Reflect.deleteProperty(analysis.anamnesis, "history_status");

    expect(() => assertAnalysisContract(analysis)).toThrow(
      "Task A history_status and negative_findings",
    );
  });
});
