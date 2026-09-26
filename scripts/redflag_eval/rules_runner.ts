import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { detectRedFlags } from "../../lib/redflags";
import type { ChatMessage } from "../../lib/types";

interface CorpusItem {
  id: string;
  messages: ChatMessage[];
}

interface Corpus {
  items: CorpusItem[];
}

const corpusPath = process.argv[2];
if (!corpusPath) {
  throw new Error("usage: rules_runner.ts <corpus.json>");
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;
const predictions = corpus.items.map((item) => {
  const started = performance.now();
  const flags = detectRedFlags(item.messages);
  const latencyMs = performance.now() - started;
  return {
    id: item.id,
    emergency: flags.some((flag) => flag.emergency),
    codes: flags.filter((flag) => flag.emergency).map((flag) => flag.code),
    latency_ms: latencyMs,
  };
});

process.stdout.write(`${JSON.stringify({ predictions })}\n`);
