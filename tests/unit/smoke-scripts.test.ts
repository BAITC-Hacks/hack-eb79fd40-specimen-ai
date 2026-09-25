import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, TriageResult } from "../../lib/types";
import {
  CANONICAL_BASE,
  anthropicRequestUpperBound,
  assertSmokeResult,
  runL1,
  runL2,
  validateProductionOrigin,
} from "../../deploy/smoke.mjs";

it("records a zero Anthropic request bound for deterministic L2 artifacts", () => {
  expect(anthropicRequestUpperBound("deterministic")).toBe(0);
  expect(anthropicRequestUpperBound("external_llm")).toBe(24);
});

type FetchCall = { url: string; init?: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(status = 200): Response {
  return new Response("<!doctype html><title>Demeu</title>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const health = {
  ok: true,
  commit: "0123456789abcdef0123456789abcdef01234567",
  model_version: "lr-v1",
  llm_ok: false,
  processing_mode: "external_llm",
};

describe("production smoke scripts", () => {
  it("L1 performs exactly the five no-key checks through verified HTTPS", async () => {
    const calls: FetchCall[] = [];
    const token = "1234567890abcdef";
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/") return html();
      if (path === "/api/healthz") return json(health);
      if (path === "/api/link") return json({ token });
      if (path === "/api/chat/start") return json({ code: "TOKEN_NOT_FOUND" }, 404);
      if (path === `/c/${token}`) return html();
      throw new Error(`unexpected path ${path}`);
    };

    const result = await runL1({ baseUrl: CANONICAL_BASE, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(5);
    expect(result.http_requests).toBe(5);
    expect(result.valid_start).toContain("not_called");
    expect(calls).toHaveLength(5);
    expect(calls.every(({ url }) => url.startsWith(`${CANONICAL_BASE}/`))).toBe(true);
    expect(calls.every(({ init }) => init?.redirect === "error")).toBe(true);
    expect(calls.some(({ url }) => url.includes("-k"))).toBe(false);
  });

  it("binds every custom-domain L1 request to the explicit trusted origin", async () => {
    const expectedOrigin = "https://demo.example.kz";
    const token = "1234567890abcdef";
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const path = new URL(url).pathname;
      if (path === "/" || path === `/c/${token}`) return html();
      if (path === "/api/healthz") return json(health);
      if (path === "/api/link") return json({ token });
      if (path === "/api/chat/start") return json({ code: "TOKEN_NOT_FOUND" }, 404);
      throw new Error(`unexpected path ${path}`);
    };

    const result = await runL1({
      baseUrl: expectedOrigin,
      expectedOrigin,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls.every((url) => new URL(url).origin === expectedOrigin)).toBe(true);
  });

  it.each([
    ["DNS or TLS failure", async () => { throw new TypeError("certificate or DNS detail must stay hidden"); }],
    ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["redirect", async () => new Response(null, { status: 302, headers: { location: "https://example.org" } })],
    ["4xx", async () => html(404)],
    ["5xx", async () => html(503)],
  ])("fails closed on %s without retry", async (_label, fetchImpl) => {
    let calls = 0;
    await expect(runL1({
      baseUrl: CANONICAL_BASE,
      fetchImpl: async () => {
        calls += 1;
        return fetchImpl();
      },
    })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("rejects a non-JSON health response without echoing its body", async () => {
    let calls = 0;
    const secretLikeBody = "not-json-private-value";
    const promise = runL1({
      baseUrl: CANONICAL_BASE,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? html() : new Response(secretLikeBody, { status: 200 });
      },
    });
    await expect(promise).rejects.toThrow("returned non-JSON");
    await expect(promise).rejects.not.toThrow(secretLikeBody);
    expect(calls).toBe(2);
  });

  it("rejects an oversized response once without echoing its body", async () => {
    let calls = 0;
    const oversized = "private-response-body".repeat(60_000);
    const promise = runL1({
      baseUrl: CANONICAL_BASE,
      fetchImpl: async () => {
        calls += 1;
        return new Response(oversized, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });

    await expect(promise).rejects.toThrow("response is too large");
    await expect(promise).rejects.not.toThrow("private-response-body");
    expect(calls).toBe(1);
  });

  it("does not expose the generated patient token through an L1 failure message", async () => {
    const token = "feedfacecafebeef";
    let calls = 0;
    const promise = runL1({
      baseUrl: CANONICAL_BASE,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return html();
        if (calls === 2) return json(health);
        if (calls === 3) return json({ token });
        if (calls === 4) return json({ code: "TOKEN_NOT_FOUND" }, 404);
        return html(503);
      },
    });

    await expect(promise).rejects.toThrow("unexpected HTTP 503");
    await expect(promise).rejects.not.toThrow(token);
    expect(calls).toBe(5);
  });

  it.each([
    "http://109.123.248.16",
    "https://109.123.248.16:443",
    "https://109.123.248.16/extra",
    "http://109-123-248-16.sslip.io",
    "https://109-123-248-16.sslip.io:443",
    "https://109-123-248-16.sslip.io/extra",
    "https://user@109-123-248-16.sslip.io",
    "https://109-123-248-16.sslip.io/?query=1",
    "https://109-123-248-16.sslip.io.",
    "HTTPS://109-123-248-16.sslip.io",
    "https://xn--109-123-248-16-9za.sslip.io",
    "https://109-123-248-16%2Esslip.io",
    "https://109-123-248-16.sslip.io;touch /tmp/pwned",
    "https://example.org",
  ])("rejects an unexpected or injection-shaped target: %s", async (baseUrl) => {
    let called = false;
    await expect(runL1({
      baseUrl,
      fetchImpl: async () => {
        called = true;
        return html();
      },
    })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it.each([
    "https://demo.example.kz",
    "https://triage.gov.example.kz",
    CANONICAL_BASE,
    "https://109-123-248-16.sslip.io",
    "https://109-123-248-16.nip.io",
  ])("accepts a normalized trusted production origin: %s", (origin) => {
    expect(validateProductionOrigin(origin)).toBe(origin);
  });

  it.each([
    "http://demo.example.kz",
    "https://demo.example.kz:443",
    "https://demo.example.kz/path",
    "https://user@demo.example.kz",
    "https://*.example.kz",
    "https://demo..example.kz",
    "https://-demo.example.kz",
    "https://demo-.example.kz",
    "https://109.123.248.17",
    "https://1.1.1.1",
    "https://127.1",
    "https://127.0.1",
    "https://10.1",
    "https://169.254",
    "https://192.168.1",
    "https://0x7f.0.0.1",
    "https://0x.1",
    "https://0x.999",
    "https://1.0x",
    "https://0x0.0x",
    "https://0xg.1",
    "https://00x1.1",
    "https://demo.1",
    "https://demo.0x",
    "https://10.0.0.1",
    "https://127.0.0.1",
    "https://169.254.1.1",
    "https://192.168.1.1",
    "https://[2001:db8::1]",
    "https://localhost",
    "https://xn--e1afmkfd.example",
    "https://демеу.example.kz",
    `https://${"a".repeat(64)}.example.kz`,
    `https://${Array.from({ length: 43 }, () => "aaaaa").join(".")}.kz`,
  ])("rejects an unsafe production origin: %s", (origin) => {
    expect(() => validateProductionOrigin(origin)).toThrow();
  });

  it("L2 drives all frozen scenarios, finalizes twice, and emits only sanitized summaries", async () => {
    const expectedOrigin = "https://demo.example.kz";
    const fixtureIds = [
      "scenario-1-chest-pain",
      "scenario-2-back-pain",
      "scenario-3-rhinitis",
    ] as const;
    const fixtures = fixtureIds.map((id) => JSON.parse(readFileSync(
      `tests/fixtures/transcripts/${id}.mock.json`,
      "utf8",
    )));
    const tokenToIndex = new Map<string, number>();
    const sessions = new Map<string, { index: number; turn: number; completed: boolean }>();
    let links = 0;
    let calls = 0;

    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      expect(init?.redirect).toBe("error");
      const requestUrl = new URL(String(input));
      expect(requestUrl.origin).toBe(expectedOrigin);
      const path = requestUrl.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path === "/api/healthz") return json({ ...health, llm_ok: true });
      if (path === "/api/link") {
        const index = links++;
        const token = `${index + 1}`.repeat(16);
        tokenToIndex.set(token, index);
        return json({ token });
      }
      if (path === "/api/chat/start") {
        const index = tokenToIndex.get(body.token)!;
        const sessionId = `session-${index + 1}`;
        sessions.set(sessionId, { index, turn: 0, completed: false });
        return json({ sessionId, reply: fixtures[index].messages[0].content, turnsLeft: 20 });
      }
      if (path === "/api/chat") {
        const session = sessions.get(body.sessionId)!;
        if (session.completed) return json({ code: "SESSION_COMPLETED" }, 409);
        session.turn += 1;
        const reply = fixtures[session.index].messages[session.turn * 2].content;
        if (session.index === 0) {
          session.completed = true;
          return json({ reply, done: true, turnsLeft: 19, result: fixtures[0].result });
        }
        return json({ reply, done: false, turnsLeft: 20 - session.turn });
      }
      if (path === "/api/chat/finalize") {
        const session = sessions.get(body.sessionId)!;
        const replayed = session.completed;
        session.completed = true;
        const result = fixtures[session.index].result;
        return json({ result, source: result.source, replayed });
      }
      throw new Error(`unexpected path ${path}`);
    };

    const result = await runL2({
      baseUrl: expectedOrigin,
      expectedOrigin,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.scenarios).toHaveLength(3);
    expect(result.scenarios[0]).toMatchObject({
      urgency: "emergency",
      finalize_replayed: true,
      evidence_verified: true,
    });
    expect(result.http_requests).toBe(calls);
    expect(calls).toBeLessThanOrEqual(result.http_request_cap);
    expect(result.anthropic_request_upper_bound).toBe(24);
    expect(result.client_retries).toBe(0);
    expect(result.telegram_delivery).toContain("not observable");
    const artifact = JSON.stringify(result);
    expect(artifact).not.toContain("session-");
    expect(artifact).not.toContain("1234567890abcdef");
    expect(artifact).not.toContain("боль в груди");
    expect(artifact).not.toContain("evidence\":");
  });

  it("stops L2 immediately on an unexpected HTTP failure", async () => {
    let calls = 0;
    await expect(runL2({
      baseUrl: CANONICAL_BASE,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return json({ ...health, llm_ok: true });
        return json({ code: "INTERNAL" }, 500);
      },
    })).rejects.toThrow("unexpected HTTP 500");
    expect(calls).toBe(2);
  });

  it("rejects malformed quote, disclaimer, restricted wording, and source/model matrices", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/transcripts/scenario-1-chest-pain.mock.json",
      "utf8",
    )) as { result: TriageResult; messages: ChatMessage[] };
    const mutate = (change: (result: TriageResult) => void) => {
      const result = structuredClone(fixture.result);
      change(result);
      return () => assertSmokeResult(result, fixture.messages);
    };
    expect(mutate((result) => { result.red_flags[0].evidence = "не было в сообщении"; })).toThrow("substring");
    expect(mutate((result) => { result.hypothesis.disclaimer = "Решает врач."; })).toThrow("mandatory");
    expect(mutate((result) => {
      result.hypothesis.text = `Подтверждён ${String.fromCodePoint(1076, 1080, 1072, 1075, 1085, 1086, 1079)}.`;
    })).toThrow("not negated");
    expect(mutate((result) => {
      result.source = "rules_only";
      result.hypothesis.confidence = 0;
    })).toThrow("contains model");
    expect(mutate((result) => {
      result.source = "model";
      result.model!.abstained = true;
    })).toThrow("abstained");
  });

  it("requires nullable integer severity and preserves explicit zero", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/transcripts/scenario-1-chest-pain.mock.json",
      "utf8",
    )) as { result: TriageResult; messages: ChatMessage[] };
    const withSeverity = (severity: unknown, present = true) => {
      const result = structuredClone(fixture.result) as TriageResult & {
        anamnesis: TriageResult["anamnesis"] & {
          symptom: TriageResult["anamnesis"]["symptom"] & Record<string, unknown>;
        };
      };
      if (present) result.anamnesis.symptom.severity = severity as number | null;
      else {
        delete (result.anamnesis.symptom as Partial<
          TriageResult["anamnesis"]["symptom"]
        >).severity;
      }
      return () => assertSmokeResult(result, fixture.messages);
    };

    expect(withSeverity(null)).not.toThrow();
    expect(withSeverity(0)).not.toThrow();
    expect(withSeverity(undefined, false)).toThrow("severity is missing");
    for (const invalid of ["5", Number.NaN, -1, 11, 0.5]) {
      expect(withSeverity(invalid)).toThrow(
        "severity must be null or an integer from 0 to 10",
      );
    }
  });

  it.each(["deploy/smoke-l1.sh", "deploy/smoke-scenarios.sh"])(
    "%s refuses to touch production without explicit opt-in",
    (script) => {
      const artifact = `/tmp/demeu-smoke-test-${process.pid}-${script.includes("l1") ? "l1" : "l2"}.json`;
      const result = spawnSync("bash", [script], {
        cwd: process.cwd(),
        env: { ...process.env, DEMEU_SMOKE_LIVE: "", SMOKE_ARTIFACT: artifact },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("opt-in is missing");
      expect(() => readFileSync(artifact)).toThrow();
    },
  );

  it("reserves the sanitized artifact exclusively before any network request", () => {
    const artifact = `/tmp/demeu-smoke-exclusive-${process.pid}.json`;
    writeFileSync(artifact, "owner\n", { mode: 0o600 });
    try {
      const result = spawnSync("bash", ["deploy/smoke-l1.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DEMEU_SMOKE_LIVE: "I_ACCEPT_PRODUCTION_SMOKE",
          BASE_URL: CANONICAL_BASE,
          SMOKE_ARTIFACT: artifact,
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/EEXIST|exist/iu);
      expect(readFileSync(artifact, "utf8")).toBe("owner\n");
    } finally {
      rmSync(artifact, { force: true });
    }
  });

  it("refuses a live run when Node TLS verification is disabled", () => {
    const artifact = `/tmp/demeu-smoke-tls-bypass-${process.pid}.json`;
    const result = spawnSync("bash", ["deploy/smoke-l1.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DEMEU_SMOKE_LIVE: "I_ACCEPT_PRODUCTION_SMOKE",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        BASE_URL: CANONICAL_BASE,
        SMOKE_ARTIFACT: artifact,
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("TLS certificate verification is disabled");
    expect(() => readFileSync(artifact)).toThrow();
  });

  it("rejects an injection-shaped artifact path before any network request", () => {
    const result = spawnSync("bash", ["deploy/smoke-l1.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DEMEU_SMOKE_LIVE: "I_ACCEPT_PRODUCTION_SMOKE",
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        BASE_URL: CANONICAL_BASE,
        SMOKE_ARTIFACT: "/tmp/demeu-smoke-$(touch pwned).json",
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("safe absolute .json path");
  });

  it("refuses an artifact path whose parent is a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "demeu-smoke-symlink-"));
    const protectedDir = join(root, "specimen-ai-assets");
    const linkedDir = join(root, "artifact-link");
    const artifact = join(linkedDir, "smoke.json");
    const preload = join(root, "offline-fetch.mjs");
    mkdirSync(protectedDir);
    symlinkSync(protectedDir, linkedDir, "dir");
    writeFileSync(
      preload,
      `let calls = 0;
globalThis.fetch = async (input) => {
  calls += 1;
  const path = new URL(String(input)).pathname;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  if (path === "/" || path.startsWith("/c/")) {
    return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  }
  if (path === "/api/healthz") {
    return json({ ok: true, commit: "offline", model_version: "lr-v1", llm_ok: false, processing_mode: "external_llm" });
  }
  if (path === "/api/link") return json({ token: "1234567890abcdef" });
  if (path === "/api/chat/start") return json({ code: "TOKEN_NOT_FOUND" }, 404);
  throw new Error("unexpected offline path");
};
`,
      { mode: 0o600 },
    );
    try {
      const result = spawnSync("bash", ["deploy/smoke-l1.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${resolve(preload)}`,
          DEMEU_SMOKE_LIVE: "I_ACCEPT_PRODUCTION_SMOKE",
          BASE_URL: CANONICAL_BASE,
          SMOKE_ARTIFACT: artifact,
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(join(protectedDir, "smoke.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps only a mode-0600 empty reservation after SIGINT and blocks reuse", () => {
    const root = mkdtempSync(join(tmpdir(), "demeu-smoke-sigint-"));
    const artifact = join(root, "interrupted.json");
    const preload = join(root, "hanging-fetch.mjs");
    writeFileSync(
      preload,
      "globalThis.fetch = async () => new Promise(() => setInterval(() => {}, 1000));\n",
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      NODE_OPTIONS: `--import=${resolve(preload)}`,
      DEMEU_SMOKE_LIVE: "I_ACCEPT_PRODUCTION_SMOKE",
      BASE_URL: CANONICAL_BASE,
      SMOKE_ARTIFACT_ROOT: root,
      SMOKE_ARTIFACT: artifact,
    };
    try {
      const interrupted = spawnSync(
        "timeout",
        ["--signal=INT", "1", "bash", "deploy/smoke-l1.sh"],
        { cwd: process.cwd(), env, encoding: "utf8" },
      );
      expect(interrupted.status).not.toBe(0);
      const reserved = statSync(artifact);
      expect(reserved.mode & 0o777).toBe(0o600);
      expect(reserved.size).toBe(0);

      const repeated = spawnSync("bash", ["deploy/smoke-l1.sh"], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
      });
      expect(repeated.status).not.toBe(0);
      expect(`${repeated.stdout}${repeated.stderr}`).toMatch(/EEXIST|exist/iu);
      expect(statSync(artifact).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs with the default artifact root in a fresh deploy-shaped checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "demeu-smoke-fresh-deploy-"));
    const deployDir = join(root, "deploy");
    const preload = join(root, "offline-fetch.mjs");
    mkdirSync(deployDir);
    copyFileSync("deploy/smoke.mjs", join(deployDir, "smoke.mjs"));
    copyFileSync("deploy/smoke-l1.sh", join(deployDir, "smoke-l1.sh"));
    writeFileSync(
      preload,
      `globalThis.fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  if (path === "/" || path.startsWith("/c/")) {
    return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  }
  if (path === "/api/healthz") {
    return json({ ok: true, commit: "offline", model_version: "lr-v1", llm_ok: false, processing_mode: "external_llm" });
  }
  if (path === "/api/link") return json({ token: "1234567890abcdef" });
  if (path === "/api/chat/start") return json({ code: "TOKEN_NOT_FOUND" }, 404);
  throw new Error("unexpected offline path");
};
`,
      { mode: 0o600 },
    );
    try {
      const result = spawnSync("bash", [join(deployDir, "smoke-l1.sh")], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${resolve(preload)}`,
          DEMEU_SMOKE_LIVE: "I_ACCEPT_PRODUCTION_SMOKE",
          BASE_URL: CANONICAL_BASE,
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(existsSync(join(root, "reports/live-e2e"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
