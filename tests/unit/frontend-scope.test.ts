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
  "app/p/Preparation.tsx",
  "app/p/[token]/page.tsx",
];

describe("frontend scope guard", () => {
  it("sends the public root to the authenticated workspace", () => {
    const page = readFileSync(`${ROOT}/app/page.tsx`, "utf8");
    expect(page).toContain('redirect("/workspace")');
    expect(page).not.toMatch(/doctorCode|DOCTOR_ACCESS_CODE|codePlaceholder/u);
  });

  it("uses the supported chat and scoped patient preparation endpoints", () => {
    const source = FRONTEND_FILES.map((file) => readFileSync(`${ROOT}/${file}`, "utf8")).join("\n");
    const endpoints = [...source.matchAll(/["`](\/api\/[a-z/]+)["`]/g)].map((match) => match[1]);
    expect(new Set(endpoints)).toEqual(
      new Set(["/api/link", "/api/chat/start", "/api/chat", "/api/chat/finalize", "/api/chat/resume", "/api/chat/preparation", "/api/patient/discover", "/api/patient/access"]),
    );
    expect(source).not.toMatch(/\/api\/(?:booking|reminder|after|faq|doctor)/);
    expect(source).not.toContain("input_hint");
    expect(source).toContain("/api/patient/${encodeURIComponent(accessId)}/package");
    expect(source).toContain('referrerPolicy: "no-referrer"');
  });

  it("has no external font or CDN dependency", () => {
    const layout = readFileSync(`${ROOT}/app/layout.tsx`, "utf8");
    const css = readFileSync(`${ROOT}/app/globals.css`, "utf8");
    expect(layout).not.toContain("next/font/google");
    expect(css).not.toMatch(/fonts\.googleapis|@import\s+url/);
  });

  it("gates a clearly synthetic doctor panel on a local-only demo marker", () => {
    const page = readFileSync(`${ROOT}/app/c/[token]/page.tsx`, "utf8");
    const layout = readFileSync(`${ROOT}/app/c/[token]/layout.tsx`, "utf8");
    expect(page).toContain("demo && closing && (");
    expect(page).toContain("<DoctorPanel result={SYNTHETIC_DEMO_RESULT}");
    expect(page).not.toContain("<DoctorPanel result={result}");
    expect(layout).toContain('process.env.NODE_ENV !== "production"');
    expect(layout).toContain('process.env.DEMEU_LOCAL_DEMO === "1"');
    expect(page).toContain('setPhase("replay_failed")');
    expect(page).not.toContain('setPhase("done"); //');
  });
});
