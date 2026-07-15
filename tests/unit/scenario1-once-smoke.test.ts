import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_BASE,
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
  return join(root, `prod-s1-${EXPECTED_COMMIT}-once.json`);
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
      "canonical_host_verified",
      "client_retries",
      "health_commit",
      "health_llm_ok",
      "health_model_version",
      "http_cap",
      "http_requests",
      "level",
      "ok",
      "one_shot_guard",
      "result",
      "scenario",
      "schema_version",
      "telegram_delivery",
    ]);
    expect(artifact).toMatchObject({
      schema_version: 1,
      level: "PROD_E2E_SCENARIO_1",
      ok: true,
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
