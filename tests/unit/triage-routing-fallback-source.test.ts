import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("fallback routing source guard", () => {
  it("does not retain the former production placeholder route confidence", () => {
    const source = readFileSync("lib/triage.ts", "utf8");

    expect(source).not.toMatch(
      /routing:\s*\[\{\s*specialty:[^}]+confidence:\s*0\.25/gu,
    );
  });
});
