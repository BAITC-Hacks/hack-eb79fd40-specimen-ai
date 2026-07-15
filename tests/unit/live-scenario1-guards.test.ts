import { describe, expect, it } from "vitest";
import { CHAT_TIMEOUT_MS, STRUCTURED_TIMEOUT_MS } from "../../lib/llm";
import {
  MAX_ANTHROPIC_CALLS,
  OUTER_GUARD_MS,
  createAnthropicCallBudget,
} from "../../scripts/live-scenario1";

describe("one-shot live scenario guards", () => {
  it("gives structured extraction a longer deadline than chat and a later outer guard", () => {
    expect(CHAT_TIMEOUT_MS).toBe(30_000);
    expect(STRUCTURED_TIMEOUT_MS).toBe(180_000);
    expect(OUTER_GUARD_MS).toBe(225_000);
    expect(CHAT_TIMEOUT_MS).toBeLessThan(STRUCTURED_TIMEOUT_MS);
    expect(STRUCTURED_TIMEOUT_MS).toBeLessThan(OUTER_GUARD_MS);
    expect(CHAT_TIMEOUT_MS + STRUCTURED_TIMEOUT_MS).toBeLessThan(
      OUTER_GUARD_MS,
    );
  });

  it("refuses a fourth Anthropic request before it becomes actual", () => {
    const budget = createAnthropicCallBudget();
    for (let call = 0; call < MAX_ANTHROPIC_CALLS; call += 1) budget.claim();

    expect(budget.actual).toBe(3);
    expect(() => budget.claim()).toThrowError(
      expect.objectContaining({ stage: "anthropic_call_cap" }),
    );
    expect(budget.actual).toBe(3);
  });
});
