import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectRedFlags } from "../../lib/redflags";
import type { ChatMessage } from "../../lib/types";

interface SafetyCase {
  id: string;
  kind: string;
  messages: ChatMessage[];
  gold: {
    emergency_expected: boolean;
    red_flag_codes: string[];
  };
}

function safetyCases(): SafetyCase[] {
  return readFileSync(join(process.cwd(), "eval/cases.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SafetyCase)
    .filter((testCase) => testCase.kind === "redflag");
}

describe("manual eval safety cards", () => {
  it("matches the exact rule codes frozen in the five positives and three negatives", () => {
    const cases = safetyCases();

    expect(cases).toHaveLength(8);
    for (const testCase of cases) {
      const flags = detectRedFlags(testCase.messages);
      expect(
        flags.map((flag) => flag.code).sort(),
        testCase.id
      ).toEqual([...testCase.gold.red_flag_codes].sort());
      expect(flags.some((flag) => flag.emergency), testCase.id).toBe(
        testCase.gold.emergency_expected
      );
    }
  });
});
