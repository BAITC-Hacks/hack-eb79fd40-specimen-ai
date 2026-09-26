import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const sandboxes: string[] = [];
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const SYNTHETIC_KEY = `sk-ant-${"rollback_test_value_".repeat(3)}`;

interface Sandbox {
  root: string;
  bin: string;
  log: string;
  state: string;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function environment(
  sandbox: Sandbox,
  extra: Readonly<Record<string, string>> = {},
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
    ...extra,
  };
}

function definedEnv(
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
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

async function makeSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "demeu-rollback-test-"));
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
  await Promise.all([
    copyFile("deploy/rollback.sh", join(root, "deploy/rollback.sh")),
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
    writeFile(join(root, ".env"), validEnv()),
    writeFile(join(root, ".deploy_green_sha"), `${B.slice(0, 7)}\n`),
    writeFile(join(root, ".deploy_prev_sha"), `${A.slice(0, 7)}\n`),
    writeFile(join(state, "commit"), `${C}\n`),
    writeFile(join(state, "runtime_commit"), `${B.slice(0, 7)}\n`),
    writeFile(join(state, "runtime_model"), "lr-v1\n"),
    writeFile(join(state, "image_demeu-app_last-green"), ""),
    writeFile(join(state, "image_demeu-app_latest"), ""),
  ]);
  await Promise.all([
    chmod(join(root, "deploy/rollback.sh"), 0o755),
    chmod(join(root, "deploy/tls.sh"), 0o755),
  ]);

  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
set -eu
printf 'git %s\\n' "$*" >> "$STUB_LOG"
resolve() {
  value=$(printf '%s' "$1" | sed 's/\\^{commit}$//')
  case "$value" in
    HEAD) cat "$STUB_STATE/commit" ;;
    aaaaaaa|${A}) printf '%s\\n' '${A}' ;;
    bbbbbbb|${B}) printf '%s\\n' '${B}' ;;
    ccccccc|${C}) printf '%s\\n' '${C}' ;;
    ddddddd|${D}) printf '%s\\n' '${D}' ;;
    *) exit 1 ;;
  esac
}
case "\${1-}:\${2-}" in
  ls-files:--error-unmatch) exit 1 ;;
  status:--porcelain) printf '%s' "\${STUB_DIRTY-}" ;;
  rev-parse:--verify)
    [ "\${STUB_STALE_TARGET-}" != "\${3-}" ] || exit 1
    resolve "\${3-}"
    ;;
  rev-parse:--short)
    if [ "\${3+x}" = x ]; then full=$(resolve "$3"); else full=$(cat "$STUB_STATE/commit"); fi
    printf '%.7s\\n' "$full"
    ;;
  merge-base:--is-ancestor)
    [ "\${3-}" != '${D}' ]
    ;;
  show:*)
    case "\${2-}" in
      *:deploy/referral-schema-version)
        [ "\${STUB_REFERRAL_SCHEMA_MISSING-0}" = 0 ] || exit 1
        printf '%s\\n' "\${STUB_TARGET_REFERRAL_SCHEMA-2}"
        ;;
      *)
        [ "\${STUB_MODEL_MISSING-0}" = 0 ] || exit 1
        printf '%s\\n' '{"schema_version":1,"model_version":"lr-v1"}'
        ;;
    esac
    ;;
  reset:*)
    for value in "$@"; do target="$value"; done
    printf '%s\\n' "$target" > "$STUB_STATE/commit"
    ;;
  *) exit 2 ;;
