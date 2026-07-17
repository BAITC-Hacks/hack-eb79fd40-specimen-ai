import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APP_PORT = 43120;
const PROVIDER_PORT = 43121;
const COMMIT = "standalone-regression";
const KEY = `${["sk", "ant"].join("-")}-synthetic_standalone_health_key`;
const PROOF_HEADER = "x-demeu-health-proof";
const PROOF_CONTEXT = "demeu-health-extract:v1:";

const extraction = {
  anamnesis: {
    chief_complaint: "Боль в горле",
    symptom: {
      onset: "Второй день",
      location: "Горло",
      quality: "Больно глотать",
      severity: 5,
      modifiers: "",
      associated: ["Температура 38"],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: {
      age: null,
      sex: "unknown",
      pregnancy: "na",
      risk_factors: [],
    },
  },
  evidence: { evidences: [], age: null, sex: "unknown" },
  unmapped: ["Боль в горле", "Температура 38"],
};

function proof(commit) {
  return createHmac("sha256", KEY)
    .update(`${PROOF_CONTEXT}${commit}`)
    .digest("hex");
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function findStandaloneServer(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === "server.js") return path;
    if (entry.isDirectory()) {
      const nested = await findStandaloneServer(path);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function waitForApp(child) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`standalone exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/healthz`);
      if (response.status === 200) return;
    } catch {
      // Startup races are expected until the listener is ready.
    }
    await delay(100);
  }
  throw new Error("standalone health endpoint did not start");
}

function assertExactHealth(body, llmOk) {
  assert.deepEqual(Object.keys(body).sort(), ["commit", "llm_ok", "model_version", "ok"]);
  assert.equal(body.ok, true);
  assert.equal(body.commit, COMMIT);
  assert.equal(typeof body.model_version, "string");
  assert.equal(body.llm_ok, llmOk);
}

const interfaces = (await readdir("/sys/class/net")).sort();
assert.deepEqual(interfaces, ["lo"], "test must run inside a --network none container");

let providerCalls = 0;
const provider = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/messages") {
    response.writeHead(404).end();
    return;
  }
  providerCalls += 1;
  request.resume();
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "msg_synthetic_health",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: JSON.stringify(extraction) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
});

await listen(provider, PROVIDER_PORT);

let childOutput = "";
const serverPath = await findStandaloneServer("/workspace/.next/standalone");
assert.ok(serverPath, "Next standalone server.js was not built");
const child = spawn("node", ["server.js"], {
  cwd: dirname(serverPath),
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(APP_PORT),
    COMMIT_SHA: COMMIT,
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PROVIDER_PORT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    childOutput = `${childOutput}${chunk.toString()}`.slice(-12_000);
  });
}

try {
  await waitForApp(child);

  const shallow = await fetch(`http://127.0.0.1:${APP_PORT}/api/healthz`);
  assert.equal(shallow.status, 200);
  assertExactHealth(await shallow.json(), true);
  assert.equal(providerCalls, 0);

  const unauthorized = [
    ["missing", {}],
    ["wrong", { [PROOF_HEADER]: "wrong" }],
    ["stale", { [PROOF_HEADER]: proof("stale-commit") }],
    ["public-host", { host: "demo.example.kz" }],
    ["host-spoof", { host: "attacker.invalid" }],
    ["forwarded-spoof", {
      forwarded: "for=127.0.0.1;host=localhost;proto=http",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost",
      "x-forwarded-proto": "http",
    }],
    ["combined-spoof", {
      host: "demo.example.kz",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost",
      "x-forwarded-proto": "http",
      [PROOF_HEADER]: "wrong",
    }],
  ];

  for (const [label, headers] of unauthorized) {
    const response = await fetch(
      `http://127.0.0.1:${APP_PORT}/api/healthz?probe=extract`,
      { headers },
    );
    assert.equal(response.status, 404, label);
    assertExactHealth(await response.json(), false);
    assert.equal(providerCalls, 0, `${label} reached the provider`);
  }

  const authorizedHeaders = { [PROOF_HEADER]: proof(COMMIT) };
  const authorized = await fetch(
    `http://127.0.0.1:${APP_PORT}/api/healthz?probe=extract`,
    { headers: authorizedHeaders },
  );
  assert.equal(authorized.status, 200);
  assertExactHealth(await authorized.json(), true);
  assert.equal(providerCalls, 1);

  const cached = await fetch(
    `http://127.0.0.1:${APP_PORT}/api/healthz?probe=extract`,
    { headers: authorizedHeaders },
  );
  assert.equal(cached.status, 200);
  assertExactHealth(await cached.json(), true);
  assert.equal(providerCalls, 1, "process-lifetime cache made a second provider call");

  process.stdout.write("standalone deep-health security matrix: 9/9 green, provider calls: 1\n");
} catch (error) {
  const safeOutput = childOutput
    .replaceAll(KEY, "[redacted-key]")
    .replaceAll(proof(COMMIT), "[redacted-proof]")
    .replaceAll(proof("stale-commit"), "[redacted-proof]");
  if (safeOutput) process.stderr.write(safeOutput);
  throw error;
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(2_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await close(provider);
}
