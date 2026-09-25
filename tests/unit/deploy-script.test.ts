import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const sandboxes: string[] = [];

function syntheticAnthropicKey(suffix: string): string {
  return `${["sk", "ant"].join("-")}-${suffix}`;
}

const SYNTHETIC_KEY = syntheticAnthropicKey("synthetic_test_value_".repeat(3));
const DEEP_PROBE_AUTHORIZATION = "I_AUTHORIZE_ONE_STRUCTURED_EXTRACTION";

interface Sandbox {
  root: string;
  bin: string;
  log: string;
  state: string;
}

interface DeployResult {
  code: number;
  stdout: string;
  stderr: string;
}

function deployEnvironment(
  sandbox: Sandbox,
  extraEnv: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: `${sandbox.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: sandbox.root,
    LC_ALL: "C",
    NODE_ENV: "test",
    APP_DIR: sandbox.root,
    HEALTH_ATTEMPTS: "1",
    HEALTH_INTERVAL_SECONDS: "0",
    STUB_LOG: sandbox.log,
    STUB_STATE: sandbox.state,
    DEMEU_DEEP_PROBE: DEEP_PROBE_AUTHORIZATION,
    ...extraEnv,
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function definedEnv(
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "demeu-deploy-test-"));
  sandboxes.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const log = join(root, "commands.log");
  await Promise.all([
    mkdir(bin),
    mkdir(state),
    mkdir(join(root, "deploy")),
    writeFile(log, ""),
  ]);
  await writeFile(join(state, "commit"), "aaaaaaa\n");

  await Promise.all([
    copyFile("deploy/deploy.sh", join(root, "deploy/deploy.sh")),
    copyFile("deploy/tls.sh", join(root, "deploy/tls.sh")),
    copyFile("docker-compose.yml", join(root, "docker-compose.yml")),
    copyFile("deploy/compose.caddy.yml", join(root, "deploy/compose.caddy.yml")),
    copyFile("deploy/compose.workspace.yml", join(root, "deploy/compose.workspace.yml")),
    copyFile(
      "deploy/compose.new-server-ip.yml",
      join(root, "deploy/compose.new-server-ip.yml"),
    ),
    copyFile(
      "deploy/compose.host-proxy.yml",
      join(root, "deploy/compose.host-proxy.yml"),
    ),
  ]);
  await chmod(join(root, "deploy/tls.sh"), 0o755);

  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
set -eu
printf 'git %s\\n' "$*" >> "$STUB_LOG"
case "\${1-}:\${2-}" in
  ls-files:--error-unmatch) exit 1 ;;
  rev-parse:--short) cat "$STUB_STATE/commit" ;;
  rev-parse:--is-inside-work-tree) printf 'true\\n' ;;
  status:--porcelain) printf '%s' "\${STUB_DIRTY-}" ;;
  pull:*)
    [ "\${STUB_PULL_FAIL-0}" = 0 ] || exit 1
    printf '%s\\n' "\${STUB_TARGET_SHA:-bbbbbbb}" > "$STUB_STATE/commit"
    ;;
  log:*)
    if [ -n "\${STUB_HISTORY_SECRET-}" ]; then printf '%s\\n' "$STUB_HISTORY_SECRET"; fi
    ;;
  reset:*)
    for value in "$@"; do target="$value"; done
    printf '%s\\n' "$target" > "$STUB_STATE/commit"
    ;;
esac
`,
  );

  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh
set -eu
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
if [ "\${1-}" = image ]; then
  action="\${2-}"
  source="\${3-}"
  target="\${4-}"
  safe_source=$(printf '%s' "$source" | tr '/:' '__')
  safe_target=$(printf '%s' "$target" | tr '/:' '__')
  case "$action" in
    inspect) [ -f "$STUB_STATE/image_$safe_source" ] ;;
    tag)
      pair="$source->$target"
      [ "\${STUB_TAG_FAIL_PAIR-}" != "$pair" ] || exit 1
      touch "$STUB_STATE/image_$safe_target"
      ;;
  esac
  exit