esac
`,
  );

  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh
set -eu
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
safe() { printf '%s' "$1" | tr '/:' '__'; }
mutate_env() {
  phase="$1"
  if [ "\${STUB_MUTATE_ENV_PHASE-}" = "$phase" ] \
    || { [ "$phase" = build ] && [ "\${STUB_MUTATE_ENV-0}" != 0 ]; }; then
    printf '%s\\n' "# synthetic mutation during $phase" >> "$APP_DIR/.env"
  fi
}
if [ "\${1-}" = image ]; then
  action="\${2-}"
  source="\${3-}"
  target="\${4-}"
  case "$action" in
    inspect) [ -f "$STUB_STATE/image_$(safe "$source")" ] ;;
    tag)
      [ "\${STUB_TAG_FAIL_PAIR-}" != "$source->$target" ] || exit 1
      touch "$STUB_STATE/image_$(safe "$target")"
      ;;
    rm) rm -f "$STUB_STATE/image_$(safe "$source")" ;;
  esac
  exit
fi
[ "\${1-}" = compose ] || exit 2
shift
while [ "\${1-}" = -f ]; do shift 2; done
command="\${1-}"
shift || true
case "$command" in
  config)
    [ "\${STUB_CONFIG_FAIL-0}" = 0 ]
    ;;
  build)
    [ "\${STUB_BUILD_FAIL-0}" = 0 ] || exit 1
    mutate_env build
    if [ -n "\${STUB_BUILD_READY-}" ]; then
      touch "$STUB_BUILD_READY"
      while [ ! -f "$STUB_BUILD_RELEASE" ]; do /bin/sleep 0.01; done
    fi
    touch "$STUB_STATE/image_demeu-app_latest"
    ;;
  up)
    args="$*"
    if ! printf '%s' "$args" | grep -q -- '--no-build'; then
      [ "\${STUB_UP_FAIL-0}" = 0 ] || exit 1
      runtime_commit="\${STUB_CANDIDATE_RUNTIME_COMMIT-$COMMIT_SHA}"
      runtime_model="\${STUB_CANDIDATE_RUNTIME_MODEL-lr-v1}"
    else
      runtime_commit="$COMMIT_SHA"
      runtime_model='lr-v1'
    fi
    printf '%s\\n' "$runtime_commit" > "$STUB_STATE/runtime_commit"
    printf '%s\\n' "$runtime_model" > "$STUB_STATE/runtime_model"
    if ! printf '%s' "$args" | grep -q -- '--no-build'; then mutate_env up; fi
    ;;
  exec)
    if printf '%s' "$*" | grep -q 'grep -c.*ANTHROPIC_API_KEY'; then
      if [ "$(cat "$STUB_STATE/runtime_commit")" = bbbbbbb ] \
        && [ -n "\${STUB_RECOVERY_ANTHROPIC_STDERR-}" ]; then
        printf '%s\\n' "$STUB_RECOVERY_ANTHROPIC_STDERR" >&2
      fi
      if [ "$(cat "$STUB_STATE/runtime_commit")" = bbbbbbb ] \
        && [ "\${STUB_RECOVERY_ANTHROPIC_EMPTY-0}" != 0 ]; then
        exit
      fi
      if [ "$(cat "$STUB_STATE/runtime_commit")" = bbbbbbb ] \
        && [ -n "\${STUB_RECOVERY_ANTHROPIC_COUNT-}" ]; then
        printf '%s\\n' "$STUB_RECOVERY_ANTHROPIC_COUNT"
      elif [ "$(cat "$STUB_STATE/runtime_commit")" = bbbbbbb ] \
        && [ "\${STUB_RECOVERY_ANTHROPIC_FAILURE-0}" != 0 ]; then
        [ -z "\${STUB_RECOVERY_ANTHROPIC_FAILURE_STDOUT-}" ] \
          || printf '%s\\n' "$STUB_RECOVERY_ANTHROPIC_FAILURE_STDOUT"
        exit 9
      else
        printf '%s\\n' "\${STUB_ANTHROPIC_COUNT:-1}"
      fi
      exit
    fi
    is_existing=0
    if printf '%s' "$*" | grep -q 'demeu-existing-health:v1'; then is_existing=1; fi
    if printf '%s' "$*" | grep -q 'demeu-deterministic-readiness:v1'; then
      [ "\${STUB_DETERMINISTIC_READY-1}" = 1 ]
      exit
    fi
    if printf '%s' "$*" | grep -q 'demeu-workspace-health:v1' \
      && [ -n "\${STUB_WORKSPACE_HEALTH_FAIL_COMMIT-}" ] \
      && printf '%s' "$*" | grep -q "\${STUB_WORKSPACE_HEALTH_FAIL_COMMIT}"; then
      exit 1
    fi
    before_previous=''
    previous=''
    last=''
    for value in "$@"; do before_previous="$previous"; previous="$last"; last="$value"; done
    expected_commit="$before_previous"
    expected_model="$previous"
    expected_mode="$last"
    if [ "$expected_commit" = aaaaaaa ]; then mutate_env health; fi
    if [ "\${STUB_HEALTH_FAIL_COMMIT-}" = "$expected_commit" ]; then exit 1; fi
    [ "$(cat "$STUB_STATE/runtime_commit")" = "$expected_commit" ] || exit 1
    [ "$(cat "$STUB_STATE/runtime_model")" = "$expected_model" ] || exit 1
    case "$expected_mode" in ''|external_llm|deterministic) ;; *) exit 1 ;; esac
    if [ "$is_existing" = 1 ]; then
      actual_mode="\${STUB_CURRENT_PROCESSING_MODE:-external_llm}"
    else
      actual_mode="$expected_mode"
    fi
    if [ "\${STUB_LEGACY_HEALTH-0}" = 1 ]; then actual_mode=external_llm; fi
    if [ -n "$expected_mode" ] && [ "$expected_mode" != "$actual_mode" ]; then exit 1; fi
    if [ "$expected_mode" = external_llm ]; then [ "\${STUB_LLM_OK-1}" = 1 ] || exit 1; fi
    if [ "$is_existing" = 1 ]; then printf '%s' "$actual_mode"; fi
    ;;
  *) exit 2 ;;
esac
`,
  );
  await writeFile(
    join(bin, "mktemp"),
    `#!/bin/sh
set -eu
[ "\${STUB_SNAPSHOT_FAIL-0}" = 0 ] || exit 1
path="$STUB_STATE/env-snapshot"
if [ "\${STUB_SNAPSHOT_SYMLINK-0}" != 0 ]; then
  ln -s "$APP_DIR/.env" "$path"
else
  (umask 077 && : > "$path")
fi
printf '%s\\n' "$path"
`,
  );
  await writeFile(
    join(bin, "mv"),
    `#!/bin/sh
set -eu
printf 'mv %s\\n' "$*" >> "$STUB_LOG"
for value in "$@"; do destination="$value"; done
if [ "\${STUB_RESTORE_FAIL-0}" != 0 ] && [ "$destination" = .env ]; then exit 1; fi
exec /bin/mv "$@"
`,
  );
  await writeFile(
    join(bin, "rm"),
    `#!/bin/sh
set -eu
if [ "\${STUB_SNAPSHOT_CLEANUP_FAIL-0}" != 0 ]; then
  for value in "$@"; do
    if [ "$value" = "$STUB_STATE/env-snapshot" ]; then exit 1; fi
  done
fi
exec /bin/rm "$@"
`,
  );
  await writeFile(
    join(bin, "cp"),
    `#!/bin/sh
set -eu
for value in "$@"; do destination="$value"; done
if [ "\${STUB_SNAPSHOT_COPY_FAIL-0}" != 0 ] \
  && [ "$destination" = "$STUB_STATE/env-snapshot" ]; then exit 1; fi
case "$destination" in
  .env.rollback.*)
    [ "\${STUB_RESTORE_COPY_FAIL-0}" = 0 ] || exit 1
    ;;
esac
exec /usr/bin/cp "$@"
`,
  );
  await writeFile(
    join(bin, "chmod"),
    `#!/bin/sh
set -eu
for value in "$@"; do target="$value"; done
if [ "\${STUB_SNAPSHOT_CHMOD_FAIL-0}" != 0 ] \
  && [ "$target" = "$STUB_STATE/env-snapshot" ]; then exit 1; fi
case "$target" in
  .env.rollback.*)
    [ "\${STUB_RESTORE_CHMOD_FAIL-0}" = 0 ] || exit 1
    ;;
esac
exec /usr/bin/chmod "$@"
`,
  );
  await writeFile(
    join(bin, "stat"),
    `#!/bin/sh
set -eu
format="\${2-}"
for value in "$@"; do target="$value"; done
if [ "\${STUB_FAKE_ENV_OWNER-0}" != 0 ] && [ "$target" = .env ]; then
  case "$format" in
    %u|%g) printf '%s\\n' 123; exit ;;
  esac
fi
exec /usr/bin/stat "$@"
`,
  );
  await writeFile(
    join(bin, "chown"),
    `#!/bin/sh
set -eu
[ "\${STUB_RESTORE_CHOWN_FAIL-0}" = 0 ] || exit 1
exec /usr/bin/chown "$@"
`,
  );
  await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  await Promise.all(
    ["git", "docker", "mktemp", "mv", "rm", "cp", "chmod", "stat", "chown", "sleep"].map((name) =>
      chmod(join(bin, name), 0o755),
    ),
  );
  return { root, bin, log, state };
}

