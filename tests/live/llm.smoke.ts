import { describe, expect, it } from "vitest";
import { chatTurn, structured } from "@/lib/llm";

const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

if (!hasApiKey) {
  console.warn(
    "[llm-live] SKIPPED: ANTHROPIC_API_KEY is missing; no live result was produced.",
  );
}

function logLiveError(scope: string, error: unknown): void {
  let current = error;
  while (
    current instanceof Error &&
    "cause" in current &&
    current.cause instanceof Error
  ) {
    current = current.cause;
  }
  const message = current instanceof Error ? current.message : String(current);
  console.error(`[llm-live] ${scope}: ${message}`);
}

describe.skipIf(!hasApiKey)("live Anthropic smoke", () => {
  it("completes a chat call and a structured call", async () => {
    const calls = { chat: 0, structured: 0 };
    const failures: unknown[] = [];
    const liveDeps = {
      applicationMaxRetries: 0,
      onAttempt(operation: "chat" | "structured") {
        calls[operation] += 1;
      },
    };

    try {
      const reply = await chatTurn("Answer briefly.", [
        { role: "user", content: "Reply with the single word OK." },
      ], liveDeps);
      expect(reply.length).toBeGreaterThan(0);
    } catch (error) {
      logLiveError("chat request failed", error);
      failures.push(error);
    }

    try {
      const result = await structured<{ ok: boolean }>(
        "Return JSON matching the supplied schema.",
        "Set ok to true.",
        {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        liveDeps,
      );
      expect(result).toEqual({ ok: true });
    } catch (error) {
      logLiveError("structured request failed", error);
      failures.push(error);
    }

    console.info(
      `[llm-live] attempted calls: chat=${calls.chat} structured=${calls.structured}`,
    );
    expect(calls).toEqual({ chat: 1, structured: 1 });
    if (failures.length > 0) throw failures[0];
  }, 240_000);
});
