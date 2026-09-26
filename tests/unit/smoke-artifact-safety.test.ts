import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BASE = "https://109-123-248-16.sslip.io";
const OPT_L1 = "I_ACCEPT_PRODUCTION_SMOKE";
const OPT_L2 = "I_AUTHORIZE_3_SCENARIOS_AND_UP_TO_24_ANTHROPIC_REQUESTS";
const PRIVATE_TOKEN = "feedfacecafebeef";
const PRIVATE_SESSION = "session-private-value";
const PRIVATE_BODY = "private-patient-response-body";

function runSmoke(
  level: "l1" | "l2",
  root: string,
  artifact: string,
  preload: string,
) {
  return spawnSync("bash", [`deploy/smoke-${level === "l1" ? "l1" : "scenarios"}.sh`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${resolve(preload)}`,
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
      DEMEU_SMOKE_LIVE: level === "l1" ? OPT_L1 : OPT_L2,
      BASE_URL: BASE,
      EXPECTED_PRODUCTION_ORIGIN: BASE,
      SMOKE_ARTIFACT_ROOT: root,
      SMOKE_ARTIFACT: artifact,
    },
    encoding: "utf8",
  });
}

function l1Preload(path: string, marker?: string): void {
  writeFileSync(
    path,
    `import { writeFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  ${marker ? `writeFileSync(${JSON.stringify(marker)}, "network-called");` : ""}
  const route = new URL(String(input)).pathname;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  if (route === "/workspace" || route.startsWith("/c/")) {
    return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  }
  if (route === "/api/healthz") return json({
    ok: true,
    commit: "0123456789abcdef0123456789abcdef01234567",
    model_version: "lr-v1",
    llm_ok: false,
    processing_mode: "external_llm",
  });
  if (route === "/api/link") return json({ token: ${JSON.stringify(PRIVATE_TOKEN)} });
  if (route === "/api/chat/start") return json({ code: "TOKEN_NOT_FOUND" }, 404);
  throw new Error("unexpected route");
};
`,
    { mode: 0o600 },
  );
}

describe("smoke artifact trust boundary", () => {
  it("owns only the default project-relative root and rejects unsafe existing default components", () => {
    const makeCheckout = (suffix: string) => {
      const checkout = mkdtempSync(join(tmpdir(), `demeu-smoke-default-${suffix}-`));
      const deploy = join(checkout, "deploy");
      const preload = join(checkout, "fetch.mjs");
      const marker = join(checkout, "network-called");
      mkdirSync(deploy, { mode: 0o700 });
      copyFileSync("deploy/smoke.mjs", join(deploy, "smoke.mjs"));
      copyFileSync("deploy/smoke-l1.sh", join(deploy, "smoke-l1.sh"));
      l1Preload(preload, marker);
      return { checkout, preload, marker };
    };
    const execute = ({ checkout, preload }: ReturnType<typeof makeCheckout>) =>
      spawnSync("bash", [join(checkout, "deploy/smoke-l1.sh")], {
        cwd: checkout,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${resolve(preload)}`,
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
          DEMEU_SMOKE_LIVE: OPT_L1,
          BASE_URL: BASE,
          EXPECTED_PRODUCTION_ORIGIN: BASE,
        },
        encoding: "utf8",
      });

    const fresh = makeCheckout("fresh");
    const linked = makeCheckout("linked");
    const nonDirectory = makeCheckout("file");
    const writable = makeCheckout("writable");
    try {
      expect(execute(fresh).status).toBe(0);
      const reports = join(fresh.checkout, "reports");
      const live = join(reports, "live-e2e");
      expect(statSync(reports).mode & 0o777).toBe(0o700);
      expect(statSync(live).mode & 0o777).toBe(0o700);
      const artifacts = readdirSync(live).filter((name) => name.endsWith(".json"));
      expect(artifacts).toHaveLength(1);
      expect(statSync(join(live, artifacts[0])).mode & 0o777).toBe(0o600);

      const linkedTarget = join(linked.checkout, "protected");
      mkdirSync(linkedTarget, { mode: 0o700 });
      symlinkSync(linkedTarget, join(linked.checkout, "reports"), "dir");
      expect(execute(linked).status).not.toBe(0);
      expect(existsSync(linked.marker)).toBe(false);

      writeFileSync(join(nonDirectory.checkout, "reports"), "not a directory", { mode: 0o600 });
      expect(execute(nonDirectory).status).not.toBe(0);
      expect(existsSync(nonDirectory.marker)).toBe(false);

      mkdirSync(join(writable.checkout, "reports"), { mode: 0o707 });
      chmodSync(join(writable.checkout, "reports"), 0o707);
      expect(execute(writable).status).not.toBe(0);
      expect(existsSync(writable.marker)).toBe(false);
    } finally {
      for (const current of [fresh, linked, nonDirectory, writable]) {
        rmSync(current.checkout, { recursive: true, force: true });
      }
    }
  });

  it("writes a successful sanitized artifact only inside an explicit safe root", () => {
    const root = mkdtempSync(join(tmpdir(), "demeu-smoke-safe-root-"));
    const artifact = join(root, "smoke.json");
    const preload = join(root, "fetch.mjs");
    l1Preload(preload);
    try {
      const result = runSmoke("l1", root, artifact, preload);
      expect(result.status).toBe(0);
      expect(statSync(artifact).mode & 0o777).toBe(0o600);
      const output = readFileSync(artifact, "utf8");
      expect(JSON.parse(output)).toMatchObject({ level: "L1", ok: true, http_requests: 5 });
      expect(output).not.toContain(PRIVATE_TOKEN);
      expect(`${result.stdout}${result.stderr}`).not.toContain(PRIVATE_TOKEN);
      expect(`${result.stdout}${result.stderr}`).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink at a deeper ancestor before network", () => {
    const root = mkdtempSync(join(tmpdir(), "demeu-smoke-deep-link-"));
    const first = join(root, "first");
    const protectedDir = join(root, "protected");
    const linked = join(first, "second");
    const artifact = join(linked, "smoke.json");
    const marker = join(root, "network-called");
    const preload = join(root, "fetch.mjs");
    mkdirSync(first);
    mkdirSync(protectedDir);
    symlinkSync(protectedDir, linked, "dir");
    l1Preload(preload, marker);
    try {
      const result = runSmoke("l1", root, artifact, preload);
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(protectedDir, "smoke.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit trusted root whenever a custom artifact path is supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "demeu-smoke-custom-root-required-"));
    const artifact = join(root, "smoke.json");
    const marker = join(root, "network-called");
    const preload = join(root, "fetch.mjs");
    l1Preload(preload, marker);
    try {
      const result = spawnSync("bash", ["deploy/smoke-l1.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${resolve(preload)}`,
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
          DEMEU_SMOKE_LIVE: OPT_L1,
          BASE_URL: BASE,
          EXPECTED_PRODUCTION_ORIGIN: BASE,
          SMOKE_ARTIFACT: artifact,
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(artifact)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a lone custom root before network or default artifact creation", () => {
    const root = mkdtempSync(join(tmpdir(), "demeu-smoke-lone-custom-root-"));
    const marker = join(root, "network-called");
    const preload = join(root, "fetch.mjs");
    l1Preload(preload, marker);
    try {
      const result = spawnSync("bash", ["deploy/smoke-l1.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${resolve(preload)}`,
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
          DEMEU_SMOKE_LIVE: OPT_L1,
          BASE_URL: BASE,
          EXPECTED_PRODUCTION_ORIGIN: BASE,
          SMOKE_ARTIFACT_ROOT: root,
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(root)).toEqual(["fetch.mjs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a final symlink, traversal, and world-writable trusted root before network", () => {
    const container = mkdtempSync(join(tmpdir(), "demeu-smoke-unsafe-root-"));
    const root = join(container, "root");
    const protectedFile = join(container, "protected.json");
    const preload = join(container, "fetch.mjs");
    const marker = join(container, "network-called");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(protectedFile, "owner\n", { mode: 0o600 });
    l1Preload(preload, marker);
    try {
      const finalLink = join(root, "final.json");
      symlinkSync(protectedFile, finalLink);
      const linked = runSmoke("l1", root, finalLink, preload);
      expect(linked.status).not.toBe(0);
      expect(readFileSync(protectedFile, "utf8")).toBe("owner\n");

      const escaped = runSmoke("l1", root, join(container, "escaped.json"), preload);
      expect(escaped.status).not.toBe(0);
      expect(existsSync(join(container, "escaped.json"))).toBe(false);

      rmSync(finalLink);
      chmodSync(root, 0o707);
      const writable = runSmoke("l1", root, join(root, "unsafe.json"), preload);
      expect(writable.status).not.toBe(0);
      expect(existsSync(join(root, "unsafe.json"))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("detects an ancestor swap before writing and never writes through the replacement symlink", () => {
    const container = mkdtempSync(join(tmpdir(), "demeu-smoke-swap-"));
    const root = join(container, "trusted");
    const moved = join(container, "moved");
    const protectedDir = join(container, "protected");
    const artifact = join(root, "smoke.json");
    const preload = join(container, "swap-fetch.mjs");
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(protectedDir, { mode: 0o700 });
    writeFileSync(
      preload,
      `import { renameSync, symlinkSync } from "node:fs";
let swapped = false;
globalThis.fetch = async (input) => {
  if (!swapped) {
    renameSync(${JSON.stringify(root)}, ${JSON.stringify(moved)});
    symlinkSync(${JSON.stringify(protectedDir)}, ${JSON.stringify(root)}, "dir");
    swapped = true;
  }
  const route = new URL(String(input)).pathname;
  if (route === "/") return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  throw new Error("stop after swap");
};
`,
      { mode: 0o600 },
    );
    try {
      const result = runSmoke("l1", root, artifact, preload);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(protectedDir, "smoke.json"))).toBe(false);
      expect(statSync(join(moved, "smoke.json")).size).toBe(0);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("rejects a hardlink added after reservation before writing artifact bytes", () => {
    const container = mkdtempSync(join(tmpdir(), "demeu-smoke-hardlink-race-"));
    const root = join(container, "trusted");
    const artifact = join(root, "smoke.json");
    const protectedFile = join(container, "protected.json");
    const preload = join(container, "hardlink-fetch.mjs");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(
      preload,
      `import { linkSync } from "node:fs";
let linked = false;
globalThis.fetch = async (input) => {
  if (!linked) {
    linkSync(${JSON.stringify(artifact)}, ${JSON.stringify(protectedFile)});
    linked = true;
  }
  const route = new URL(String(input)).pathname;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  if (route === "/" || route.startsWith("/c/")) {
    return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  }
  if (route === "/api/healthz") return json({
    ok: true,
    commit: "0123456789abcdef0123456789abcdef01234567",
    model_version: "lr-v1",
    llm_ok: false,
    processing_mode: "external_llm",
  });
  if (route === "/api/link") return json({ token: ${JSON.stringify(PRIVATE_TOKEN)} });
  if (route === "/api/chat/start") return json({ code: "TOKEN_NOT_FOUND" }, 404);
  throw new Error("unexpected route");
};
`,
      { mode: 0o600 },
    );
    try {
      const result = runSmoke("l1", root, artifact, preload);
      expect(result.status).not.toBe(0);
      expect(existsSync(protectedFile)).toBe(true);
      expect(statSync(protectedFile).size).toBe(0);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("rejects a hardlink added after the final path stat without writing bytes", () => {
    const container = mkdtempSync(join(tmpdir(), "demeu-smoke-hardlink-final-stat-"));
    const root = join(container, "trusted");
    const artifact = join(root, "smoke.json");
    const protectedFile = join(container, "protected.json");
    const preload = join(container, "hardlink-after-stat.mjs");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(
      preload,
      `import fs, { linkSync } from "node:fs";
const artifact = ${JSON.stringify(artifact)};
const protectedFile = ${JSON.stringify(protectedFile)};
const originalLstat = fs.promises.lstat.bind(fs.promises);
let linked = false;
fs.promises.lstat = async (path, ...args) => {
  const info = await originalLstat(path, ...args);
  if (!linked && String(path) === artifact) {
    linkSync(artifact, protectedFile);
    linked = true;
  }
  return info;
};
globalThis.fetch = async (input) => {
  const route = new URL(String(input)).pathname;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  if (route === "/" || route.startsWith("/c/")) {
    return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  }
  if (route === "/api/healthz") return json({
    ok: true,
    commit: "0123456789abcdef0123456789abcdef01234567",
    model_version: "lr-v1",
    llm_ok: false,
    processing_mode: "external_llm",
  });
  if (route === "/api/link") return json({ token: ${JSON.stringify(PRIVATE_TOKEN)} });
  if (route === "/api/chat/start") return json({ code: "TOKEN_NOT_FOUND" }, 404);
  throw new Error("unexpected route");
};
`,
      { mode: 0o600 },
    );
    try {
      const result = runSmoke("l1", root, artifact, preload);
      expect(existsSync(protectedFile)).toBe(true);
      expect(statSync(artifact).size).toBe(0);
      expect(statSync(protectedFile).size).toBe(0);
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("does not create the artifact through a root swapped after final validation", () => {
    const container = mkdtempSync(join(tmpdir(), "demeu-smoke-root-final-swap-"));
    const root = join(container, "trusted");
    const moved = join(container, "moved");
    const protectedDir = join(container, "protected");
    const artifact = join(root, "smoke.json");
    const preload = join(container, "root-swap-after-realpath.mjs");
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(protectedDir, { mode: 0o700 });
    writeFileSync(
      preload,
      `import fs, { renameSync, symlinkSync } from "node:fs";
const root = ${JSON.stringify(root)};
const moved = ${JSON.stringify(moved)};
const protectedDir = ${JSON.stringify(protectedDir)};
const originalRealpath = fs.promises.realpath.bind(fs.promises);
let rootCalls = 0;
let swapped = false;
fs.promises.realpath = async (path, ...args) => {
  const actual = await originalRealpath(path, ...args);
  if (!swapped && String(path) === root && ++rootCalls === 2) {
    renameSync(root, moved);
    symlinkSync(protectedDir, root, "dir");
    swapped = true;
  }
  return actual;
};
globalThis.fetch = async () => {
  throw new Error("network must not be reached");
};
`,
      { mode: 0o600 },
    );
    try {
      const result = runSmoke("l1", root, artifact, preload);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(protectedDir, "smoke.json"))).toBe(false);
      expect(existsSync(join(moved, "smoke.json"))).toBe(false);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });
});

describe("smoke failure artifact redaction", () => {
  const phases = ["link", "start", "chat", "finalize", "page"] as const;
  const modes = ["status", "nonjson", "timeout", "redirect", "oversize", "unexpected"] as const;

  it.each(phases.flatMap((phase) => modes.map((mode) => [phase, mode] as const)))(
    "%s/%s keeps dynamic request data out of artifact and console",
    (phase, mode) => {
      const root = mkdtempSync(join(tmpdir(), "demeu-smoke-redaction-"));
      const artifact = join(root, "failure.json");
      const preload = join(root, "fetch.mjs");
      const fixture = JSON.parse(readFileSync(
        "tests/fixtures/transcripts/scenario-1-chest-pain.mock.json",
        "utf8",
      ));
      const failureResponse = mode === "status"
        ? "new Response(JSON.stringify({ error: PRIVATE_BODY }), { status: 503, headers: { 'content-type': 'application/json' } })"
        : mode === "nonjson"
          ? "new Response(PRIVATE_BODY, { status: 200, headers: { 'content-type': 'text/plain' } })"
          : mode === "timeout"
            ? "Promise.reject(new DOMException(PRIVATE_BODY, 'TimeoutError'))"
            : mode === "redirect"
              ? "new Response(null, { status: 302, headers: { location: 'https://example.org/' + PRIVATE_BODY } })"
              : mode === "oversize"
                ? "new Response(PRIVATE_BODY.repeat(60000), { status: 200, headers: { 'content-type': 'application/json' } })"
                : "({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => Promise.reject(new Error(PRIVATE_BODY)) })";
      writeFileSync(
        preload,
        `const PRIVATE_BODY = ${JSON.stringify(PRIVATE_BODY)};
const phase = ${JSON.stringify(phase)};
const fail = () => ${failureResponse};
const result = ${JSON.stringify(fixture.result)};
globalThis.fetch = async (input) => {
  const route = new URL(String(input)).pathname;
  if (phase === "page" && route.startsWith("/c/")) return fail();
  if (phase !== "page" && route === "/api/" + phase.replace("start", "chat/start").replace("finalize", "chat/finalize")) return fail();
  if (route === "/") return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  if (route === "/api/healthz") return new Response(JSON.stringify({
    ok: true,
    commit: "0123456789abcdef0123456789abcdef01234567",
    model_version: "lr-v1",
    llm_ok: phase === "page" ? false : true,
    processing_mode: "external_llm",
  }), { headers: { "content-type": "application/json" } });
  if (route === "/api/link") return new Response(JSON.stringify({ token: ${JSON.stringify(PRIVATE_TOKEN)} }), { headers: { "content-type": "application/json" } });
  if (route === "/api/chat/start") return new Response(JSON.stringify({
    sessionId: ${JSON.stringify(PRIVATE_SESSION)},
    reply: ${JSON.stringify(fixture.messages[0].content)},
    turnsLeft: 20,
  }), { headers: { "content-type": "application/json" } });
  if (route === "/api/chat") return new Response(JSON.stringify({
    reply: ${JSON.stringify(fixture.messages[2].content)}, done: true, turnsLeft: 19, result,
  }), { headers: { "content-type": "application/json" } });
  if (route === "/api/chat/finalize") return new Response(JSON.stringify({ result, source: result.source, replayed: true }), { headers: { "content-type": "application/json" } });
  throw new Error(PRIVATE_BODY);
};
`,
        { mode: 0o600 },
      );
      try {
        const level = phase === "page" ? "l1" : "l2";
        const executed = runSmoke(level, root, artifact, preload);
        expect(executed.status).not.toBe(0);
        const output = readFileSync(artifact, "utf8");
        const payload = JSON.parse(output);
        expect(payload).toMatchObject({ level: level.toUpperCase(), ok: false });
        expect(payload.error).toMatch(/^[A-Z_]+$/);
        for (const privateValue of [PRIVATE_TOKEN, PRIVATE_SESSION, PRIVATE_BODY, "боль в груди"]) {
          expect(output).not.toContain(privateValue);
          expect(`${executed.stdout}${executed.stderr}`).not.toContain(privateValue);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
