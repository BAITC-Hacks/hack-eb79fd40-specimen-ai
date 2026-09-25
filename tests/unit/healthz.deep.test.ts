import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEEP_HEALTH_PROOF_HEADER,
  computeDeepHealthProof,
  createCachedExtractionProbe,
  createDeterministicReadinessProbe,
  createExtractionProbe,
  handleHealthRequest,
  type ExtractorLoader,
} from "../../lib/health-deep";
import { loadArtifact } from "../../lib/model";

const ENV = {
  ANTHROPIC_API_KEY: "synthetic-key-for-hmac-tests",
  COMMIT_SHA: "abc1234",
};
const MODEL_VERSION = loadArtifact().model_version;

function request(
  origin = "http://127.0.0.1:3000",
  proof?: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${origin}/api/healthz?probe=extract`, {
    headers: {
      ...headers,
      ...(proof ? { [DEEP_HEALTH_PROOF_HEADER]: proof } : {}),
    },
  });
}

function expected(llm_ok: boolean) {
  return {
    ok: true,
    commit: ENV.COMMIT_SHA,
    model_version: MODEL_VERSION,
    llm_ok,
    processing_mode: "external_llm",
  };
}

describe("authorized deep extraction health probe", () => {
  it("keeps ordinary health exact, shallow, and provider-free", async () => {
    const probe = vi.fn(async () => true);
    const result = await handleHealthRequest(
      new NextRequest("http://127.0.0.1:3000/api/healthz"),
      { env: ENV, probeOnce: probe },
    );

    expect(result).toEqual({ status: 200, body: expected(true) });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ["missing proof", request()],
    ["wrong proof", request("http://127.0.0.1:3000", "wrong")],
    [
      "stale proof",
      request(
        "http://127.0.0.1:3000",
        computeDeepHealthProof(ENV.ANTHROPIC_API_KEY, "old0000"),
      ),
    ],
    ["public host without proof", request("https://demo.example.kz")],
    [
      "spoofed forwarded headers without proof",
      request("http://127.0.0.1:3000", undefined, {
        forwarded: "for=198.51.100.10;host=demo.example.kz;proto=https",
        "x-forwarded-for": "198.51.100.10",
        "x-forwarded-host": "demo.example.kz",
        "x-forwarded-proto": "https",
      }),
    ],
    [
      "public host and forwarded spoof with wrong proof",
      request("https://demo.example.kz", "wrong", {
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "localhost:3000",
        "x-forwarded-proto": "http",
      }),
    ],
  ])("returns an indistinguishable 404 and makes zero provider calls for %s", async (_label, req) => {
    const probe = vi.fn(async () => true);
    const result = await handleHealthRequest(req, { env: ENV, probeOnce: probe });

    expect(result).toEqual({ status: 404, body: expected(false) });
    expect(probe).not.toHaveBeenCalled();
  });

  it("accepts the exact commit-bound HMAC despite Next's synthesized forwarded headers", async () => {
    const proof = computeDeepHealthProof(ENV.ANTHROPIC_API_KEY, ENV.COMMIT_SHA);
    const probe = vi.fn(async () => true);
    const result = await handleHealthRequest(
      request("http://localhost:3000", proof, {
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "localhost:3000",
        "x-forwarded-proto": "http",
      }),
      { env: ENV, probeOnce: probe },
    );

    expect(result).toEqual({ status: 200, body: expected(true) });
    expect(Object.keys(result.body).sort()).toEqual([
      "commit",
      "llm_ok",
      "model_version",
      "ok",
      "processing_mode",
    ]);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("returns 200 with llm_ok false for a genuine authorized extraction failure", async () => {
    const proof = computeDeepHealthProof(ENV.ANTHROPIC_API_KEY, ENV.COMMIT_SHA);
    const probe = vi.fn(async () => false);

    await expect(
      handleHealthRequest(request("http://127.0.0.1:3000", proof), {
        env: ENV,
        probeOnce: probe,
      }),
    ).resolves.toEqual({ status: 200, body: expected(false) });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("returns 404 and provider zero when the runtime key is absent", async () => {
    const probe = vi.fn(async () => true);
    const result = await handleHealthRequest(request(), {
      env: { COMMIT_SHA: ENV.COMMIT_SHA },
      probeOnce: probe,
    });

    expect(result.status).toBe(404);
    expect(result.body).toEqual(expected(false));
    expect(probe).not.toHaveBeenCalled();
  });

  it("runs the provider-free deterministic readiness probe without a key", async () => {
    const probe = vi.fn(async () => true);
    const deterministicProbe = vi.fn(async () => true);
    const result = await handleHealthRequest(request(), {
      env: {
        COMMIT_SHA: ENV.COMMIT_SHA,
        DEMEU_PROCESSING_MODE: "deterministic",
      },
      probeOnce: probe,
      deterministicProbeOnce: deterministicProbe,
    });

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        commit: ENV.COMMIT_SHA,
        model_version: MODEL_VERSION,
        llm_ok: true,
        processing_mode: "deterministic",
      },
    });
    expect(probe).not.toHaveBeenCalled();
    expect(deterministicProbe).toHaveBeenCalledOnce();
  });

  it("fails closed when deterministic readiness is red", async () => {
    const result = await handleHealthRequest(request(), {
      env: { COMMIT_SHA: ENV.COMMIT_SHA, DEMEU_PROCESSING_MODE: "deterministic" },
      deterministicProbeOnce: async () => false,
    });
    expect(result).toEqual({
      status: 404,
      body: {
        ok: true,
        commit: ENV.COMMIT_SHA,
        model_version: MODEL_VERSION,
        llm_ok: false,
        processing_mode: "deterministic",
      },
    });
  });

  it("passes the real pure deterministic three-scenario self-test", async () => {
    await expect(createDeterministicReadinessProbe()()).resolves.toBe(true);
  });

  it("single-flights concurrent success and caches it for the process lifetime", async () => {
    let release!: (value: boolean) => void;
    const run = vi.fn(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    const probe = createCachedExtractionProbe(run);

    const first = probe();
    const second = probe();
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    release(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(probe()).resolves.toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    ["false", async () => false],
    ["throw", async () => { throw new Error("synthetic failure"); }],
  ])("caches a negative %s result and never retries", async (_label, run) => {
    const tracked = vi.fn(run);
    const probe = createCachedExtractionProbe(tracked);

    await expect(probe()).resolves.toBe(false);
    await expect(probe()).resolves.toBe(false);
    expect(tracked).toHaveBeenCalledOnce();
  });

  it("loads extraction lazily, uses retries zero, and enforces a single attempt", async () => {
    const load = vi.fn(async () => ({
      extractAll: async (
        messages: readonly { role: "user" | "assistant"; content: string }[],
        deps: {
          applicationMaxRetries?: number;
          onAttempt?: (operation: "chat" | "structured", attempt: number) => void;
        },
      ) => {
        expect(messages.some((message) => message.role === "user")).toBe(true);
        expect(messages.map((message) => message.content).join(" ")).toContain("болит горло");
        expect(messages.map((message) => message.content).join(" ")).toContain("Боли в груди");
        expect(deps.applicationMaxRetries).toBe(0);
        deps.onAttempt?.("structured", 1);
        return {
          extraction_ok: true,
          anamnesis: { chief_complaint: "Боль в горле" },
        };
      },
    })) as unknown as ExtractorLoader;
    const probe = createExtractionProbe(load);

    expect(load).not.toHaveBeenCalled();
    await expect(probe()).resolves.toBe(true);
    expect(load).toHaveBeenCalledOnce();
  });

  it("fails when an extractor attempts a second paid request", async () => {
    const load = (async () => ({
      extractAll: async (
        _messages: readonly { role: "user" | "assistant"; content: string }[],
        deps: {
          onAttempt?: (operation: "chat" | "structured", attempt: number) => void;
        },
      ) => {
        deps.onAttempt?.("structured", 1);
        deps.onAttempt?.("structured", 2);
        return {
          extraction_ok: true,
          anamnesis: { chief_complaint: "Боль в горле" },
        };
      },
    })) as unknown as ExtractorLoader;

    await expect(createExtractionProbe(load)()).rejects.toThrow("one-call budget");
  });
});
