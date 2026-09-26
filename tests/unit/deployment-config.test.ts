import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("offline deployment configuration", () => {
  it("builds a standalone Next server and traces the runtime PDF font", async () => {
    const config = await import("../../next.config.mjs");

    expect(config.default.output).toBe("standalone");
    expect(config.default.outputFileTracingIncludes).toEqual({
      "/api/**": ["./assets/fonts/**"],
    });
  });

  it("uses a non-root node 24 multi-stage runtime without build-time secrets", async () => {
    const dockerfile = await text("Dockerfile");

    expect(dockerfile.match(/^FROM node:24-alpine AS /gmu)).toHaveLength(3);
    expect(dockerfile).toContain("RUN npm ci");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("COPY --from=builder --chown=nextjs:nodejs /app/assets ./assets");
    expect(dockerfile).toContain("USER nextjs");
    expect(dockerfile).toContain("HOSTNAME=0.0.0.0");
    expect(dockerfile).toContain("ARG COMMIT_SHA=unknown");
    expect(dockerfile).not.toMatch(/ARG (?:ANTHROPIC|TELEGRAM|DOCTOR_ACCESS)/u);
  });

  it("keeps the application port loopback-only and health independent of llm_ok", async () => {
    const compose = await text("docker-compose.yml");

    expect(compose).toContain('"127.0.0.1:${APP_PORT:-3100}:3000"');
    expect(compose).not.toMatch(/^\s+-\s+["']?\$\{APP_PORT/u);
    expect(compose).toContain("response.ok ? 0 : 1");
    expect(compose).not.toMatch(/llm_ok/u);
    expect(compose).not.toMatch(/postgres/iu);
  });

  it("excludes secrets, offline data, Python and caches without hiding runtime assets", async () => {
    const dockerignore = await text(".dockerignore");

    for (const ignored of [
      ".env*",
      "scripts/",
      "data/raw/",
      "data/processed/",
      ".venv/",
      ".ruff_cache/",
      "*.joblib",
    ]) {
      expect(dockerignore).toContain(ignored);
    }
    expect(dockerignore).not.toMatch(/^assets\//mu);
    expect(dockerignore).not.toMatch(/^models\/$/mu);
    expect(dockerignore).not.toMatch(/^data\/$/mu);
    expect(dockerignore).toContain("eval/**");
    expect(dockerignore).toContain("!eval/report.json");
    expect(dockerignore).toContain("reports/**");
    for (const runtimeEvidence of [
      "!reports/redflags/redflags-benchmark-v1.json",
      "!reports/referral-refusal-baseline-v0.json",
      "!reports/wait-time-baseline-v0.json",
      "!reports/lab-load-v1.json",
    ]) {
      expect(dockerignore).toContain(runtimeEvidence);
    }
    expect(dockerignore.indexOf("eval/**")).toBeLessThan(dockerignore.indexOf("!eval/report.json"));
    expect(dockerignore.indexOf("reports/**")).toBeLessThan(dockerignore.indexOf("!reports/redflags/"));
    expect(dockerignore.indexOf("!reports/redflags/")).toBeLessThan(
      dockerignore.indexOf("!reports/redflags/redflags-benchmark-v1.json"),
    );
  });
});
