import { afterEach, describe, expect, it, vi } from "vitest";
import { dynamic, GET } from "../../app/api/healthz/route";
import { buildHealthResponse } from "../../lib/health";
import { loadArtifact } from "../../lib/model";

const MODEL_VERSION = loadArtifact().model_version;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/healthz", () => {
  it("returns all contract fields and llm_ok true when the key is present", async () => {
    vi.stubEnv("COMMIT_SHA", "abc1234");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      commit: "abc1234",
      model_version: MODEL_VERSION,
      llm_ok: true,
    });
  });

  it("stays healthy without a key and falls back to an unknown commit", async () => {
    vi.stubEnv("COMMIT_SHA", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);

    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      commit: "unknown",
      model_version: MODEL_VERSION,
      llm_ok: false,
    });
  });

  it("does not perform a network probe", () => {
    const fetchTrap = vi.fn(() => {
      throw new Error("healthz must not call fetch");
    });
    vi.stubGlobal("fetch", fetchTrap);

    expect(buildHealthResponse({ ANTHROPIC_API_KEY: "test-key" })).toEqual({
      ok: true,
      commit: "unknown",
      model_version: MODEL_VERSION,
      llm_ok: true,
    });
    expect(GET().status).toBe(200);
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  it("is explicitly dynamic so health data is not cached", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