fi
if [ "\${1-}" != compose ]; then exit 2; fi
shift
while [ "\${1-}" = -f ]; do shift 2; done
command="\${1-}"
shift || true
case "$command" in
  config)
    [ "\${STUB_CONFIG_FAIL-0}" = 0 ] || exit 1
    exit 0
    ;;
  build)
    [ "\${STUB_BUILD_FAIL-0}" = 0 ] || exit 1
    if [ -n "\${STUB_BUILD_READY-}" ]; then
      touch "$STUB_BUILD_READY"
      while [ ! -f "$STUB_BUILD_RELEASE" ]; do /bin/sleep 0.01; done
    fi
    touch "$STUB_STATE/image_demeu-app_latest"
    if [ "\${STUB_MUTATE_ENV-0}" != 0 ]; then printf '%s\\n' '# mutated' >> "$APP_DIR/.env"; fi
    exit 0
    ;;
  up)
    [ "\${STUB_UP_FAIL-0}" = 0 ] || exit 1
    touch "$STUB_STATE/running"
    exit 0
    ;;
  rm)
    rm -f "$STUB_STATE/running"
    exit 0
    ;;
  exec)
    if printf '%s' "$*" | grep -q 'demeu-workspace-health:v1' \
      && [ -n "\${STUB_WORKSPACE_HEALTH_FAIL_COMMIT-}" ] \
      && printf '%s' "$*" | grep -q "\${STUB_WORKSPACE_HEALTH_FAIL_COMMIT}"; then
      exit 1
    fi
    if printf '%s' "$*" | grep -q 'grep -c.*ANTHROPIC_API_KEY'; then
      printf '%s\\n' "\${STUB_ANTHROPIC_COUNT:-1}"
      exit 0
    fi
    if printf '%s' "$*" | grep -q 'demeu-health-extract:v1:'; then
      case "\${STUB_DEEP_HEALTH_MODE:-green}" in
        green) exit 0 ;;
        auth) printf '%s\n' 'auth_rejected status=404 elapsed_ms=7'; exit 1 ;;
        timeout) printf '%s\n' 'timeout status=0 elapsed_ms=210000'; exit 1 ;;
        *) printf '%s\n' 'extraction_failed status=200 elapsed_ms=11'; exit 1 ;;
      esac
    fi
    if printf '%s' "$*" | grep -q 'demeu-existing-health:v1'; then
      printf '%s' "\${STUB_CURRENT_PROCESSING_MODE:-external_llm}"
      exit 0
    fi
    if printf '%s' "$*" | grep -q 'demeu-deterministic-readiness:v1'; then
      [ "\${STUB_DETERMINISTIC_READY-1}" = 1 ]
      exit
    fi
    if [ "\${STUB_HEALTH_MODE-}" = candidate-red ] \
      && printf '%s' "$*" | grep -q "\${STUB_TARGET_SHA:-ccccccc}"; then
      exit 1
    fi
    exit 0
    ;;
esac
exit 2
`,
  );

  await writeFile(
    join(bin, "rsync"),
    `#!/bin/sh
set -eu
printf 'rsync %s\\n' "$*" >> "$STUB_LOG"
`,
  );
  await writeFile(
    join(bin, "ssh"),
    `#!/bin/sh
set -eu
printf 'ssh %s\\n' "$*" >> "$STUB_LOG"
`,
  );
  await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  await Promise.all(
    ["git", "docker", "rsync", "ssh", "sleep"].map((name) =>
      chmod(join(bin, name), 0o755),
    ),
  );

  return { root, bin, log, state };
}

function validEnv(branch = "branch-a-nginx", domain = "109-123-248-16.sslip.io"): string {
  return [
    `ANTHROPIC_API_KEY=${SYNTHETIC_KEY}`,
    "DEMEU_PROCESSING_MODE=external_llm",
    `DEMEU_DOMAIN=${domain}`,
    `APP_BASE_URL=https://${domain}`,
    "APP_PORT=3100",
    `TLS_BRANCH=${branch}`,
    "VPS_RECON_CONFIRMED=yes",
    "",
  ].join("\n");
}

