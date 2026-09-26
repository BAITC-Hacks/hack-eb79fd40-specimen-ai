import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { detectRedFlags } from "../../lib/redflags";
import type { ChatMessage } from "../../lib/types";

interface CorpusItem {
  id: string;
  messages: ChatMessage[];
  expected_emergency: boolean;
  expected_codes: string[];
}

interface Corpus {
  research_only: boolean;
  items: CorpusItem[];
}

const corpus = JSON.parse(
  readFileSync("tests/fixtures/redflags-eval.json", "utf8"),
) as Corpus;

describe("frozen red flag research corpus runtime contract", () => {
  it("keeps the benchmark research-only and exercises every item", () => {
    expect(corpus.research_only).toBe(true);
    expect(corpus.items.length).toBeGreaterThanOrEqual(150);
    expect(corpus.items.length).toBeLessThanOrEqual(200);

    for (const item of corpus.items) {
      const flags = detectRedFlags(item.messages);
      const emergencyFlags = flags.filter((flag) => flag.emergency);
      expect(emergencyFlags.length > 0, item.id).toBe(item.expected_emergency);
      expect(
        emergencyFlags.map(({ code }) => code).sort(),
        `${item.id}: exact emergency families`,
      ).toEqual([...item.expected_codes].sort());
      for (const flag of flags) {
        expect(flag.evidence_kind, item.id).toBe("quote");
        const source = item.messages[flag.source_message_index];
        expect(source?.role, item.id).toBe("user");
        expect(source?.content.includes(flag.evidence), item.id).toBe(true);
      }
    }
  });
});
