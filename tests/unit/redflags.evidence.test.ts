import { describe, expect, it } from "vitest";

import { contextFlags, detectRedFlags } from "../../lib/redflags";
import type { Anamnesis, ChatMessage } from "../../lib/types";
import { RED_FLAG_PATTERN_FIXTURES } from "../fixtures/redflags.fixtures";

function anamnesis(overrides?: {
  age?: number;
  pregnancy?: "yes" | "no" | "na";
  severity?: number | null;
  complaint?: string;
}): Anamnesis {
  return {
    chief_complaint: overrides?.complaint ?? "",
    symptom: {
      onset: "сегодня",
      location: "",
      quality: "",
      severity: overrides?.severity === undefined ? 3 : overrides.severity,
      modifiers: "",
      associated: [],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: {
      age: overrides?.age ?? 30,
      sex: "f",
      pregnancy: overrides?.pregnancy ?? "no",
      risk_factors: [],
    },
  };
}

describe("red flag evidence contract", () => {
  it.each(RED_FLAG_PATTERN_FIXTURES.filter(({ code }) => code !== "pregnancy_risk"))(
    "$patternId returns a raw quote from the indexed user message",
    ({ utterance, evidence, code }) => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "Что вас беспокоит?" },
        { role: "user", content: utterance },
      ];
      const flag = detectRedFlags(messages).find((candidate) => candidate.code === code);

      expect(flag).toBeDefined();
      expect(flag!.evidence).toBe(evidence);
      expect(flag!.evidence_kind).toBe("quote");
      expect(messages[flag!.source_message_index].role).toBe("user");
      expect(messages[flag!.source_message_index].content).toContain(flag!.evidence);
    }
  );

  it("uses a relevant immediately preceding question for a short affirmation", () => {
    const question = "Болит ли у вас грудь?";
    const messages: ChatMessage[] = [
      { role: "assistant", content: question },
      { role: "user", content: "Да" },
    ];
    const flag = detectRedFlags(messages).find(({ code }) => code === "chest_pain");

    expect(flag).toMatchObject({
      evidence: "Да",
      evidence_kind: "quote",
      source_message_index: 1,
      elicited_by: question,
    });
  });

  it("does not turn an unrelated or unprompted short affirmation into a flag", () => {
    expect(
      detectRedFlags([
        { role: "assistant", content: "Вам 30 лет?" },
        { role: "user", content: "Да" },
      ])
    ).toEqual([]);
    expect(detectRedFlags([{ role: "user", content: "Да" }])).toEqual([]);
  });

  it("returns at most one flag per rule across messages and matching patterns", () => {
    const flags = detectRedFlags([
      { role: "user", content: "Боль в груди" },
      { role: "user", content: "Позже стало давить в груди" },
    ]).filter(({ code }) => code === "chest_pain");

    expect(flags).toHaveLength(1);
    expect(flags[0].source_message_index).toBe(0);
    expect(flags[0].evidence).toBe("Боль в груди");
  });

  it("marks both context flags as derived with index -1", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Мне плохо" }];
    const flags = contextFlags(
      anamnesis({
        age: 70,
        pregnancy: "yes",
        severity: 8,
        complaint: "болит в животе",
      }),
      messages
    );

    expect(flags.map(({ code }) => code).sort()).toEqual([
      "elderly_severe",
      "pregnancy_risk",
    ]);
    for (const flag of flags) {
      expect(flag.evidence_kind).toBe("derived");
      expect(flag.source_message_index).toBe(-1);
      expect(flag.evidence).not.toBe("");
    }
  });

  it("does not infer elderly severe risk when intensity is unknown", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Мне плохо" }];

    expect(
      contextFlags(anamnesis({ age: 70, severity: null }), messages).some(
        ({ code }) => code === "elderly_severe",
      ),
    ).toBe(false);
    expect(
      contextFlags(anamnesis({ age: 70, severity: 7 }), messages).some(
        ({ code }) => code === "elderly_severe",
      ),
    ).toBe(true);
  });
});