async function runDeploy(
  sandbox: Sandbox,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<DeployResult> {
  const env = deployEnvironment(sandbox, extraEnv);
  try {
    const { stdout, stderr } = await execFile(
      "bash",
      [join(sandbox.root, "deploy/deploy.sh")],
      { cwd: sandbox.root, env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((sandbox) =>
      rm(sandbox, { recursive: true, force: true }),
    ),
  );
});

describe("deploy/deploy.sh", () => {
  it("keeps the deploy test source free of credential-like literals", async () => {
    const source = await readFile("tests/unit/deploy-script.test.ts", "utf8");
    const anthropicPattern = new RegExp(
      `${["sk", "ant"].join("-")}-[a-z0-9]`,
      "iu",
    );
    const telegramPattern = /bot[0-9]{8,}:/iu;

    expect(source).not.toMatch(anthropicPattern);
    expect(source).not.toMatch(telegramPattern);
  });

  it("declares a deployment lock and an interruption trap", async () => {
    const script = await readFile("deploy/deploy.sh", "utf8");

    expect(script).toMatch(/\bflock\b/u);
    expect(script).toMatch(/\btrap\b/u);
  });

  it("keeps workspace and ingress overlays on the current production profile", async () => {
    const sandbox = await makeSandbox();
    await writeFile(
      join(sandbox.root, ".env"),
      validEnv("branch-b-caddy", "84.247.161.211"),
    );

    const result = await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" });
    const commands = await readFile(sandbox.log, "utf8");
    const prefix = "docker compose -f docker-compose.yml -f deploy/compose.caddy.yml -f deploy/compose.workspace.yml -f deploy/compose.new-server-ip.yml";

    expect(result.code).toBe(0);
    expect(commands).toContain(`${prefix} config --quiet`);
    expect(commands).toContain(`${prefix} build --pull app`);
    expect(commands).toContain(`${prefix} up -d --remove-orphans`);
  });

  it("rejects a candidate when the workspace/auth health surface is unavailable", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());

    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "bbbbbbb",
      STUB_WORKSPACE_HEALTH_FAIL_COMMIT: "bbbbbbb",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("candidate health check failed");
    expect(commands).toContain("demeu-workspace-health:v1");
  });

  it("requires an exact one-shot paid-probe opt-in before Docker", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());

    const result = await runDeploy(sandbox, { DEMEU_DEEP_PROBE: "not-authorized" });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(DEEP_PROBE_AUTHORIZATION);
    expect(commands).not.toContain("docker ");
    expect(commands).not.toContain("demeu-health-extract:v1:");
  });

  it("orders the one-shot deep gate after shallow/env checks and before green markers", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());

    const result = await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" });
    const commands = await readFile(sandbox.log, "utf8");
    const shallow = commands.indexOf("const expected = process.argv[1]");
    const cardinality = commands.indexOf('grep -c "^ANTHROPIC_API_KEY="');
    const deep = commands.indexOf("demeu-health-extract:v1:");
    const green = commands.indexOf("docker image tag demeu-app:latest demeu-app:last-green");

    expect(result.code).toBe(0);
    expect(shallow).toBeGreaterThan(-1);
    expect(cardinality).toBeGreaterThan(shallow);
    expect(deep).toBeGreaterThan(cardinality);
    expect(green).toBeGreaterThan(deep);
    expect(commands.match(/demeu-health-extract:v1:/gu)).toHaveLength(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SYNTHETIC_KEY);
  });

  it("recovers after a red deep gate without invoking it during recovery", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const before = (await readFile(sandbox.log, "utf8")).length;

    const failed = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_DEEP_HEALTH_MODE: "red",
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);

    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(
      "deep extraction gate failed: extraction_failed status=200 elapsed_ms=11",
    );
    expect(failed.stderr).toContain("last green release is active");
    expect(commands.match(/demeu-health-extract:v1:/gu)).toHaveLength(1);
    expect(commands).toContain("docker image tag demeu-app:last-green demeu-app:latest");
    expect(`${failed.stdout}\n${failed.stderr}`).not.toContain(SYNTHETIC_KEY);
  });

  it("pins one fetch and an outer deadline beyond the structured timeout", async () => {
    const script = await readFile("deploy/deploy.sh", "utf8");
    const deepFunction = script.slice(
      script.indexOf("deep_extraction_probe()"),
      script.indexOf("read_sha_marker()"),
    );
    const timeout = Number(script.match(/DEEP_PROBE_TIMEOUT_MS=(\d+)/u)?.[1]);

    expect(timeout).toBeGreaterThan(180_000);
    expect(deepFunction.match(/fetch\(/gu)).toHaveLength(1);
    expect(deepFunction).toContain("x-demeu-health-proof");
    expect(deepFunction).not.toMatch(/console\.(?:log|info|warn|error)/u);
    expect(deepFunction).not.toContain("retry");
  });

  it.each([
    ["auth", "auth_rejected status=404 elapsed_ms=7"],
    ["timeout", "timeout status=0 elapsed_ms=210000"],
  ])("reports only safe deep-gate diagnostics for %s", async (mode, diagnostic) => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);

    const failed = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_DEEP_HEALTH_MODE: mode,
    });
    const output = `${failed.stdout}\n${failed.stderr}`;

    expect(failed.code).toBe(1);
    expect(output).toContain(`deep extraction gate failed: ${diagnostic}`);
    expect(output).not.toContain(SYNTHETIC_KEY);
    expect(output).not.toContain("x-demeu-health-proof");
  });

  it("rejects a concurrent run and accepts the stale lock inode after release", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    const ready = join(sandbox.root, "lock-ready");
    const release = join(sandbox.root, "lock-release");
    const lock = join(sandbox.root, ".deploy.lock");
    const holder = execFile("flock", [
      lock,
      "sh",
      "-c",
      `touch '${ready}'; while [ ! -f '${release}' ]; do /bin/sleep 0.01; done`,
    ]);
    await waitForFile(ready);

    const blocked = await runDeploy(sandbox);
    await writeFile(release, "release\n");
    await holder;
    const afterRelease = await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" });

    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("already running");
    expect(afterRelease.code).toBe(0);
  });

  it("recovers on TERM and releases the lock for the next deployment", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const ready = join(sandbox.root, "build-ready");
    const release = join(sandbox.root, "build-release");
    const child = spawn("bash", [join(sandbox.root, "deploy/deploy.sh")], {
      cwd: sandbox.root,
      env: deployEnvironment(sandbox, {
        STUB_TARGET_SHA: "ccccccc",
        STUB_BUILD_READY: ready,
        STUB_BUILD_RELEASE: release,
      }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await waitForFile(ready);
    child.kill("SIGTERM");
    await writeFile(release, "release\n");
    const interrupted = await completion;
    const next = await runDeploy(sandbox, { STUB_TARGET_SHA: "ddddddd" });
    const commands = await readFile(sandbox.log, "utf8");

    expect(interrupted).toMatchObject({ code: 143, signal: null });
    expect(stderr).toContain("interrupted by TERM");
    expect(`${stdout}\n${stderr}`).not.toContain(SYNTHETIC_KEY);
    expect(commands).toContain("docker image tag demeu-app:deploy-recovery demeu-app:last-green");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("ddddddd\n");
    expect(next.code).toBe(0);
  });

  it("fails closed before Docker when VPS reconnaissance is missing", async () => {
    const sandbox = await makeSandbox();
    await writeFile(
      join(sandbox.root, ".env"),
      validEnv().replace("VPS_RECON_CONFIRMED=yes\n", ""),
    );

    const result = await runDeploy(sandbox);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("reconnaissance is not confirmed");
    expect(await readFile(sandbox.log, "utf8")).not.toContain("docker ");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SYNTHETIC_KEY);
  });

  it("is repeatable, preserves .env, and verifies one Anthropic variable", async () => {
    const sandbox = await makeSandbox();
    const env = validEnv("branch-b-caddy");
    await writeFile(join(sandbox.root, ".env"), env);

    const first = await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" });
    const second = await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" });
    const commands = await readFile(sandbox.log, "utf8");

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(env);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(
      "bbbbbbb\n",
    );
    expect(commands.match(/git pull --ff-only --quiet origin main/gu)).toHaveLength(2);
    expect(commands.match(/docker .*build --pull app/gu)).toHaveLength(2);
    expect(commands.match(/docker .*up -d --remove-orphans/gu)).toHaveLength(2);
    expect(commands).toContain('grep -c "^ANTHROPIC_API_KEY="');
    expect(`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`).not.toContain(
      SYNTHETIC_KEY,
    );
  });

  it("accepts a custom FQDN only when APP_BASE_URL is its exact HTTPS origin", async () => {
    const accepted = await makeSandbox();
    await writeFile(
      join(accepted.root, ".env"),
      validEnv("branch-b-caddy", "demo.example.kz"),
    );
    expect((await runDeploy(accepted, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);

    const rejected = await makeSandbox();
    await writeFile(
      join(rejected.root, ".env"),
      validEnv("branch-b-caddy", "demo.example.kz").replace(
        "APP_BASE_URL=https://demo.example.kz",
        "APP_BASE_URL=https://other.example.kz",
      ),
    );
    const result = await runDeploy(rejected);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("APP_BASE_URL must exactly match");
    expect(await readFile(rejected.log, "utf8")).not.toContain("docker ");
  });

  it("accepts only the exact production IP on branch B and rejects branch A before Docker", async () => {
    const accepted = await makeSandbox();
    const ipEnv = validEnv("branch-b-caddy", "109.123.248.16");
    await writeFile(
      join(accepted.root, ".env"),
      ipEnv,
    );
    expect((await runDeploy(accepted, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const red = await runDeploy(accepted, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_HEALTH_MODE: "candidate-red",
    });
    expect(red.code).toBe(1);
    expect(red.stderr).toContain("last green release is active");
    expect(await readFile(join(accepted.root, ".env"), "utf8")).toBe(ipEnv);

    for (const branch of ["branch-a-nginx", "branch-a-caddy"]) {
      const rejected = await makeSandbox();
      await writeFile(
        join(rejected.root, ".env"),
        validEnv(branch, "109.123.248.16"),
      );
      const result = await runDeploy(rejected);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("requires TLS_BRANCH=branch-b-caddy");
      expect(await readFile(rejected.log, "utf8")).not.toContain("docker ");
    }
  });

  it("restores the last green image and exits one on a red candidate", async () => {
    const sandbox = await makeSandbox();
    const env = validEnv();
    await writeFile(join(sandbox.root, ".env"), env);
    const green = await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" });
    expect(green.code).toBe(0);

    const failed = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_HEALTH_MODE: "candidate-red",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("last green release is active");
    expect(commands).toContain("docker image tag demeu-app:last-green demeu-app:latest");
    expect(commands).toMatch(/up -d --no-build --force-recreate app/u);
    expect(commands).toContain("git reset --hard --quiet bbbbbbb");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("bbbbbbb\n");
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(env);
    expect(`${failed.stdout}\n${failed.stderr}`).not.toContain(SYNTHETIC_KEY);
  });

  it("restores the last green image, git state, and health after a build failure", async () => {
    const sandbox = await makeSandbox();
    const env = validEnv();
    await writeFile(join(sandbox.root, ".env"), env);
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const greenBefore = await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8");
    const prevBefore = await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8");

    const failed = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_BUILD_FAIL: "1",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(failed.code).toBe(1);
    expect(commands).toContain("docker image tag demeu-app:last-green demeu-app:latest");
    expect(commands.match(/docker image tag demeu-app:last-green demeu-app:deploy-recovery/gu)).toHaveLength(1);
    expect(commands).toContain("docker image tag demeu-app:deploy-recovery demeu-app:last-green");
    expect(commands).toMatch(/up -d --no-build --force-recreate app/u);
    expect(commands).toContain("git reset --hard --quiet bbbbbbb");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("bbbbbbb\n");
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(env);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(greenBefore);
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(prevBefore);
    const resetIndex = commands.lastIndexOf("git reset --hard --quiet bbbbbbb");
    const imageIndex = commands.lastIndexOf(
      "docker image tag demeu-app:deploy-recovery demeu-app:last-green",
    );
    const exactHealthIndex = commands.lastIndexOf("bbbbbbb");
    expect(resetIndex).toBeGreaterThan(-1);
    expect(imageIndex).toBeGreaterThan(resetIndex);
    expect(exactHealthIndex).toBeGreaterThan(imageIndex);
  });

  it("does not remove the old production when recovery-image snapshotting fails", async () => {
    const sandbox = await makeSandbox();
    const env = validEnv();
    await writeFile(join(sandbox.root, ".env"), env);
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const commandsBefore = await readFile(sandbox.log, "utf8");
    const greenBefore = await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8");
    const prevBefore = await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8");

    const failed = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_TAG_FAIL_PAIR: "demeu-app:latest->demeu-app:last-green",
    });
    const commands = await readFile(sandbox.log, "utf8");
    const failedCommands = commands.slice(commandsBefore.length);

    expect(failed.code).toBe(1);
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("bbbbbbb\n");
    expect(await readFile(join(sandbox.state, "running"), "utf8")).toBe("");
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(greenBefore);
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(prevBefore);
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(env);
    expect(failedCommands).not.toMatch(/build --pull app/u);
    expect(failedCommands).not.toMatch(/up -d/u);
    expect(failedCommands).not.toMatch(/rm -sf app/u);
    expect(failedCommands.match(/demeu-existing-health:v1/gu)).toHaveLength(2);
    expect(failedCommands.match(/\n\s+bbbbbbb external_llm\n/gu)).toHaveLength(1);
  });

  it("restores Git and markers when compose validation fails after pull", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const greenBefore = await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8");
    const prevBefore = await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8");

    const failed = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_CONFIG_FAIL: "1",
    });

    expect(failed.code).toBe(1);
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("bbbbbbb\n");
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(greenBefore);
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(prevBefore);
  });

  it("keeps the old production and marker contents when state writes fail", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const greenPath = join(sandbox.root, ".deploy_green_sha");
    const prevPath = join(sandbox.root, ".deploy_prev_sha");
    const greenBefore = await readFile(greenPath, "utf8");
    const prevBefore = await readFile(prevPath, "utf8");
    await Promise.all([chmod(greenPath, 0o444), chmod(prevPath, 0o444)]);

    const failed = await runDeploy(sandbox, { STUB_TARGET_SHA: "ccccccc" });
    await Promise.all([chmod(greenPath, 0o644), chmod(prevPath, 0o644)]);

    expect(failed.code).toBe(1);
    expect(await readFile(join(sandbox.state, "running"), "utf8")).toBe("");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("bbbbbbb\n");
    expect(await readFile(greenPath, "utf8")).toBe(greenBefore);
    expect(await readFile(prevPath, "utf8")).toBe(prevBefore);
  });

  it("fails before pull and Docker when the server worktree is dirty", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());

    const result = await runDeploy(sandbox, { STUB_DIRTY: " M deploy/deploy.sh\n" });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(commands).toContain("git status --porcelain");
    expect(commands).not.toContain("git pull");
    expect(commands).not.toContain("docker ");
  });

  it.each([
    "?? notes.txt\n",
    "!! ignored-output.bin\n",
    " M deploy/deploy.sh\n",
  ])("rejects a disallowed server worktree entry: %s", async (status) => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());

    const result = await runDeploy(sandbox, { STUB_DIRTY: status });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(commands).not.toContain("git pull");
    expect(commands).not.toContain("docker ");
  });

  it("allows only documented server-only state and excluded build/data directories", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    const allowed = [
      "!! .env",
      "?? .deploy.lock",
      "?? .deploy_green_sha",
      "?? .deploy_prev_sha",
      "!! .next/",
      "!! node_modules/",
      "!! tsconfig.tsbuildinfo",
      "!! data/raw/",
      "!! data/processed/",
      "",
    ].join("\n");

    const result = await runDeploy(sandbox, {
      STUB_DIRTY: allowed,
      STUB_TARGET_SHA: "bbbbbbb",
    });

    expect(result.code).toBe(0);
  });

  it("fails safely when fast-forward pull fails", async () => {
    const sandbox = await makeSandbox();
    const env = validEnv();
    await writeFile(join(sandbox.root, ".env"), env);

    const result = await runDeploy(sandbox, { STUB_PULL_FAIL: "1" });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(commands).toContain("git pull --ff-only --quiet origin main");
    expect(commands).not.toContain("docker ");
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(env);
  });

  it.each([
    { failure: { STUB_UP_FAIL: "1" }, label: "up" },
    { failure: { STUB_HEALTH_MODE: "candidate-red", STUB_TARGET_SHA: "ccccccc" }, label: "health" },
  ])("fails safely on first-deploy $label failure without inventing last-green", async ({ failure }) => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());

    const result = await runDeploy(sandbox, definedEnv(failure));
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(commands).toContain("docker compose -f docker-compose.yml -f deploy/compose.host-proxy.yml -f deploy/compose.workspace.yml rm -sf app");
    await expect(readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).rejects.toThrow();
  });

  it("protects server secrets and excludes raw/offline files in rsync mode", async () => {
    const sandbox = await makeSandbox();

    const result = await runDeploy(sandbox, {
      DEPLOY_MODE: "rsync",
      SERVER: "deployer@example.test",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(0);
    expect(commands).toContain("--filter=protect .env");
    expect(commands).toContain("--filter=protect .deploy.lock");
    expect(commands).toContain("--filter=protect .deploy_green_sha");
    expect(commands).toContain("--exclude=.env.*");
    expect(commands).toContain("--exclude=.deploy.lock");
    expect(commands).toContain("--exclude=data/raw/");
    expect(commands).toContain("--exclude=data/processed/");
    expect(commands).toContain("--exclude=scripts/");
    expect(commands).toContain("--exclude=tests/");
    expect(commands).toContain("--exclude=eval/");
    expect(commands).toContain("--exclude=reports/");
    expect(commands).toContain("--exclude=.venv/");
    expect(commands).toContain("--exclude=*.csv");
    expect(commands).toContain("--exclude=*.parquet");
    expect(commands).toContain("--exclude=*.zip");
    expect(commands).toContain("--exclude=*.npy");
    expect(commands).toContain("--exclude=*.npz");
    expect(commands).toContain("--exclude=*.pkl");
    expect(commands).toContain("--exclude=*.joblib");
    expect(commands).toContain("--exclude=*.bin");
    expect(commands).toContain("ssh -- deployer@example.test");
    expect(commands).toContain("--activate-rsync 'aaaaaaa'");
  });

  it.each(["0", "2"])(
    "rolls back when the container has %s Anthropic variables",
    async (count) => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    const green = await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" });
    expect(green.code).toBe(0);

    const duplicate = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_ANTHROPIC_COUNT: count,
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("exactly one ANTHROPIC_API_KEY");
    expect(commands).toContain("docker image tag demeu-app:last-green demeu-app:latest");
    expect(commands).toMatch(/up -d --no-build --force-recreate app/u);
    },
  );

  it("deploys deterministic mode without a key or deep Anthropic probe", async () => {
    const sandbox = await makeSandbox();
    const env = validEnv()
      .replace(/^ANTHROPIC_API_KEY=.*\n/mu, "")
      .replace("DEMEU_PROCESSING_MODE=external_llm", "DEMEU_PROCESSING_MODE=deterministic");
    await writeFile(join(sandbox.root, ".env"), env);

    const result = await runDeploy(sandbox, {
      DEMEU_DEEP_PROBE: "",
      STUB_TARGET_SHA: "bbbbbbb",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(0);
    expect(commands).not.toContain('grep -c "^ANTHROPIC_API_KEY="');
    expect(commands).not.toContain("demeu-health-extract:v1:");
    expect(commands).toContain("demeu-deterministic-readiness:v1");
    expect(commands).toContain("bbbbbbb deterministic");
  });

  it.each([
    ["external_llm", "deterministic"],
    ["deterministic", "external_llm"],
  ])("validates the running %s release independently before activating %s", async (currentMode, desiredMode) => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const desired = desiredMode === "deterministic"
      ? validEnv().replace(/^ANTHROPIC_API_KEY=.*\n/mu, "").replace("external_llm", "deterministic")
      : validEnv();
    await writeFile(join(sandbox.root, ".env"), desired);

    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_CURRENT_PROCESSING_MODE: currentMode,
    });
    const commands = await readFile(sandbox.log, "utf8");
    expect(result.code).toBe(0);
    expect(commands).toContain("demeu-existing-health:v1");
    expect(commands).toContain(`ccccccc ${desiredMode}`);
  });

  it("fails deterministic activation when the provider-free readiness gate is red", async () => {
    const sandbox = await makeSandbox();
    await writeFile(
      join(sandbox.root, ".env"),
      validEnv().replace(/^ANTHROPIC_API_KEY=.*\n/mu, "").replace("external_llm", "deterministic"),
    );
    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "bbbbbbb",
      STUB_DETERMINISTIC_READY: "0",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("deterministic readiness gate failed");
  });

  it("rejects an invalid processing mode before Docker mutation", async () => {
    const sandbox = await makeSandbox();
    await writeFile(
      join(sandbox.root, ".env"),
      validEnv().replace("DEMEU_PROCESSING_MODE=external_llm", "DEMEU_PROCESSING_MODE=local"),
    );

    const result = await runDeploy(sandbox);
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DEMEU_PROCESSING_MODE");
    expect(commands).not.toContain("docker ");
  });

  it("restores last green when .env changes during activation", async () => {
    const sandbox = await makeSandbox();
    const env = validEnv();
    await writeFile(join(sandbox.root, ".env"), env);
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);

    const changed = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_MUTATE_ENV: "1",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain(".env changed during deployment");
    expect(commands).toContain("docker image tag demeu-app:last-green demeu-app:latest");
    expect(commands).toMatch(/up -d --no-build --force-recreate app/u);
  });

  it("rejects placeholders and history secrets without printing their values", async () => {
    const sandbox = await makeSandbox();
    const placeholder = syntheticAnthropicKey(`REPLACE_${"x".repeat(45)}`);
    await writeFile(
      join(sandbox.root, ".env"),
      validEnv().replace(SYNTHETIC_KEY, placeholder),
    );

    const placeholderResult = await runDeploy(sandbox);
    expect(placeholderResult.code).toBe(1);
    expect(`${placeholderResult.stdout}${placeholderResult.stderr}`).not.toContain(placeholder);

    const historySecret = syntheticAnthropicKey("history_sentinel_".repeat(3));
    const historyResult = await runDeploy(sandbox, {
      DEPLOY_MODE: "rsync",
      SERVER: "deployer@example.test",
      STUB_HISTORY_SECRET: historySecret,
    });
    expect(historyResult.code).toBe(1);
    expect(`${historyResult.stdout}${historyResult.stderr}`).not.toContain(historySecret);
    expect(historyResult.stderr).toContain("git history contains");
  });

  it.each([
    {
      label: "missing Anthropic key",
      env: validEnv().replace(/^ANTHROPIC_API_KEY=.*\n/mu, ""),
    },
    {
      label: "duplicated Anthropic key",
      env: `${validEnv()}ANTHROPIC_API_KEY=${SYNTHETIC_KEY}\n`,
    },
    {
      label: "missing TLS branch",
      env: validEnv().replace(/^TLS_BRANCH=.*\n/mu, ""),
    },
    {
      label: "duplicated TLS branch",
      env: `${validEnv()}TLS_BRANCH=branch-b-caddy\n`,
    },
  ])("fails closed on $label without printing values", async ({ env }) => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), env);

    const result = await runDeploy(sandbox);

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SYNTHETIC_KEY);
  });

  it.each([
    { APP_DIR: "/tmp/demeu;touch-injected" },
    { BRANCH: "main;touch-injected" },
    { DEPLOY_MODE: "git;touch-injected" },
    { DEPLOY_MODE: "rsync", SERVER: "root@example.test;touch-injected" },
  ])("rejects shell metacharacters before external mutation: %j", async (badEnv) => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());

    const result = await runDeploy(sandbox, definedEnv(badEnv));
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(commands).not.toContain("docker ");
    expect(commands).not.toContain("rsync ");
    expect(commands).not.toContain("ssh ");
  });
});
