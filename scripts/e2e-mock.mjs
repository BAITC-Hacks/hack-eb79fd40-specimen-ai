import { spawn } from "node:child_process";
import { access, mkdtemp, cp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes, scrypt } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { runDemoScenarios } from "./e2e.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ID = "e2e-doctor";
const WORKSPACE_PASSWORD = "E2eDoctor2026!";

function derivePassword(password, salt) {
  return new Promise((resolveKey, reject) => {
    scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 }, (error, key) => {
      if (error) reject(error);
      else resolveKey(key);
    });
  });
}

async function writeWorkspaceAccount(dataDir) {
  const salt = randomBytes(16);
  const hash = await derivePassword(WORKSPACE_PASSWORD, salt);
  const accountsFile = join(dataDir, "accounts.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(accountsFile, `${JSON.stringify({ accounts: [{
    id: WORKSPACE_ID,
    displayName: "E2E doctor",
    role: "doctor",
    organizationId: "e2e-organization",
    passwordHash: `scrypt$16384$8$1$${salt.toString("hex")}$${hash.toString("hex")}`,
    sessionVersion: 1,
  }] }, null, 2)}\n`, { mode: 0o600 });
  return accountsFile;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

export function snapshotFilter(source, root = ROOT) {
  const path = relative(root, source);
  if (!path) return true;
  const parts = path.split(sep);
  if ([".git", ".next", "node_modules", ".venv", ".orchestrator"].includes(parts[0])) {
    return false;
  }
  if (parts.some((part) => part.startsWith(".env") && part !== ".env.example")) {
    return false;
  }
  return !(parts[0] === "data" && ["raw", "processed", "runtime"].includes(parts[1]));
}

export function isolatedMockEnv(environment, guardImport) {
  const isolated = { ...environment, NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: guardImport };
  for (const key of [
    "ANTHROPIC_AUTH_TOKEN", "DOCTOR_ACCESS_CODE", "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_DOCTOR_CHAT_ID", "TELEGRAM_DOCTOR_CHAT_IDS",
    "DEMEU_DATA_DIR", "DEMEU_ACCOUNTS_FILE", "DEMEU_AUTH_SECRET",
  ]) delete isolated[key];
  return isolated;
}

async function assertSnapshotEnvIsolation(snapshot) {
  const paths = await readdir(snapshot, { recursive: true });
  const leaked = paths.filter((path) =>
    path.split(sep).some((part) => part.startsWith(".env") && part !== ".env.example"),
  );
  if (leaked.length > 0) {
    throw new Error(`Mock snapshot contains forbidden env files: ${leaked.join(", ")}`);
  }
  await access(join(snapshot, ".env.example"));
}

function spawnCaptured(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-30_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, output: () => output };
}

async function waitFor(url, processHandle, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Process exited before ${url}: ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

async function requireSuccessfulExit(processHandle, label) {
  const [code, signal] = await once(processHandle.child, "exit");
  if (code !== 0) {
    throw new Error(`${label} failed: code=${code} signal=${signal ?? "none"}`);
  }
}

async function main() {
  const snapshot = await mkdtemp(join(tmpdir(), "demeu-e2e-mock-"));
  const mockPort = await freePort();
  const appPort = await freePort();
  let build;
  let mock;
  let app;
  let failure;

  try {
    await cp(ROOT, snapshot, { recursive: true, filter: snapshotFilter });
    await assertSnapshotEnvIsolation(snapshot);
    await rm(join(snapshot, "node_modules"), { recursive: true, force: true });
    await symlink(join(ROOT, "node_modules"), join(snapshot, "node_modules"), "dir");

    const guardImport = `--import=${join(snapshot, "scripts/e2e-fetch-guard.mjs")}`;
    const isolatedEnv = isolatedMockEnv(process.env, guardImport);
    const dataDir = join(snapshot, ".e2e-runtime");
    const accountsFile = await writeWorkspaceAccount(dataDir);

    build = spawnCaptured(
      process.execPath,
      [join(snapshot, "node_modules/next/dist/bin/next"), "build"],
      { cwd: snapshot, env: isolatedEnv },
    );
    await requireSuccessfulExit(build, "Mock E2E production build");
    if (build.output().includes("E2E_EXTERNAL_FETCH_BLOCKED")) {
      throw new Error("Mock E2E build attempted an external network request");
    }

    mock = spawnCaptured(
      process.execPath,
      [join(snapshot, "scripts/mock-anthropic.mjs")],
      {
        cwd: snapshot,
        env: { ...process.env, MOCK_PORT: String(mockPort) },
      },
    );
    await waitFor(`http://127.0.0.1:${mockPort}/health`, mock.child);

    const appEnv = {
      ...isolatedEnv,
      ANTHROPIC_API_KEY: "local-mock-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
      APP_BASE_URL: `http://127.0.0.1:${appPort}`,
      DEMEU_ACCOUNTS_FILE: accountsFile,
      DEMEU_DATA_DIR: dataDir,
      DEMEU_AUTH_SECRET: randomBytes(32).toString("hex"),
      HOSTNAME: "127.0.0.1",
      PORT: String(appPort),
    };
    delete appEnv.ANTHROPIC_AUTH_TOKEN;
    delete appEnv.DOCTOR_ACCESS_CODE;
    delete appEnv.TELEGRAM_BOT_TOKEN;
    delete appEnv.TELEGRAM_DOCTOR_CHAT_ID;
    delete appEnv.TELEGRAM_DOCTOR_CHAT_IDS;
    app = spawnCaptured(
      process.execPath,
      [join(snapshot, ".next/standalone/server.js")],
      { cwd: snapshot, env: appEnv },
    );
    await waitFor(`http://127.0.0.1:${appPort}/api/healthz`, app.child);
    if (!app.output().includes("E2E_FETCH_GUARD_READY")) {
      throw new Error("Mock E2E external-fetch guard did not start");
    }
    if (process.env.E2E_FORCE_FAILURE === "1") {
      throw new Error("Forced mock E2E failure for cleanup verification");
    }

    await runDemoScenarios({
      baseUrl: `http://127.0.0.1:${appPort}`,
      fixtureDir: join(ROOT, "tests/fixtures/transcripts"),
      provenance: "mock",
      workspaceCredentials: { id: WORKSPACE_ID, password: WORKSPACE_PASSWORD },
    });
    if (app.output().includes("E2E_EXTERNAL_FETCH_BLOCKED")) {
      throw new Error("Mock E2E attempted an external network request");
    }
  } catch (error) {
    failure = error;
  } finally {
    await stopProcess(app?.child);
    await stopProcess(mock?.child);
    await rm(snapshot, { recursive: true, force: true });
  }

  if (failure) {
    if (build) process.stderr.write(`\n--- build log ---\n${build.output()}`);
    if (mock) process.stderr.write(`\n--- mock log ---\n${mock.output()}`);
    if (app) process.stderr.write(`\n--- app log ---\n${app.output()}`);
    throw failure;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  await main();
}