async function runRollback(
  sandbox: Sandbox,
  args: readonly string[] = [],
  extra: Readonly<Record<string, string>> = {},
): Promise<Result> {
  try {
    const { stdout, stderr } = await execFile(
      "/bin/bash",
      [join(sandbox.root, "deploy/rollback.sh"), ...args],
      { cwd: sandbox.root, env: environment(sandbox, extra) },
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
    sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("deploy/rollback.sh", () => {
  it("allows documented excluded build and data state without weakening tracked-file checks", async () => {
    const sandbox = await makeSandbox();
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

    expect((await runRollback(sandbox, [], { STUB_DIRTY: allowed })).code).toBe(0);
  });

  it("fails closed before mutation when referral state exists and the rollback reader is markerless", async () => {
    const sandbox = await makeSandbox();
    const dataDir = join(sandbox.root, "workspace-data");
    await mkdir(dataDir);
    await writeFile(join(dataDir, "referrals.json"), JSON.stringify({
      schemaVersion: 2,
      referrals: [],
      links: [],
      commands: [],
      nestedCatalogueFixture: { schemaVersion: 1 },
    }));
    await writeFile(
      join(sandbox.root, ".env"),
      `${validEnv()}DEMEU_HOST_DATA_DIR=${dataDir}\n`,
    );

    const result = await runRollback(sandbox, [], {
      STUB_REFERRAL_SCHEMA_MISSING: "1",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("rollback target referral schema capability is missing or invalid while referral state exists");
    expect(commands).not.toContain("git reset");
    expect(commands).not.toMatch(/docker image tag/u);
    expect(commands).not.toMatch(/docker .* build/u);
    expect(commands).not.toMatch(/docker .* up/u);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(`${B.slice(0, 7)}\n`);
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(`${A.slice(0, 7)}\n`);
  });

  it.each([3, 42, 999])("fails closed before mutation when live referral schema v%s is newer than target v2", async (schemaVersion) => {
    const sandbox = await makeSandbox();
    const dataDir = join(sandbox.root, "workspace-data");
    await mkdir(dataDir);
    await writeFile(join(dataDir, "referrals.json"), JSON.stringify({ schemaVersion, referrals: [], links: [], commands: [] }));
    await writeFile(join(sandbox.root, ".env"), `${validEnv()}DEMEU_HOST_DATA_DIR=${dataDir}\n`);

    const result = await runRollback(sandbox);
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`referral snapshot schema v${schemaVersion} is newer than rollback target capability v2`);
    expect(commands).not.toContain("git reset");
    expect(commands).not.toMatch(/docker image tag/u);
    expect(commands).not.toMatch(/docker .* build/u);
    expect(commands).not.toMatch(/docker .* up/u);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(`${B.slice(0, 7)}\n`);
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(`${A.slice(0, 7)}\n`);
  });

  it("keeps workspace and ingress overlays on the current production profile", async () => {
    const sandbox = await makeSandbox();
    await writeFile(
      join(sandbox.root, ".env"),
      validEnv("branch-b-caddy", "84.247.161.211"),
    );

    const result = await runRollback(sandbox);
    const commands = await readFile(sandbox.log, "utf8");
    const prefix = "docker compose -f docker-compose.yml -f deploy/compose.caddy.yml -f deploy/compose.workspace.yml -f deploy/compose.new-server-ip.yml";

    expect(result.code).toBe(0);
    expect(commands).toContain(`${prefix} config --quiet`);
    expect(commands).toContain(`${prefix} build app`);
    expect(commands).toContain(`${prefix} up -d --remove-orphans`);
  });

  it("rejects a rollback target when the workspace/auth health surface is unavailable", async () => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox, [], {
      STUB_WORKSPACE_HEALTH_FAIL_COMMIT: "aaaaaaa",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("rollback target health contract failed");
    expect(commands).toContain("demeu-workspace-health:v1");
  });

  it("accepts a custom FQDN only with the exact matching HTTPS APP_BASE_URL", async () => {
    const accepted = await makeSandbox();
    await writeFile(
      join(accepted.root, ".env"),
      validEnv("branch-b-caddy", "demo.example.kz"),
    );
    expect((await runRollback(accepted)).code).toBe(0);

    const rejected = await makeSandbox();
    await writeFile(
      join(rejected.root, ".env"),
      validEnv("branch-b-caddy", "demo.example.kz").replace(
        "APP_BASE_URL=https://demo.example.kz",
        "APP_BASE_URL=https://other.example.kz",
      ),
    );
    const result = await runRollback(rejected);
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
    expect((await runRollback(accepted)).code).toBe(0);
    expect(await readFile(join(accepted.root, ".env"), "utf8")).toBe(ipEnv);

    for (const branch of ["branch-a-nginx", "branch-a-caddy"]) {
      const rejected = await makeSandbox();
      await writeFile(
        join(rejected.root, ".env"),
        validEnv(branch, "109.123.248.16"),
      );
      const result = await runRollback(rejected);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("requires TLS_BRANCH=branch-b-caddy");
      expect(await readFile(rejected.log, "utf8")).not.toContain("docker ");
    }
  });

  it("rolls a broken repository state back through the marker and proves the full health contract", async () => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox);
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("commit=aaaaaaa, model=lr-v1, processing_mode=external_llm");
    expect(result.stdout).not.toContain(SYNTHETIC_KEY);
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe(`${A}\n`);
    expect(await readFile(join(sandbox.state, "runtime_commit"), "utf8")).toBe(
      "aaaaaaa\n",
    );
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(
      "aaaaaaa\n",
    );
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(
      "aaaaaaa\n",
    );
    expect(commands).toContain(`git reset --hard --quiet ${A}`);
    expect(commands).toContain("body.model_version === expectedModel");
    expect(commands).toContain("body.llm_ok === true");
    expect(commands).not.toContain("git fetch");
    await expect(readFile(join(sandbox.state, "env-snapshot"))).rejects.toThrow();
  });

  it("accepts only a reachable full explicit SHA and prevents option injection", async () => {
    const acceptedSandbox = await makeSandbox();
    await writeFile(join(acceptedSandbox.root, ".env"), validEnv("branch-b-caddy"));
    expect((await runRollback(acceptedSandbox, [B])).code).toBe(0);

    for (const target of ["bbbbbbb", "--help", D, `${B}extra`]) {
      const sandbox = await makeSandbox();
      const result = await runRollback(sandbox, [target]);
      const commands = await readFile(sandbox.log, "utf8");
      expect(result.code).toBe(1);
      expect(commands).not.toContain("git reset");
      expect(commands).not.toMatch(/docker .* build/u);
      expect(commands).not.toMatch(/docker .* up/u);
    }
  });

  it.each([
    [".deploy_prev_sha", "missing"],
    [".deploy_prev_sha", "invalid"],
    [".deploy_prev_sha", "symlink"],
    [".deploy_prev_sha", "stale"],
    [".deploy_green_sha", "missing"],
    [".deploy_green_sha", "invalid"],
    [".deploy_green_sha", "symlink"],
    [".deploy_green_sha", "stale"],
  ])(
    "fails before mutation for %s when it is %s",
    async (markerName, kind) => {
      const sandbox = await makeSandbox();
      const marker = join(sandbox.root, markerName);
      if (kind === "missing") await rm(marker);
      if (kind === "invalid") await writeFile(marker, "--hard\n");
      if (kind === "symlink") {
        await rm(marker);
        await symlink(join(sandbox.root, ".env"), marker);
      }
      if (kind === "stale") await writeFile(marker, "eeeeeee\n");

      const result = await runRollback(sandbox);
      const commands = await readFile(sandbox.log, "utf8");

      expect(result.code).toBe(1);
      expect(commands).not.toContain("git reset");
      expect(commands).not.toMatch(/docker .* build/u);
      expect(commands).not.toMatch(/docker .* up/u);
    },
  );

  it("fails before mutation when a required host tool is missing", async () => {
    const sandbox = await makeSandbox();
    const result = await runRollback(sandbox, [], { PATH: sandbox.bin });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("required command is missing");
    expect(commands).not.toContain("git reset");
    expect(commands).not.toContain("docker ");
  });

  it.each([
    { label: "dirty worktree", extra: { STUB_DIRTY: " M deploy/rollback.sh\n" } },
    { label: "invalid compose", extra: { STUB_CONFIG_FAIL: "1" } },
    { label: "missing last-green image", extra: { STUB_REMOVE_LAST_GREEN: "1" } },
  ])("fails before Git/runtime mutation for $label", async ({ extra }) => {
    const sandbox = await makeSandbox();
    if (extra.STUB_REMOVE_LAST_GREEN) {
      await rm(join(sandbox.state, "image_demeu-app_last-green"));
    }
    const result = await runRollback(sandbox, [], definedEnv(extra));
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(commands).not.toContain("git reset");
    expect(commands).not.toMatch(/docker .* build/u);
    expect(commands).not.toMatch(/docker .* up/u);
  });

  it("does not activate when the recovery snapshot tag fails", async () => {
    const sandbox = await makeSandbox();
    const greenBefore = await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8");
    const prevBefore = await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8");

    const result = await runRollback(sandbox, [], {
      STUB_TAG_FAIL_PAIR: "demeu-app:last-green->demeu-app:rollback-recovery",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(commands).not.toContain("git reset");
    expect(commands).not.toMatch(/docker .* build/u);
    expect(commands).not.toMatch(/docker .* up/u);
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(
      greenBefore,
    );
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(
      prevBefore,
    );
  });

  it.each([
    { label: "build", extra: { STUB_BUILD_FAIL: "1" } },
    { label: "up", extra: { STUB_UP_FAIL: "1" } },
    { label: "health", extra: { STUB_HEALTH_FAIL_COMMIT: "aaaaaaa" } },
    {
      label: "commit mismatch",
      extra: { STUB_CANDIDATE_RUNTIME_COMMIT: "fffffff" },
    },
    {
      label: "model mismatch",
      extra: { STUB_CANDIDATE_RUNTIME_MODEL: "wrong-model" },
    },
  ])("restores exact last-green Git, image, markers, and health after $label failure", async ({
    extra,
  }) => {
    const sandbox = await makeSandbox();
    const result = await runRollback(sandbox, [], definedEnv(extra));
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("rollback target was not activated");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe(`${B}\n`);
    expect(await readFile(join(sandbox.state, "runtime_commit"), "utf8")).toBe(
      "bbbbbbb\n",
    );
    expect(await readFile(join(sandbox.root, ".deploy_green_sha"), "utf8")).toBe(
      "bbbbbbb\n",
    );
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(
      "aaaaaaa\n",
    );
    expect(commands).toContain(
      "docker image tag demeu-app:rollback-recovery demeu-app:last-green",
    );
    expect(commands).toContain(`git reset --hard --quiet ${B}`);
    expect(commands).toMatch(/up -d --no-build --force-recreate app/u);
    expect(commands).toContain("bbbbbbb lr-v1");
  });

  it("is idempotent when the implicit rollback is repeated", async () => {
    const sandbox = await makeSandbox();

    const first = await runRollback(sandbox);
    const second = await runRollback(sandbox);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe(`${A}\n`);
    expect(await readFile(join(sandbox.root, ".deploy_prev_sha"), "utf8")).toBe(
      "aaaaaaa\n",
    );
  });

  it("restores the original .env fingerprint when activation changes it", async () => {
    const sandbox = await makeSandbox();
    const envBefore = await readFile(join(sandbox.root, ".env"), "utf8");

    const result = await runRollback(sandbox, [], { STUB_MUTATE_ENV: "1" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".env changed during rollback");
    expect(result.stderr).toContain("rollback target was not activated");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe(`${B}\n`);
    expect(await readFile(join(sandbox.state, "runtime_commit"), "utf8")).toBe(
      "bbbbbbb\n",
    );
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(envBefore);
  });

  it.each(["build", "up", "health"])(
    "restores exact environment content before old runtime after a %s-phase mutation",
    async (phase) => {
      const sandbox = await makeSandbox();
      const envBefore = await readFile(join(sandbox.root, ".env"), "utf8");

      const result = await runRollback(sandbox, [], {
        STUB_MUTATE_ENV_PHASE: phase,
      });
      const commands = await readFile(sandbox.log, "utf8");

      expect(result.code).toBe(1);
      expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(envBefore);
      expect(commands).toMatch(/up -d --no-build --force-recreate app/u);
      const restorePosition = commands.indexOf(".env.rollback.");
      const oldUpPosition = commands.indexOf("up -d --no-build --force-recreate app");
      expect(restorePosition).toBeGreaterThanOrEqual(0);
      expect(oldUpPosition).toBeGreaterThan(restorePosition);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(SYNTHETIC_KEY);
      await expect(readFile(join(sandbox.state, "env-snapshot"))).rejects.toThrow();
    },
  );

  it("preserves environment permissions and ownership through recovery", async () => {
    const sandbox = await makeSandbox();
    const envPath = join(sandbox.root, ".env");
    await chmod(envPath, 0o640);
    const before = await stat(envPath);

    const result = await runRollback(sandbox, [], {
      STUB_MUTATE_ENV_PHASE: "build",
    });
    const after = await stat(envPath);

    expect(result.code).toBe(1);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
  });

  it("keeps an exact regular mode-0600 snapshot outside the repository during activation", async () => {
    const sandbox = await makeSandbox();
    const envBefore = await readFile(join(sandbox.root, ".env"), "utf8");
    const ready = join(sandbox.root, "snapshot-ready");
    const release = join(sandbox.root, "snapshot-release");
    const child = spawn("/bin/bash", [join(sandbox.root, "deploy/rollback.sh")], {
      cwd: sandbox.root,
      env: environment(sandbox, {
        STUB_BUILD_READY: ready,
        STUB_BUILD_RELEASE: release,
      }),
    });
    const completion = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    await waitForFile(ready);
    const snapshotPath = join(sandbox.state, "env-snapshot");
    const snapshotStat = await lstat(snapshotPath);
    expect(snapshotStat.isFile()).toBe(true);
    expect(snapshotStat.isSymbolicLink()).toBe(false);
    expect(snapshotStat.mode & 0o777).toBe(0o600);
    expect(await readFile(snapshotPath, "utf8")).toBe(envBefore);

    await writeFile(release, "release\n");
    expect(await completion).toBe(0);
    await expect(lstat(snapshotPath)).rejects.toThrow();
  });

  it("does not claim verified recovery when the old container env contract is invalid", async () => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox, [], {
      STUB_MUTATE_ENV_PHASE: "build",
      STUB_RECOVERY_ANTHROPIC_COUNT: "2",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(
      "recovery complete; last green release is active and verified",
    );
    expect(result.stderr).toContain("automatic recovery could not verify");
    expect(commands.match(/grep -c.*ANTHROPIC_API_KEY/gu)).toHaveLength(2);
  });

  it.each([
    { label: "zero", extra: { STUB_RECOVERY_ANTHROPIC_COUNT: "0" } },
    { label: "duplicate", extra: { STUB_RECOVERY_ANTHROPIC_COUNT: "2" } },
    { label: "non-numeric", extra: { STUB_RECOVERY_ANTHROPIC_COUNT: "many" } },
    { label: "command failure", extra: { STUB_RECOVERY_ANTHROPIC_FAILURE: "1" } },
  ])("rejects $label recovered-container environment cardinality", async ({ extra }) => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox, [], definedEnv({
      STUB_MUTATE_ENV_PHASE: "build",
      ...extra,
    }));

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(
      "recovery complete; last green release is active and verified",
    );
    expect(result.stderr).toContain("automatic recovery could not verify");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SYNTHETIC_KEY);
  });

  it.each([
    { label: "empty", extra: { STUB_RECOVERY_ANTHROPIC_EMPTY: "1" } },
    { label: "leading whitespace", extra: { STUB_RECOVERY_ANTHROPIC_COUNT: " 1" } },
    { label: "trailing whitespace", extra: { STUB_RECOVERY_ANTHROPIC_COUNT: "1 " } },
    { label: "noncanonical numeric", extra: { STUB_RECOVERY_ANTHROPIC_COUNT: "01" } },
    {
      label: "huge numeric",
      extra: { STUB_RECOVERY_ANTHROPIC_COUNT: "9".repeat(256) },
    },
    {
      label: "command error with stdout",
      extra: {
        STUB_RECOVERY_ANTHROPIC_FAILURE: "1",
        STUB_RECOVERY_ANTHROPIC_FAILURE_STDOUT: "1",
      },
    },
  ])("rejects independent $label recovery output", async ({ extra }) => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox, [], definedEnv({
      STUB_MUTATE_ENV_PHASE: "build",
      ...extra,
    }));

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(
      "recovery complete; last green release is active and verified",
    );
    expect(result.stderr).toContain("automatic recovery could not verify");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SYNTHETIC_KEY);
  });

  it("suppresses recovered-container cardinality stderr including secret-like values", async () => {
    const sandbox = await makeSandbox();
    const stderrSentinel = `sk-ant-${"stderr_secret_sentinel_".repeat(3)}`;

    const result = await runRollback(sandbox, [], {
      STUB_MUTATE_ENV_PHASE: "build",
      STUB_RECOVERY_ANTHROPIC_COUNT: "0",
      STUB_RECOVERY_ANTHROPIC_STDERR: stderrSentinel,
    });

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(stderrSentinel);
    expect(result.stdout).not.toContain(
      "recovery complete; last green release is active and verified",
    );
  });

  it("accepts exactly one environment entry on candidate and recovered paths", async () => {
    const candidateSandbox = await makeSandbox();
    const candidate = await runRollback(candidateSandbox, [], {
      STUB_ANTHROPIC_COUNT: "1",
    });
    expect(candidate.code).toBe(0);

    const recoverySandbox = await makeSandbox();
    const recovery = await runRollback(recoverySandbox, [], {
      STUB_MUTATE_ENV_PHASE: "build",
      STUB_RECOVERY_ANTHROPIC_COUNT: "1",
    });
    expect(recovery.code).toBe(1);
    expect(recovery.stdout).toContain(
      "recovery complete; last green release is active and verified",
    );
    expect(recovery.stderr).toContain("rollback target was not activated");
  });

  it("rolls back deterministic mode without an Anthropic key check", async () => {
    const sandbox = await makeSandbox();
    const env = validEnv()
      .replace(/^ANTHROPIC_API_KEY=.*\n/mu, "")
      .replace("DEMEU_PROCESSING_MODE=external_llm", "DEMEU_PROCESSING_MODE=deterministic");
    await writeFile(join(sandbox.root, ".env"), env);

    const result = await runRollback(sandbox, [], { STUB_ANTHROPIC_COUNT: "0" });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("processing_mode=deterministic");
    expect(commands).not.toMatch(/grep -c.*ANTHROPIC_API_KEY/gu);
    expect(commands).toContain("demeu-deterministic-readiness:v1");
  });

  it("accepts an exact legacy four-field target only as external_llm", async () => {
    const external = await makeSandbox();
    const accepted = await runRollback(external, [], { STUB_LEGACY_HEALTH: "1" });
    expect(accepted.code).toBe(0);

    const deterministic = await makeSandbox();
    await writeFile(
      join(deterministic.root, ".env"),
      validEnv().replace(/^ANTHROPIC_API_KEY=.*\n/mu, "").replace("external_llm", "deterministic"),
    );
    const rejected = await runRollback(deterministic, [], { STUB_LEGACY_HEALTH: "1" });
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("health contract failed");
  });

  it("fails closed when deterministic rollback readiness is red", async () => {
    const sandbox = await makeSandbox();
    await writeFile(
      join(sandbox.root, ".env"),
      validEnv().replace(/^ANTHROPIC_API_KEY=.*\n/mu, "").replace("external_llm", "deterministic"),
    );
    const result = await runRollback(sandbox, [], { STUB_DETERMINISTIC_READY: "0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("deterministic readiness gate failed");
  });

  it("fails before activation and leaves no plaintext residue when snapshot creation fails", async () => {
    const sandbox = await makeSandbox();
    const envBefore = await readFile(join(sandbox.root, ".env"), "utf8");

    const result = await runRollback(sandbox, [], { STUB_SNAPSHOT_FAIL: "1" });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("secure .env snapshot could not be created");
    expect(commands).not.toContain("git reset");
    expect(commands).not.toMatch(/docker .* build/u);
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(envBefore);
    await expect(readFile(join(sandbox.state, "env-snapshot"))).rejects.toThrow();
  });

  it.each([
    ["snapshot copy", { STUB_SNAPSHOT_COPY_FAIL: "1" }],
    ["snapshot chmod", { STUB_SNAPSHOT_CHMOD_FAIL: "1" }],
  ])("fails before activation when %s fails", async (_label, extra) => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox, [], extra);
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(commands).not.toContain("git reset");
    expect(commands).not.toMatch(/docker .* build/u);
    expect(commands).not.toMatch(/docker .* up/u);
    await expect(lstat(join(sandbox.state, "env-snapshot"))).rejects.toThrow();
  });

  it("rejects and removes an unsafe snapshot symlink without changing its target", async () => {
    const sandbox = await makeSandbox();
    const envPath = join(sandbox.root, ".env");
    const envBefore = await readFile(envPath, "utf8");
    const modeBefore = (await stat(envPath)).mode & 0o777;

    const result = await runRollback(sandbox, [], { STUB_SNAPSHOT_SYMLINK: "1" });

    expect(result.code).toBe(1);
    expect(await readFile(envPath, "utf8")).toBe(envBefore);
    expect((await stat(envPath)).mode & 0o777).toBe(modeBefore);
    await expect(readFile(join(sandbox.state, "env-snapshot"))).rejects.toThrow();
  });

  it("fails closed without printing secrets when snapshot cleanup is denied", async () => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox, [], {
      STUB_SNAPSHOT_CLEANUP_FAIL: "1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("temporary environment snapshot cleanup failed");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SYNTHETIC_KEY);
    expect(await readFile(join(sandbox.state, "env-snapshot"), "utf8")).not.toBe("");
  });

  it("fails closed without restarting old runtime when atomic environment restore fails", async () => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox, [], {
      STUB_MUTATE_ENV_PHASE: "build",
      STUB_RESTORE_FAIL: "1",
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("automatic recovery could not verify");
    expect(commands).not.toMatch(/up -d --no-build --force-recreate app/u);
    await expect(readFile(join(sandbox.state, "env-snapshot"))).rejects.toThrow();
    expect((await readdir(sandbox.root)).some((name) => name.startsWith(".env.rollback."))).toBe(
      false,
    );
  });

  it.each([
    ["copy", { STUB_RESTORE_COPY_FAIL: "1" }],
    ["chmod", { STUB_RESTORE_CHMOD_FAIL: "1" }],
    [
      "chown",
      { STUB_FAKE_ENV_OWNER: "1", STUB_RESTORE_CHOWN_FAIL: "1" },
    ],
  ])("does not restart old runtime when restore %s fails", async (_label, extra) => {
    const sandbox = await makeSandbox();

    const result = await runRollback(sandbox, [], {
      STUB_MUTATE_ENV_PHASE: "build",
      ...extra,
    });
    const commands = await readFile(sandbox.log, "utf8");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("automatic recovery could not verify");
    expect(commands).not.toMatch(/up -d --no-build --force-recreate app/u);
    expect((await readdir(sandbox.root)).some((name) => name.startsWith(".env.rollback."))).toBe(
      false,
    );
  });

  it("detects a snapshot race and refuses to start the old runtime", async () => {
    const sandbox = await makeSandbox();
    const ready = join(sandbox.root, "race-ready");
    const release = join(sandbox.root, "race-release");
    const child = spawn("/bin/bash", [join(sandbox.root, "deploy/rollback.sh")], {
      cwd: sandbox.root,
      env: environment(sandbox, {
        STUB_BUILD_READY: ready,
        STUB_BUILD_RELEASE: release,
      }),
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const completion = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    await waitForFile(ready);
    await writeFile(join(sandbox.state, "env-snapshot"), "tampered snapshot\n");
    child.kill("SIGTERM");
    await writeFile(release, "release\n");

    expect(await completion).toBe(143);
    const commands = await readFile(sandbox.log, "utf8");
    expect(stderr).toContain("automatic recovery could not verify");
    expect(commands).not.toMatch(/up -d --no-build --force-recreate app/u);
    await expect(lstat(join(sandbox.state, "env-snapshot"))).rejects.toThrow();
  });

  it("recovers on TERM and releases the shared lock", async () => {
    const sandbox = await makeSandbox();
    const envBefore = await readFile(join(sandbox.root, ".env"), "utf8");
    const ready = join(sandbox.root, "build-ready");
    const release = join(sandbox.root, "build-release");
    const child = spawn("/bin/bash", [join(sandbox.root, "deploy/rollback.sh")], {
      cwd: sandbox.root,
      env: environment(sandbox, {
        STUB_BUILD_READY: ready,
        STUB_BUILD_RELEASE: release,
        STUB_MUTATE_ENV_PHASE: "build",
      }),
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const completion = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    await waitForFile(ready);
    child.kill("SIGTERM");
    await writeFile(release, "release\n");
    expect(await completion).toBe(143);
    expect(stderr).toContain("interrupted by TERM");
    expect(await readFile(join(sandbox.state, "commit"), "utf8")).toBe(`${B}\n`);
    expect(await readFile(join(sandbox.root, ".env"), "utf8")).toBe(envBefore);
    await expect(readFile(join(sandbox.state, "env-snapshot"))).rejects.toThrow();

    const next = await runRollback(sandbox);
    expect(next.code).toBe(0);
  });

  it("shares the deploy lock and accepts the stale inode after release", async () => {
    const sandbox = await makeSandbox();
    const ready = join(sandbox.root, "lock-ready");
    const release = join(sandbox.root, "lock-release");
    const holder = execFile("flock", [
      join(sandbox.root, ".deploy.lock"),
      "sh",
      "-c",
      `touch '${ready}'; while [ ! -f '${release}' ]; do /bin/sleep 0.01; done`,
    ]);
    await waitForFile(ready);

    const blocked = await runRollback(sandbox);
    await writeFile(release, "release\n");
    await holder;
    const afterRelease = await runRollback(sandbox);

    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("already running");
    expect(afterRelease.code).toBe(0);
  });
});
