import { pathToFileURL } from "node:url";
import { STRUCTURED_TIMEOUT_MS, type LlmDependencies } from "../lib/llm";
import { loadArtifact } from "../lib/model";
import { analyze, createProductionLlm } from "../lib/triage";
import type { ChatMessage, TriageResult } from "../lib/types";

export const LIVE_ANALYTICS_OPT_IN =
  "I_AUTHORIZE_THREE_STRUCTURED_EXTRACTIONS";
export const MAX_STRUCTURED_CALLS = 3;
export const PER_SCENARIO_GUARD_MS = STRUCTURED_TIMEOUT_MS + 30_000;

export const LIVE_ANALYTICS_SCENARIOS: ReadonlyArray<{
  id: string;
  messages: ChatMessage[];
}> = [
  {
    id: "sore-throat",
    messages: [
      { role: "assistant", content: "Что вас беспокоит?" },
      {
        role: "user",
        content:
          "Второй день сильно болит горло, температура 38.2, больно глотать. Сила боли 6 из 10.",
      },
      { role: "assistant", content: "Есть ли другие симптомы?" },
      { role: "user", content: "Немного слабости, больше ничего." },
    ],
  },
  {
    id: "epigastric-burning",
    messages: [
      { role: "assistant", content: "Опишите жалобу и когда она возникает." },
      {
        role: "user",
        content:
          "Три дня жжение в верхней части живота после еды, иногда тошнит. Сила 4 из 10, крови в рвоте и стуле нет.",
      },
    ],
  },
  {
    id: "dysuria-frequency",
    messages: [
      { role: "assistant", content: "Что изменилось при мочеиспускании?" },
      {
        role: "user",
        content:
          "Со вчера часто хожу в туалет и есть резь при мочеиспускании, сила 5 из 10. Температуры и боли в боку нет.",
      },
    ],
  },
];

export interface StructuredCallBudget {
  readonly actual: number;
  claim(operation: "chat" | "structured"): void;
}

export function createStructuredCallBudget(
  maximum = MAX_STRUCTURED_CALLS,
): StructuredCallBudget {
  let actual = 0;
  return {
    get actual() {
      return actual;
    },
    claim(operation) {
      if (operation !== "structured" || actual >= maximum) {
        throw new Error("live analytics provider call budget exceeded");
      }
      actual += 1;
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertModelSane(result: TriageResult): void {
  const artifact = loadArtifact();
  const classes = new Set(artifact.class_order);
  assert(result.source === "model" || result.source === "llm_fallback", "unexpected source");
  assert(result.anamnesis.chief_complaint.trim().length > 0, "empty chief complaint");
  assert(result.routing.length > 0, "empty routing");
  assert(result.model, "model block is missing");
  assert(result.model.model_version === artifact.model_version, "model version mismatch");
  assert(!result.red_flags.some((flag) => flag.emergency), "unexpected emergency flag");
  assert(result.urgency !== "emergency", "unexpected emergency urgency");

  if (result.source === "model") {
    assert(result.model.abstained === false, "model source cannot abstain");
    assert(result.model.pathologies.length > 0, "model pathologies are empty");
    assert(result.model.top_contributions.length > 0, "model contributions are empty");
    result.model.pathologies.forEach((pathology, index) => {
      assert(classes.has(pathology.code), "unknown pathology class");
      assert(Number.isFinite(pathology.prob), "non-finite model probability");
      assert(pathology.prob >= 0 && pathology.prob <= 1, "model probability outside range");
      if (index > 0) {
        assert(
          result.model!.pathologies[index - 1].prob >= pathology.prob,
          "model probabilities are not sorted",
        );
      }
    });
  } else {
    assert(result.model.abstained, "fallback model must abstain");
    assert(result.model.pathologies.length === 0, "fallback leaked pathologies");
    assert(result.model.top_contributions.length === 0, "fallback leaked contributions");
  }
}

async function withGuard<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("live analytics outer deadline exceeded")),
      PER_SCENARIO_GUARD_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function main(): Promise<void> {
  assert(process.env.LIVE_ANALYTICS === LIVE_ANALYTICS_OPT_IN, "live opt-in missing");
  assert(Boolean(process.env.ANTHROPIC_API_KEY?.trim()), "Anthropic key missing");
  assert(PER_SCENARIO_GUARD_MS > STRUCTURED_TIMEOUT_MS, "outer deadline is too short");

  const budget = createStructuredCallBudget();
  const deps: LlmDependencies = {
    applicationMaxRetries: 0,
    log: () => undefined,
    onAttempt(operation) {
      budget.claim(operation);
    },
  };
  const llm = createProductionLlm(deps);

  for (const scenario of LIVE_ANALYTICS_SCENARIOS) {
    const result = await withGuard(analyze(scenario.messages, { llm }));
    assertModelSane(result);
    console.info(
      `[analytics-live] ${scenario.id}: source=${result.source} routes=${result.routing.length} model=${result.model?.model_version}`,
    );
  }
  assert(budget.actual === MAX_STRUCTURED_CALLS, "unexpected provider call count");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("[analytics-live] failed", error instanceof Error ? error.message : "unknown");
    process.exitCode = 1;
  });
}
