import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const OPT_IN = "I_AUTHORIZE_THREE_STRUCTURED_EXTRACTIONS";

describe("opt-in live analytics smoke guards", () => {
  it("freezes three non-emergency scenarios and a three-call structured-only budget", async () => {
    const source = await readFile("scripts/live-analytics-smoke.ts", "utf8");

    expect(source).toContain('export const MAX_STRUCTURED_CALLS = 3');
    expect(source).toContain('id: "sore-throat"');
    expect(source).toContain('id: "epigastric-burning"');
    expect(source).toContain('id: "dysuria-frequency"');
    expect(source).toContain('operation !== "structured"');
    expect(source).toContain('actual >= maximum');
    expect(source).toContain('applicationMaxRetries: 0');
    expect(source).toContain('PER_SCENARIO_GUARD_MS = STRUCTURED_TIMEOUT_MS + 30_000');
  });

  it("is isolated from default tests, chat, and Telegram delivery", async () => {
    const [manifest, source] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("scripts/live-analytics-smoke.ts", "utf8"),
    ]);
    const scripts = (JSON.parse(manifest) as { scripts: Record<string, string> }).scripts;

    expect(scripts.test).toBe("vitest run");
    expect(scripts["test:llm:live"]).toBe("vitest run --config vitest.live.config.ts");
    expect(scripts["test:analytics:live"]).toContain(OPT_IN);
    expect(source).toContain(OPT_IN);
    expect(source).not.toContain("chatTurn(");
    expect(source).not.toContain("Telegram");
    expect(source).not.toContain("finalizeSession");
  });
});
