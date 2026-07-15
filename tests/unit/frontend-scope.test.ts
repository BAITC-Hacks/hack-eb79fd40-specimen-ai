import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FRONTEND_FILES = [
  "app/page.tsx",
  "app/c/[token]/page.tsx",
  "app/c/[token]/DoctorPanel.tsx",
  "app/c/[token]/patient-components.tsx",
  "app/ds/page.tsx",
  "lib/http.ts",
];

describe("frontend scope guard", () => {
  it("uses exactly the four supported network endpoints", () => {
    const source = FRONTEND_FILES.map((file) => readFileSync(`${ROOT}/${file}`, "utf8")).join("\n");
    const endpoints = [...source.matchAll(/["`](\/api\/[a-z/]+)["`]/g)].map((match) => match[1]);
    expect(new Set(endpoints)).toEqual(
      new Set(["/api/link", "/api/chat/start", "/api/chat", "/api/chat/finalize"]),
    );
    expect(source).not.toMatch(/\/api\/(?:booking|reminder|after|faq|doctor)/);
    expect(source).not.toContain("input_hint");
  });

  it("has no external font or CDN dependency", () => {
    const layout = readFileSync(`${ROOT}/app/layout.tsx`, "utf8");
    const css = readFileSync(`${ROOT}/app/globals.css`, "utf8");
    expect(layout).not.toContain("next/font/google");
    expect(css).not.toMatch(/fonts\.googleapis|@import\s+url/);
  });

  it("gates the doctor panel on demo plus a factual result", () => {
    const page = readFileSync(`${ROOT}/app/c/[token]/page.tsx`, "utf8");
    expect(page).toContain("demo && result && <DoctorPanel result={result}");
    expect(page).toContain('setPhase("replay_failed")');
    expect(page).not.toContain('setPhase("done"); //');
  });
});
