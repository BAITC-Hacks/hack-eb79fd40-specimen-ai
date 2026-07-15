import { describe, expect, it } from "vitest";

import {
  CONTEXT_PATTERN_RULES,
  RULES,
  contextFlags,
  detectRedFlags,
} from "../../lib/redflags";
import type { Anamnesis, ChatMessage } from "../../lib/types";
import { RED_FLAG_PATTERN_FIXTURES } from "../fixtures/redflags.fixtures";

const PATTERN_RULES = [...RULES, ...CONTEXT_PATTERN_RULES];

function anamnesis(chiefComplaint: string): Anamnesis {
  return {
    chief_complaint: chiefComplaint,
    symptom: {
      onset: "сегодня",
      location: "",
      quality: "",
      severity: 5,
      modifiers: "",
      associated: [],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: { age: 30, sex: "f", pregnancy: "yes", risk_factors: [] },
  };
}

describe("red flag pattern contract", () => {
  it("covers every live emergency and context regex exactly once", () => {
    const expected = PATTERN_RULES.flatMap((rule) =>
      rule.patterns.map((_, index) => `${rule.code}#${index}`)
    ).sort();
    const covered = RED_FLAG_PATTERN_FIXTURES.map(({ patternId }) => patternId).sort();

    expect(covered).toEqual(expected);
    expect(covered).toHaveLength(28);
  });

  it("forbids ASCII-only word classes and requires Unicode mode", () => {
    for (const rule of PATTERN_RULES) {
      for (const pattern of rule.patterns) {
        expect(pattern.source).not.toMatch(/\\[wWbB]/);
        expect(pattern.flags).toContain("u");
      }
    }
  });

  it.each(RED_FLAG_PATTERN_FIXTURES)(
    "$patternId matches a live Russian phrase without truncating evidence",
    ({ patternId, code, utterance, evidence }) => {
      const [ruleCode, patternIndexText] = patternId.split("#");
      const rule = PATTERN_RULES.find(({ code: candidate }) => candidate === ruleCode);
      const pattern = rule?.patterns[Number(patternIndexText)];

      expect(rule?.code).toBe(code);
      expect(pattern).toBeDefined();
      expect(pattern!.exec(utterance)?.[0]).toBe(evidence);

      const messages: ChatMessage[] = [{ role: "user", content: utterance }];
      const flags =
        code === "pregnancy_risk"
          ? contextFlags(anamnesis(utterance), messages)
          : detectRedFlags(messages);
      expect(flags.some((flag) => flag.code === code)).toBe(true);
    }
  );
});
