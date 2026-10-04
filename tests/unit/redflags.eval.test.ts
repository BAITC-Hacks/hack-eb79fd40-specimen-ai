import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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
    const report = JSON.parse(readFileSync("reports/redflags/redflags-benchmark-v1.json", "utf8"));
    const current = report.candidates.find((candidate: { id: string }) => candidate.id === "rules");
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(current.version).toBe(hash("lib/redflags.ts"));
    expect(current.provenance).toMatchObject({ source_sha256: current.version,
      runner_sha256: hash("scripts/redflag_eval/rules_runner.ts"), corpus_sha256: hash("tests/fixtures/redflags-eval.json"),
      predictions_sha256: hash(current.predictions_artifact) });
    const rows: { id: string; emergency: boolean; codes: string[] }[] = JSON.parse(readFileSync(current.predictions_artifact, "utf8")).predictions;
    expect(rows).toHaveLength(corpus.items.length);
    expect(new Set(rows.map((row) => row.id)).size).toBe(corpus.items.length);
    expect(corpus.research_only).toBe(true);
    expect(corpus.items.length).toBeGreaterThanOrEqual(150);
    expect(corpus.items.length).toBeLessThanOrEqual(200);

    for (const item of corpus.items) {
      const flags = detectRedFlags(item.messages);
      const emergencyFlags = flags.filter((flag) => flag.emergency);
      expect(emergencyFlags.length > 0, item.id).toBe(item.expected_emergency);
      const recorded = rows.find((row) => row.id === item.id)!;
      expect(recorded.emergency, item.id).toBe(emergencyFlags.length > 0);
      expect([...recorded.codes].sort(), item.id)
        .toEqual(emergencyFlags.map((flag) => flag.code).sort());
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
