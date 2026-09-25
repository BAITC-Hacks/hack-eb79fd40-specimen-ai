import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { dynamic, GET } from "../../app/api/healthz/route";
import { buildHealthResponse } from "../../lib/health";
import { loadArtifact } from "../../lib/model";

const MODEL_VERSION = loadArtifact().model_version;
const shallowRequest = () => new NextRequest("http://127.0.0.1:3000/api/healthz");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/healthz", () => {
  it("returns all contract fields and llm_ok true when the key is present", async () => {
    vi.stubEnv("COMMIT_SHA", "abc1234");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

    const response = await GET(shallowRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      commit: "abc1234",
      model_version: MODEL_VERSION,
      llm_ok: true,
      processing_mode: "external_llm",
    });
  });

  it("stays healthy without a key and falls back to an unknown commit", async () => {
    vi.stubEnv("COMMIT_SHA", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);

    const response = await GET(shallowRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      commit: "unknown",
      model_version: MODEL_VERSION,
      llm_ok: false,
      processing_mode: "external_llm",
    });
  });

  it("does not perform a network probe", async () => {
    const fetchTrap = vi.fn(() => {
      throw new Error("healthz must not call fetch");
    });
    vi.stubGlobal("fetch", fetchTrap);

    expect(buildHealthResponse({ ANTHROPIC_API_KEY: "test-key" })).toEqual({
      ok: true,
      commit: "unknown",
      model_version: MODEL_VERSION,
      llm_ok: true,
      processing_mode: "external_llm",
    });
    expect((await GET(shallowRequest())).status).toBe(200);
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  it("returns the same four-field body with 404 for an unauthorized deep request", async () => {
    vi.stubEnv("COMMIT_SHA", "abc1234");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const response = await GET(
      new NextRequest("http://127.0.0.1:3000/api/healthz?probe=extract"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      commit: "abc1234",
      model_version: MODEL_VERSION,
      llm_ok: false,
      processing_mode: "external_llm",
    });
  });

  it("is explicitly dynamic so health data is not cached", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("reports deterministic mode as healthy without an Anthropic key", async () => {
    vi.stubEnv("DEMEU_PROCESSING_MODE", "deterministic");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);

    await expect((await GET(shallowRequest())).json()).resolves.toMatchObject({
      ok: true,
      llm_ok: false,
      processing_mode: "deterministic",
    });
  });
});
