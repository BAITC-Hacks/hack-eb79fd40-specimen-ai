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
      rule.patterns.map(({ id }) => id)
    ).sort();
    const covered = RED_FLAG_PATTERN_FIXTURES.map(({ patternId }) => patternId).sort();

    expect(new Set(expected).size).toBe(expected.length);
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered).toEqual(expected);
  });

  it("forbids ASCII-only word classes and requires Unicode mode", () => {
    for (const rule of PATTERN_RULES) {
      for (const { id, regex } of rule.patterns) {
        expect(id).toMatch(new RegExp(`^${rule.code}\\.(?:ru|kk)_`));
        expect(regex.source).not.toMatch(/\\[wWbB]/);
        expect(regex.flags).toContain("u");
      }
    }
  });

  it("covers every emergency trigger in both Russian and Kazakh", () => {
    for (const rule of RULES) {
      expect(rule.patterns.some(({ id }) => id.startsWith(`${rule.code}.ru_`)), `${rule.code}: ru`).toBe(true);
      expect(rule.patterns.some(({ id }) => id.startsWith(`${rule.code}.kk_`)), `${rule.code}: kk`).toBe(true);
    }
  });

  it.each(RED_FLAG_PATTERN_FIXTURES)(
    "$patternId matches its live RU/KK phrase without truncating evidence",
    ({ patternId, code, utterance, evidence }) => {
      const rule = PATTERN_RULES.find(({ code: candidate }) => candidate === code);
      const pattern = rule?.patterns.find(({ id }) => id === patternId);

      expect(rule?.code).toBe(code);
      expect(pattern).toBeDefined();
      expect(pattern!.regex.exec(utterance)?.[0]).toBe(evidence);

      const messages: ChatMessage[] = [{ role: "user", content: utterance }];
      const flags =
        code === "pregnancy_risk"
          ? contextFlags(anamnesis(utterance), messages)
          : detectRedFlags(messages);
      expect(flags.some((flag) => flag.code === code)).toBe(true);
    }
  );
});
