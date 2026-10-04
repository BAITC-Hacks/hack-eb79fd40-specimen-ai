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
const PREPARED_IMAGE = `sha256:${"d".repeat(64)}`;

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
    copyFile("deploy/recovery-guards.sh", join(root, "deploy/recovery-guards.sh")),
    copyFile("deploy/validate-mis-credentials.cjs", join(root, "deploy/validate-mis-credentials.cjs")),
    copyFile("deploy/compose.mis.yml", join(root, "deploy/compose.mis.yml")),
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
  rev-parse:--short)
    if [ "\${3-}" = HEAD ] || [ "\${3+x}" != x ]; then cat "$STUB_STATE/commit"; else printf '%.7s\\n' "$3"; fi
    ;;
  rev-parse:--verify)
    value=$(printf '%.7s' "$3")
    case "$value" in
      aaaaaaa) printf '%040d\\n' 0 | tr 0 a ;;
      bbbbbbb) printf '%040d\\n' 0 | tr 0 b ;;
      ccccccc) printf '%040d\\n' 0 | tr 0 c ;;
      *) exit 1 ;;
    esac
    ;;
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
  show:*) printf '%s\\n' "\${STUB_SOURCE_SCHEMA:-2}" ;;
esac
`,
  );

  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh
set -eu
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
if [ "\${1-}" = run ]; then
  mounted=""
  while [ "\${1-}" != -e ]; do
    if [ "\${1-}" = --mount ]; then
      mounted="\${2#type=bind,src=}"
      mounted="\${mounted%%,dst=*}"
    fi
    shift
  done
  shift
  code="$1"
  shift
  if printf '%s' "$code" | grep -q 'demeu-recovery-marker-absent:v1'; then
    [ "\${STUB_CURRENT_MARKER_PRESENT-0}" = 0 ]
    exit
  fi
  if printf '%s' "$code" | grep -q 'demeu-recovery-marker:v1'; then
    [ "\${STUB_PREPARED_SCHEMA_MISSING-0}" = 0 ] || exit 1
    printf '%s' "\${STUB_PREPARED_SCHEMA:-2}"
    exit 0
  fi
  if printf '%s' "$code" | grep -q 'demeu-recovery-layer:v1'; then
    work="$STUB_STATE/layer-work"
    base_app="$STUB_STATE/base-app"
    rm -rf "$work"
    mkdir -p "$work" "$base_app"
    chmod "\${STUB_BASE_APP_MODE:-755}" "$base_app"
    exec node -e "$code" "$mounted" "$work" "\${3-}" "$base_app"
  fi
  if printf '%s' "$code" | grep -q 'demeu-recovery-schema:v1'; then
    marker="$STUB_STATE/schema-marker"
    [ "\${STUB_RECOVERY_SCHEMA_MISSING-0}" = 0 ] || exit 1
    printf '%s\\n' "\${STUB_RECOVERY_SCHEMA:-6}" > "$marker"
    [ -z "\${STUB_CONTAINER_MOUNT_SOURCE-}" ] || mounted="$STUB_CONTAINER_MOUNT_SOURCE"
    exec node -e "$code" "$marker" "$mounted" "\${3-}"
  fi
  if printf '%s' "$code" | grep -q 'demeu-mis-file:v1'; then
    [ "\${STUB_MIS_UNREADABLE-0}" = 0 ] || exit 1
    exec node -e "$code" "$mounted"
  fi
  exit 2
fi
if [ "\${1-}" = inspect ] && [ "\${2-}" = --format ] && [ "\${3-}" = '{{.Image}}' ]; then
  printf '%s\\n' "\${STUB_RUNNING_IMAGE_ID:-sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee}"
  exit 0
fi
if [ "\${1-}" = image ] && [ "\${2-}" = inspect ] && [ "\${3-}" = --format ]; then
  format="$4"
  ref="$5"
  safe_ref=$(printf '%s' "$ref" | tr '/:' '__')
  prepared="\${STUB_PREPARED_IMAGE_ID:-sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd}"
  case "$format" in
    '{{.Id}}')
      if [ -f "$STUB_STATE/image_id_$safe_ref" ]; then cat "$STUB_STATE/image_id_$safe_ref"
      elif [ "$ref" = "$prepared" ]; then printf '%s\\n' "$prepared"
      else printf '%s\\n' 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; fi
      ;;
    '{{range .Config.Env}}{{println .}}{{end}}') printf 'COMMIT_SHA=%s\\n' "\${STUB_IMAGE_COMMIT:-bbbbbbb}" ;;
    '{{json .Config}}')
      if [ "$ref" = "$prepared" ] && [ "\${STUB_PREPARED_CONFIG_MISMATCH-0}" != 0 ]; then printf '%s\\n' '{"User":"wrong"}'
      else printf '%s\\n' '{"User":"nextjs","Env":["COMMIT_SHA=bbbbbbb"]}'; fi
      ;;
    '{{join .RootFS.Layers "\\n"}}')
      printf '%s\\n' \
        'sha256:1111111111111111111111111111111111111111111111111111111111111111' \
        'sha256:2222222222222222222222222222222222222222222222222222222222222222'
      if [ "$ref" = "$prepared" ]; then
        [ "\${STUB_ROOTFS_LAYER_LIST_INVALID-0}" = 0 ] || printf '\\n'
        printf '%s\\n' 'sha256:3333333333333333333333333333333333333333333333333333333333333333'
      fi
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [ "\${1-}" = image ]; then
  action="\${2-}"
  source="\${3-}"
  target="\${4-}"
  safe_source=$(printf '%s' "$source" | tr '/:' '__')
  safe_target=$(printf '%s' "$target" | tr '/:' '__')
  case "$action" in
    inspect) [ -f "$STUB_STATE/image_$safe_source" ] ;;
    save)
      archive_root="$STUB_STATE/archive-root"
      layer_root="$STUB_STATE/layer-root"
      rm -rf "$archive_root" "$layer_root"
      mkdir -p "$archive_root" "$layer_root/app"
      chmod 755 "$layer_root/app"
      printf '%s\\n' "\${STUB_PREPARED_LAYER_CONTENT:-2}" > "$layer_root/app/referral-schema-version"
      case "\${STUB_PREPARED_LAYER_MODE:-buildkit}" in
        buildkit) entries='app' ;;
        valid) entries='app/referral-schema-version' ;;
        extra) printf 'extra\\n' > "$layer_root/extra"; entries='app/referral-schema-version extra' ;;
        whiteout) : > "$layer_root/app/.wh.server.js"; entries='app/referral-schema-version app/.wh.server.js' ;;
        *) exit 1 ;;
      esac
      case "\${STUB_PREPARED_LAYER_COMPRESSION:-gzip}" in
        gzip) tar -czf "$archive_root/layer.tar" -C "$layer_root" $entries ;;
        raw) tar -cf "$archive_root/layer.tar" -C "$layer_root" $entries ;;
        unknown) printf 'not-a-supported-layer-archive' > "$archive_root/layer.tar" ;;
        *) exit 1 ;;
      esac
      printf '%s\\n' '[{"Layers":["layer.tar"]}]' > "$archive_root/manifest.json"
      tar -cf "$target" -C "$archive_root" manifest.json layer.tar
      ;;
    tag)
      pair="$source->$target"
      [ "\${STUB_TAG_FAIL_PAIR-}" != "$pair" ] || exit 1
      touch "$STUB_STATE/image_$safe_target"
      if printf '%s' "$source" | grep -q '^sha256:'; then printf '%s\\n' "$source" > "$STUB_STATE/image_id_$safe_target"
      elif [ -f "$STUB_STATE/image_id_$safe_source" ]; then cat "$STUB_STATE/image_id_$safe_source" > "$STUB_STATE/image_id_$safe_target"
      else printf '%s\\n' 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' > "$STUB_STATE/image_id_$safe_target"; fi
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
    if [ -n "\${STUB_MIGRATE_SCHEMA-}" ] && [ ! -f "$STUB_STATE/migrated" ]; then
      printf '{"schemaVersion":%s,"referrals":[],"links":[],"commands":[]}\\n' "$STUB_MIGRATE_SCHEMA" > "$STUB_SNAPSHOT_FILE"
      touch "$STUB_STATE/migrated"
    fi
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
  args: readonly string[] = [],
): Promise<DeployResult> {
  const env = deployEnvironment(sandbox, extraEnv);
  try {
    const { stdout, stderr } = await execFile(
      "bash",
      [join(sandbox.root, "deploy/deploy.sh"), ...args],
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

async function prepareLegacyProduction(
  sandbox: Sandbox,
  schemaVersion = 2,
  extraEnv = "",
): Promise<{ data: string; before: number }> {
  await writeFile(join(sandbox.root, ".env"), validEnv());
  expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
  const data = join(sandbox.root, "prepared-recovery-data");
  await mkdir(data);
  await writeFile(join(data, "referrals.json"), JSON.stringify({ schemaVersion, referrals: [], links: [], commands: [] }));
  await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_DATA_DIR=${data}\n${extraEnv}`);
  return { data, before: (await readFile(sandbox.log, "utf8")).length };
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
    expect(commands).toContain("docker image tag sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee demeu-app:last-green");
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
    expect(commands).toContain("docker image tag sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee demeu-app:last-green");
    expect(commands).toMatch(/up -d --no-build --force-recreate app/u);
    expect(commands).toContain("git reset --hard --quiet bbbbbbb");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("bbbbbbb\n");
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(env);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(greenBefore);
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(prevBefore);
    const resetIndex = commands.lastIndexOf("git reset --hard --quiet bbbbbbb");
    const imageIndex = commands.lastIndexOf(
      "docker image tag sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee demeu-app:last-green",
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
    expect(commands).toContain("--filter=protect .git");
    expect(commands).toContain("--exclude=.env.*");
    expect(commands).toContain("--exclude=.deploy.lock");
    expect(commands).toContain("--exclude=.git ");
    expect(commands).toContain("--exclude=.git/");
    expect(commands).toContain("--exclude=data/raw/");
    expect(commands).toContain("--exclude=data/processed/");
    expect(commands).toContain("--exclude=scripts/");
    expect(commands).toContain("--exclude=tests/");
    expect(commands).toContain("--include=/eval/report.json");
    expect(commands).toContain("--exclude=/eval/***");
    expect(commands).toContain("--include=/reports/redflags/redflags-benchmark-v1.json");
    expect(commands).toContain("--include=/reports/referral-refusal-baseline-v0.json");
    expect(commands).toContain("--include=/reports/wait-time-baseline-v0.json");
    expect(commands).toContain("--include=/reports/lab-load-v1.json");
    expect(commands).toContain("--exclude=/reports/***");
    expect(commands.indexOf("--include=/eval/")).toBeLessThan(commands.indexOf("--include=/eval/report.json"));
    expect(commands.indexOf("--include=/eval/report.json")).toBeLessThan(commands.indexOf("--exclude=/eval/***"));
    expect(commands.indexOf("--include=/reports/")).toBeLessThan(commands.indexOf("--include=/reports/redflags/"));
    expect(commands.indexOf("--include=/reports/redflags/")).toBeLessThan(commands.indexOf("--include=/reports/redflags/redflags-benchmark-v1.json"));
    for (const allowedReport of [
      "--include=/reports/redflags/redflags-benchmark-v1.json",
      "--include=/reports/referral-refusal-baseline-v0.json",
      "--include=/reports/wait-time-baseline-v0.json",
      "--include=/reports/lab-load-v1.json",
    ]) {
      expect(commands.indexOf(allowedReport)).toBeLessThan(commands.indexOf("--exclude=/reports/***"));
    }
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
  it.each(["2", "7", "garbage"])("blocks a pre-mutation incompatible/malformed recovery marker %s without activating a candidate", async (marker) => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const data = join(sandbox.root, "workspace-data"); await mkdir(data);
    await writeFile(join(data, "referrals.json"), '{"schemaVersion":6,"referrals":[]}');
    await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_DATA_DIR=${data}\n`);
    const before = await readFile(sandbox.log, "utf8");
    const failed = await runDeploy(sandbox, { STUB_TARGET_SHA: "ccccccc", STUB_RECOVERY_SCHEMA: marker });
    const mutations = (await readFile(sandbox.log, "utf8")).slice(before.length);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("saved recovery image cannot read current persistent state");
    expect(mutations).not.toMatch(/docker .* build|docker .* up/u);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe("bbbbbbb\n");
  });

  it("checks rootless state inside the exact image instead of treating host EACCES as absence", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const containerData = join(sandbox.root, "container-visible-data");
    await mkdir(containerData);
    await writeFile(join(containerData, "referrals.json"), '{"schemaVersion":6,"referrals":[]}');
    await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_DATA_DIR=/rootless-private/data\n`);
    const before = await readFile(sandbox.log, "utf8");
    const failed = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_RECOVERY_SCHEMA: "2",
      STUB_CONTAINER_MOUNT_SOURCE: containerData,
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before.length);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("saved recovery image cannot read current persistent state");
    expect(commands).toContain("src=/rootless-private/data,dst=/state,readonly");
    expect(commands).not.toMatch(/docker .* build|docker .* up/u);
  });

  it("uses an exact marker-only child of the proven running image as first-boundary recovery", async () => {
    const sandbox = await makeSandbox();
    const { before } = await prepareLegacyProduction(sandbox);
    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_RECOVERY_SCHEMA: "2",
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "bbbbbbb",
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code, `${result.stderr}\n${commands}`).toBe(0);
    expect(commands).toContain(`docker image tag ${PREPARED_IMAGE} demeu-app:deploy-recovery`);
    expect(commands).toContain("demeu-recovery-marker-absent:v1");
    expect(commands).toContain("demeu-recovery-marker:v1");
    expect(commands).toContain("demeu-recovery-layer:v1");
    expect(commands.indexOf(`docker image tag ${PREPARED_IMAGE} demeu-app:deploy-recovery`))
      .toBeLessThan(commands.indexOf("docker compose -f docker-compose.yml" + " -f deploy/compose.host-proxy.yml -f deploy/compose.workspace.yml build --pull app"));
  });

  it("runs the real prepared provenance/state/MIS preflight without tag, build or activation", async () => {
    const sandbox = await makeSandbox();
    const { before } = await prepareLegacyProduction(sandbox);
    const result = await runDeploy(sandbox, {
      STUB_RECOVERY_SCHEMA: "2",
      STUB_PREPARED_LAYER_COMPRESSION: "raw",
      STUB_PREPARED_LAYER_MODE: "valid",
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "bbbbbbb",
    }, ["--check-prepared-recovery"]);
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("prepared recovery preflight passed");
    expect(commands).toContain("demeu-recovery-layer:v1");
    expect(commands).toContain("src=" + join(sandbox.root, "prepared-recovery-data") + ",dst=/state,readonly");
    expect(commands).not.toMatch(/docker image tag|docker .* build|docker .* up/u);
  });

  it("fails prepared-only preflight on tampered layer without any runtime mutation", async () => {
    const sandbox = await makeSandbox();
    const { before } = await prepareLegacyProduction(sandbox);
    const result = await runDeploy(sandbox, {
      STUB_PREPARED_LAYER_MODE: "extra",
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "bbbbbbb",
    }, ["--check-prepared-recovery"]);
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("prepared recovery image provenance is invalid");
    expect(commands).not.toMatch(/docker image tag|docker .* build|docker .* up/u);
  });

  it.each([
    ["current image already has a marker", { STUB_CURRENT_MARKER_PRESENT: "1" }],
    ["running image differs from latest", { STUB_RUNNING_IMAGE_ID: `sha256:${"f".repeat(64)}` }],
    ["prepared rootfs contains an internal blank layer entry", { STUB_ROOTFS_LAYER_LIST_INVALID: "1" }],
    ["extra layer path is present", { STUB_PREPARED_LAYER_MODE: "extra" }],
    ["whiteout is present", { STUB_PREPARED_LAYER_MODE: "whiteout" }],
    ["parent directory metadata differs from base", { STUB_BASE_APP_MODE: "700" }],
    ["marker layer content differs", { STUB_PREPARED_LAYER_CONTENT: "3" }],
    ["layer compression is unsupported", { STUB_PREPARED_LAYER_COMPRESSION: "unknown" }],
    ["prepared config differs from the running image", { STUB_PREPARED_CONFIG_MISMATCH: "1" }],
    ["prepared source marker differs", { STUB_PREPARED_SCHEMA: "3" }],
  ])("rejects prepared recovery provenance before candidate mutation: %s", async (_label, tamper) => {
    const sandbox = await makeSandbox();
    const { before } = await prepareLegacyProduction(sandbox);
    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_RECOVERY_SCHEMA: "2",
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "bbbbbbb",
      ...tamper,
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("prepared recovery image provenance is invalid");
    expect(commands).not.toMatch(/docker .* build|docker .* up/u);
  });

  it("rejects a prepared commit that disagrees with the existing green marker", async () => {
    const sandbox = await makeSandbox();
    const { before } = await prepareLegacyProduction(sandbox);
    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_IMAGE_COMMIT: "aaaaaaa",
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "aaaaaaa",
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("prepared recovery image provenance is invalid");
    expect(commands).not.toMatch(/docker .* build|docker .* up/u);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe("bbbbbbb\n");
  });

  it("validates prepared snapshot compatibility before candidate mutation", async () => {
    const sandbox = await makeSandbox();
    const { before } = await prepareLegacyProduction(sandbox, 6);
    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_RECOVERY_SCHEMA: "2",
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "bbbbbbb",
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("saved recovery image cannot read current persistent state");
    expect(commands).not.toMatch(/docker .* build|docker .* up/u);
  });

  it("validates optional MIS readability for prepared recovery before candidate mutation", async () => {
    const sandbox = await makeSandbox();
    const mis = join(sandbox.root, "mis.json");
    await writeFile(mis, JSON.stringify({ schemaVersion: 1, integrations: [{ integrationId: "mis", organizationId: "clinic", enabled: true,
      keys: [{ credentialId: "key", secretHash: `sha256$${"a".repeat(64)}`, enabled: true, scopes: ["events:pull", "events:ack"], expiresAt: null }] }] }), { mode: 0o600 });
    const { before } = await prepareLegacyProduction(sandbox, 2, `DEMEU_HOST_MIS_CREDENTIALS_FILE=${mis}\n`);
    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_RECOVERY_SCHEMA: "2",
      STUB_MIS_UNREADABLE: "1",
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "bbbbbbb",
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MIS credentials are invalid or unreadable by saved runtime UID");
    expect(commands).not.toMatch(/docker .* build|docker .* up/u);
  });

  it("recovers with the verified prepared image and restores its matching green marker", async () => {
    const sandbox = await makeSandbox();
    const { before } = await prepareLegacyProduction(sandbox);
    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_RECOVERY_SCHEMA: "2",
      STUB_HEALTH_MODE: "candidate-red",
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "bbbbbbb",
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("last green release is active");
    expect(commands).toContain(`docker image tag ${PREPARED_IMAGE} demeu-app:last-green`);
    expect(commands).toContain("bbbbbbb external_llm");
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe("bbbbbbb\n");
  });

  it("refuses prepared fallback if the failed candidate advanced persistent schema", async () => {
    const sandbox = await makeSandbox();
    const { data, before } = await prepareLegacyProduction(sandbox);
    const result = await runDeploy(sandbox, {
      STUB_TARGET_SHA: "ccccccc",
      STUB_RECOVERY_SCHEMA: "2",
      STUB_HEALTH_MODE: "candidate-red",
      STUB_MIGRATE_SCHEMA: "6",
      STUB_SNAPSHOT_FILE: join(data, "referrals.json"),
      DEMEU_PREPARED_RECOVERY_IMAGE_ID: PREPARED_IMAGE,
      DEMEU_PREPARED_RECOVERY_COMMIT: "bbbbbbb",
    });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("retain current runtime and use validated recovery");
    expect(commands).not.toContain(`docker image tag ${PREPARED_IMAGE} demeu-app:last-green`);
    expect(JSON.parse(await readFile(join(data, "referrals.json"), "utf8")).schemaVersion).toBe(6);
  });

  it("rechecks a newer live snapshot before automatic fallback and leaves candidate runtime/checkout intact when blocked", async () => {
    const sandbox = await makeSandbox();
    await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const data = join(sandbox.root, "workspace-data"); await mkdir(data);
    const snapshot = join(data, "referrals.json");
    await writeFile(snapshot, '{"schemaVersion":2,"referrals":[]}');
    await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_DATA_DIR=${data}\n`);
    const before = await readFile(sandbox.log, "utf8");
    const failed = await runDeploy(sandbox, { STUB_TARGET_SHA: "ccccccc", STUB_RECOVERY_SCHEMA: "2",
      STUB_HEALTH_MODE: "candidate-red", STUB_MIGRATE_SCHEMA: "6", STUB_SNAPSHOT_FILE: snapshot });
    const commands = (await readFile(sandbox.log, "utf8")).slice(before.length);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("retain current runtime and use validated recovery");
    expect(commands).not.toContain("git reset");
    expect(commands).not.toContain("docker image tag sha256:");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("ccccccc\n");
    expect(JSON.parse(await readFile(snapshot, "utf8")).schemaVersion).toBe(6);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe("bbbbbbb\n");
  });

  it.each([false, true])("fails closed on missing image capability or malformed trailing JSON (missing=%s)", async (missing) => {
    const sandbox = await makeSandbox(); await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox)).code).toBe(0);
    const data = join(sandbox.root, "data"); await mkdir(data);
    await writeFile(join(data, "referrals.json"), '{"schemaVersion":2,"referrals":[]}' + (missing ? "" : "broken"));
    await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_DATA_DIR=${data}\n`);
    const result = await runDeploy(sandbox, { STUB_RECOVERY_SCHEMA_MISSING: missing ? "1" : "0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("saved recovery image cannot read current persistent state");
  });

  it("recovers a compatible snapshot through the pinned immutable image with hardened no-network validation", async () => {
    const sandbox = await makeSandbox(); await writeFile(join(sandbox.root, ".env"), validEnv());
    expect((await runDeploy(sandbox, { STUB_TARGET_SHA: "bbbbbbb" })).code).toBe(0);
    const data = join(sandbox.root, "data"); await mkdir(data);
    await writeFile(join(data, "referrals.json"), '{"schemaVersion":6,"referrals":[]}');
    await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_DATA_DIR=${data}\n`);
    const failed = await runDeploy(sandbox, { STUB_TARGET_SHA: "ccccccc", STUB_HEALTH_MODE: "candidate-red" });
    const log = await readFile(sandbox.log, "utf8");
    expect(failed.stderr).toContain("last green release is active");
    expect(log).toContain("--network none --read-only --cap-drop ALL --security-opt no-new-privileges");
    expect(log).toContain("docker image tag sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee demeu-app:last-green");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe("bbbbbbb\n");
  });

  it("enables the optional MIS read-only mount only for an explicit private strict file; defaults remain disabled", async () => {
    const disabled = await makeSandbox(); await writeFile(join(disabled.root, ".env"), validEnv());
    expect((await runDeploy(disabled)).code).toBe(0);
    expect(await readFile(disabled.log, "utf8")).not.toContain("compose.mis.yml");
    const sandbox = await makeSandbox(); const file = join(sandbox.root, "mis.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, integrations: [{ integrationId: "mis", organizationId: "clinic", enabled: true,
      keys: [{ credentialId: "key", secretHash: `sha256$${"a".repeat(64)}`, enabled: true, scopes: ["events:pull", "events:ack"], expiresAt: null }] }] }), { mode: 0o600 });
    await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_MIS_CREDENTIALS_FILE=${file}\n`);
    expect((await runDeploy(sandbox)).code).toBe(0);
    const log = await readFile(sandbox.log, "utf8");
    expect(log).toContain("-f deploy/compose.mis.yml");
    expect(log).toContain("dst=/run/secrets/demeu-mis-credentials.json,readonly");
    expect(log).not.toContain("sha256$" + "a".repeat(64));
  });

  it.each(["permissions", "shape", "unreadable", "duplicate"])("rejects invalid MIS credentials (%s) before runtime activation", async (reason) => {
    const sandbox = await makeSandbox(); const file = join(sandbox.root, "mis.json");
    await writeFile(file, reason === "shape" ? '{"schemaVersion":1,"integrations":[],"hidden":true}' : '{"schemaVersion":1,"integrations":[]}', { mode: reason === "permissions" ? 0o644 : 0o600 });
    await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_MIS_CREDENTIALS_FILE=${file}\n${reason === "duplicate" ? `DEMEU_HOST_MIS_CREDENTIALS_FILE=${file}\n` : ""}`);
    const result = await runDeploy(sandbox, { STUB_MIS_UNREADABLE: reason === "unreadable" ? "1" : "0" });
    expect(result.code).toBe(1);
    expect(await readFile(sandbox.log, "utf8")).not.toMatch(/docker .* up/u);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SYNTHETIC_KEY);
  });

});
