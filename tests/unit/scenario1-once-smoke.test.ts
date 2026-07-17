import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_BASE,
  LEGACY_PRODUCTION_ORIGIN,
  SCENARIO1_ONCE_OPT_IN,
  executeScenario1Once,
} from "../../deploy/smoke.mjs";

const EXPECTED_COMMIT = "e0f3f43";
const fixture = JSON.parse(
  readFileSync("tests/fixtures/transcripts/scenario-1-chest-pain.mock.json", "utf8"),
) as {
  messages: Array<{ role: string; content: string }>;
  result: Record<string, unknown>;
};
const roots: string[] = [];

function artifactPath(root: string): string {
  return customArtifactPath(root, CANONICAL_BASE);
}

function customArtifactPath(root: string, origin: string): string {
  const hostnameSlug = new URL(origin).hostname
    .replaceAll(".", "-")
    .slice(0, 48)
    .replace(/-+$/u, "");
  const originHash = createHash("sha256").update(origin).digest("hex");
  return join(
    root,
    `prod-s1-${EXPECTED_COMMIT}-${hostnameSlug}-${originHash}-once.json`,
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "demeu-scenario1-once-"));
  roots.push(root);
  return root;
}

function successfulFetch(calls: Array<{ path: string; init?: RequestInit }>) {
  const token = "1234567890abcdef";
  const sessionId = "session-private-sentinel";
  let chatCalls = 0;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, init });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};

    if (path === "/api/healthz") {
      return json({ ok: true, commit: EXPECTED_COMMIT, model_version: "lr-v1", llm_ok: true });
    }
    if (path === "/api/link") return json({ token });
    if (path === "/api/chat/start") {
      expect(body).toEqual({ token });
      return json({ sessionId, reply: fixture.messages[0].content, turnsLeft: 20 });
    }
    if (path === "/api/chat") {
      chatCalls += 1;
      expect(body.sessionId).toBe(sessionId);
      if (chatCalls === 1) {
        expect(body.message).toBe(fixture.messages[1].content);
        return json({
          reply: fixture.messages[2].content,
          done: true,
          turnsLeft: 19,
          result: fixture.result,
        });
      }
      return json({ code: "SESSION_COMPLETED" }, 409);
    }
    if (path === "/api/chat/finalize") {
      expect(body).toEqual({ sessionId });
      return json({ result: fixture.result, source: fixture.result.source, replayed: true });
    }
    throw new Error(`unexpected test path ${path}`);
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production scenario 1 one-shot evidence harness", () => {
  it("fails on an existing commit marker before fetch and preserves it", async () => {
    const root = makeRoot();
    const marker = artifactPath(root);
    writeFileSync(marker, "owner\n", { mode: 0o600 });
    let calls = 0;

    await expect(executeScenario1Once({
      artifactRoot: root,
      expectedCommit: EXPECTED_COMMIT,
      optIn: SCENARIO1_ONCE_OPT_IN,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("fetch must not run");
      },
    })).rejects.toThrow("artifact already exists");

    expect(calls).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("owner\n");
  });

  it("runs the fixed seven-request sequence once and writes only the sanitized schema", async () => {
    const root = makeRoot();
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const outcome = await executeScenario1Once({
      artifactRoot: root,
      expectedCommit: EXPECTED_COMMIT,
      optIn: SCENARIO1_ONCE_OPT_IN,
      fetchImpl: successfulFetch(calls),
    });

    expect(outcome.artifactPath).toBe(artifactPath(root));
    expect(calls.map(({ path }) => path)).toEqual([
      "/api/healthz",
      "/api/link",
      "/api/chat/start",
      "/api/chat",
      "/api/chat/finalize",
      "/api/chat/finalize",
      "/api/chat",
    ]);
    expect(calls).toHaveLength(7);
    expect(calls.every(({ init }) => init?.redirect === "error")).toBe(true);

    const raw = readFileSync(outcome.artifactPath, "utf8");
    const artifact = JSON.parse(raw) as Record<string, unknown>;
    expect(statSync(outcome.artifactPath).mode & 0o777).toBe(0o600);
    expect(Object.keys(artifact).sort()).toEqual([
      "client_retries",
      "expected_origin_verified",
      "health_commit",
      "health_llm_ok",
      "health_model_version",
      "http_cap",
      "http_requests",
      "level",
      "ok",
      "one_shot_guard",
      "production_origin",
      "result",
      "scenario",
      "schema_version",
      "telegram_delivery",
    ]);
    expect(artifact).toMatchObject({
      schema_version: 1,
      level: "PROD_E2E_SCENARIO_1",
      ok: true,
      production_origin: CANONICAL_BASE,
      expected_origin_verified: true,
      health_commit: EXPECTED_COMMIT,
      http_requests: 7,
      http_cap: 7,
      client_retries: 0,
      scenario: { number: 1, patient_lines: 1 },
      result: {
        urgency: "emergency",
        emergency_chest_pain: true,
        evidence_verified: true,
        disclaimer_verified: true,
        finalize_result_equal: true,
        finalize_replayed: true,
        completed_chat_409: true,
      },
    });
    expect(String(artifact.telegram_delivery)).toContain("not observable");
    for (const privateValue of [
      "1234567890abcdef",
      "session-private-sentinel",
      fixture.messages[0].content,
      fixture.messages[1].content,
      fixture.messages[2].content,
      String((fixture.result.red_flags as Array<{ evidence: string }>)[0].evidence),
    ]) {
      expect(raw).not.toContain(privateValue);
    }
    expect(raw).not.toMatch(/(?:token|session|chat)_?id|transcript|prompt/iu);
  });

  it("binds a custom-domain run and its marker to the explicit trusted origin", async () => {
    const root = makeRoot();
    const expectedOrigin = "https://demo.example.kz";
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const outcome = await executeScenario1Once({
      artifactRoot: root,
      baseUrl: expectedOrigin,
      expectedOrigin,
      expectedCommit: EXPECTED_COMMIT,
      optIn: SCENARIO1_ONCE_OPT_IN,
      fetchImpl: successfulFetch(calls),
    });

    expect(outcome.artifactPath).toBe(customArtifactPath(root, expectedOrigin));
    expect(outcome.payload.production_origin).toBe(expectedOrigin);
    expect(calls).toHaveLength(7);
  });

  it("reserves the historical marker name only for the sslip rollback origin", async () => {
    const root = makeRoot();
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const outcome = await executeScenario1Once({
      artifactRoot: root,
      baseUrl: LEGACY_PRODUCTION_ORIGIN,
      expectedOrigin: LEGACY_PRODUCTION_ORIGIN,
      expectedCommit: EXPECTED_COMMIT,
      optIn: SCENARIO1_ONCE_OPT_IN,
      fetchImpl: successfulFetch(calls),
    });

    expect(outcome.artifactPath).toBe(
      join(root, `prod-s1-${EXPECTED_COMMIT}-once.json`),
    );
    expect(outcome.artifactPath).not.toBe(artifactPath(root));
    expect(calls).toHaveLength(7);
  });

  it("uses the origin SHA-256 to separate colliding slugs and blocks only the same origin", async () => {
    const root = makeRoot();
    const firstOrigin = "https://a-b.example.kz";
    const secondOrigin = "https://a.b-example.kz";
    const firstCalls: Array<{ path: string; init?: RequestInit }> = [];
    const secondCalls: Array<{ path: string; init?: RequestInit }> = [];

    const first = await executeScenario1Once({
      artifactRoot: root,
      baseUrl: firstOrigin,
      expectedOrigin: firstOrigin,
      expectedCommit: EXPECTED_COMMIT,
      optIn: SCENARIO1_ONCE_OPT_IN,
      fetchImpl: successfulFetch(firstCalls),
    });
    const second = await executeScenario1Once({
      artifactRoot: root,
      baseUrl: secondOrigin,
      expectedOrigin: secondOrigin,
      expectedCommit: EXPECTED_COMMIT,
      optIn: SCENARIO1_ONCE_OPT_IN,
      fetchImpl: successfulFetch(secondCalls),
    });

    expect(new URL(firstOrigin).hostname.replaceAll(".", "-")).toBe(
      new URL(secondOrigin).hostname.replaceAll(".", "-"),
    );
    expect(first.artifactPath).toBe(customArtifactPath(root, firstOrigin));
    expect(second.artifactPath).toBe(customArtifactPath(root, secondOrigin));
    expect(first.artifactPath).not.toBe(second.artifactPath);
    expect(basename(first.artifactPath)).toMatch(/^[a-z0-9.-]+\.json$/u);
    expect(basename(first.artifactPath).length).toBeLessThanOrEqual(160);
    expect(firstCalls).toHaveLength(7);
    expect(secondCalls).toHaveLength(7);

    let rerunCalls = 0;
    await expect(executeScenario1Once({
      artifactRoot: root,
      baseUrl: firstOrigin,
      expectedOrigin: firstOrigin,
      expectedCommit: EXPECTED_COMMIT,
      optIn: SCENARIO1_ONCE_OPT_IN,
      fetchImpl: async () => {
        rerunCalls += 1;
        return json({});
      },
    })).rejects.toThrow("artifact already exists");
    expect(rerunCalls).toBe(0);
  });

  it.each([
    { name: "missing opt-in", optIn: "", commit: EXPECTED_COMMIT, baseUrl: CANONICAL_BASE },
    { name: "bad commit", optIn: SCENARIO1_ONCE_OPT_IN, commit: "E0F3F43", baseUrl: CANONICAL_BASE },
    { name: "wrong host", optIn: SCENARIO1_ONCE_OPT_IN, commit: EXPECTED_COMMIT, baseUrl: "https://example.test" },
  ])("rejects $name before fetch", async ({ optIn, commit, baseUrl }) => {
    const root = makeRoot();
    let calls = 0;
    await expect(executeScenario1Once({
      artifactRoot: root,
      baseUrl,
      expectedCommit: commit,
      optIn,
      fetchImpl: async () => {
        calls += 1;
        return json({});
      },
    })).rejects.toThrow();
    expect(calls).toBe(0);
    expect(() => readFileSync(artifactPath(root))).toThrow();
  });

  it("writes a redacted failure marker after one failed request and blocks a rerun", async () => {
    const root = makeRoot();
    const privateBody = "private-upstream-response-sentinel";
    let calls = 0;
    const run = () => executeScenario1Once({
      artifactRoot: root,
      expectedCommit: EXPECTED_COMMIT,
      optIn: SCENARIO1_ONCE_OPT_IN,
      fetchImpl: async () => {
        calls += 1;
        return new Response(privateBody, { status: 503 });
      },
    });

    await expect(run()).rejects.toThrow("unexpected HTTP 503");
    expect(calls).toBe(1);
    const raw = readFileSync(artifactPath(root), "utf8");
    expect(raw).not.toContain(privateBody);
    expect(JSON.parse(raw)).toEqual({
      schema_version: 1,
      level: "PROD_E2E_SCENARIO_1",
      ok: false,
      production_origin: CANONICAL_BASE,
      health_commit: EXPECTED_COMMIT,
      error: "HTTP_STATUS_UNEXPECTED",
      http_cap: 7,
      client_retries: 0,
      one_shot_guard: "fixed_commit_marker_reserved_before_fetch",
      telegram_delivery: "not observable from the public API; no delivery claim",
    });

    await expect(run()).rejects.toThrow("artifact already exists");
    expect(calls).toBe(1);
  });
});
