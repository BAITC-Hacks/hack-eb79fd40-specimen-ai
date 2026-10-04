#!/usr/bin/env bash

set -Eeuo pipefail

DEMEU_SCRIPT_DIRECTORY="${BASH_SOURCE[0]%/*}"
[ "$DEMEU_SCRIPT_DIRECTORY" != "${BASH_SOURCE[0]}" ] || DEMEU_SCRIPT_DIRECTORY=.
source "${DEMEU_SCRIPT_DIRECTORY}/recovery-guards.sh"

APP_DIR="${APP_DIR:-/opt/demeu}"
SERVER="${SERVER:-root@109.123.248.16}"
BRANCH="${BRANCH:-main}"
DEPLOY_MODE="${DEPLOY_MODE:-git}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"
DEEP_PROBE_AUTHORIZATION="I_AUTHORIZE_ONE_STRUCTURED_EXTRACTION"
DEEP_PROBE_TIMEOUT_MS=210000
LAST_GREEN_IMAGE="demeu-app:last-green"
RECOVERY_IMAGE="demeu-app:deploy-recovery"
CURRENT_PRODUCTION_DOMAIN="84.247.161.211"
LOCK_FD=""
LOCK_HELD=0
ACTIVATION_STARTED=0
DEPLOY_SUCCEEDED=0
RECOVERY_RUNNING=0
COMPOSE_READY=0
SERVER_GIT_MODE=0
PREVIOUS_SHA=""
COMPOSE_ARGS=()
RECOVERY_IMAGE_AVAILABLE=0
RECOVERY_IMAGE_ID=""
LAST_GREEN_SAFE=0
PREEXISTING_APP_PRESENT=0
RUNTIME_MUTATION_STARTED=0
OLD_GREEN_SHA=""
OLD_GREEN_SHA_PRESENT=0
OLD_PREV_SHA=""
OLD_PREV_SHA_PRESENT=0
PROCESSING_MODE="external_llm"
CURRENT_PROCESSING_MODE=""
PREPARED_RECOVERY_IMAGE_ID="${DEMEU_PREPARED_RECOVERY_IMAGE_ID-}"
PREPARED_RECOVERY_COMMIT="${DEMEU_PREPARED_RECOVERY_COMMIT-}"
PREPARED_IMAGE_ARCHIVE=""
RECOVERY_EXPECTED_SHA=""

log() {
  printf '[deploy] %s\n' "$*"
}

die() {
  printf '[deploy] FAIL: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

acquire_deploy_lock() {
  require_command flock
  exec {LOCK_FD}>"$APP_DIR/.deploy.lock"
  if ! flock -n "$LOCK_FD"; then
    die "another deployment is already running"
  fi
  LOCK_HELD=1
}

release_deploy_lock() {
  if [ "$LOCK_HELD" = "1" ] && [ -n "$LOCK_FD" ]; then
    flock -u "$LOCK_FD" >/dev/null 2>&1 || true
    exec {LOCK_FD}>&-
    LOCK_HELD=0
  fi
}

validate_common_inputs() {
  case "$APP_DIR" in
    /*) ;;
    *) die "APP_DIR must be an absolute path" ;;
  esac
  case "$APP_DIR" in
    /|*/) die "APP_DIR must name a dedicated directory without a trailing slash" ;;
  esac
  case "$APP_DIR" in
    *[!A-Za-z0-9_./-]*|*..*|*//*) die "APP_DIR contains unsafe characters" ;;
  esac
  case "$BRANCH" in
    ''|-*|*[!A-Za-z0-9_./-]*|*..*|/*|*/|*//*) die "BRANCH is invalid" ;;
  esac
  [[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]{0,2}$ ]] \
    || die "HEALTH_ATTEMPTS must be a canonical integer from 1 to 999"
  [[ "$HEALTH_INTERVAL_SECONDS" =~ ^(0|[1-9][0-9]{0,2})$ ]] \
    || die "HEALTH_INTERVAL_SECONDS must be a canonical integer from 0 to 999"
  if [ -n "$PREPARED_RECOVERY_IMAGE_ID" ] || [ -n "$PREPARED_RECOVERY_COMMIT" ]; then
    [[ "$PREPARED_RECOVERY_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] \
      || die "prepared recovery image must be an immutable sha256 image ID"
    [[ "$PREPARED_RECOVERY_COMMIT" =~ ^[0-9a-f]{7}$ ]] \
      || die "prepared recovery commit must be the canonical 7-character runtime SHA"
  fi
}

require_deep_probe_authorization() {
  [ "${DEMEU_DEEP_PROBE-}" = "$DEEP_PROBE_AUTHORIZATION" ] \
    || die "set DEMEU_DEEP_PROBE=${DEEP_PROBE_AUTHORIZATION} to authorize the one-shot structured extraction gate"
}

audit_git_history() {
  local secret_count
  if ! secret_count="$(git log -p --all | awk 'tolower($0) ~ /sk-ant-[[:alnum:]]/ { count++ } END { print count + 0 }')"; then
    die "git history audit could not be completed"
  fi
  [ "$secret_count" = "0" ] || die "git history contains an Anthropic credential pattern"
}

assert_clean_worktree() {
  local scope="${1:-server}" status entry
  if [ "$scope" = "server" ]; then
    status="$(git status --porcelain --untracked-files=all --ignored=matching)" \
      || die "git worktree status could not be verified"
  elif [ "$scope" = "rsync-source" ]; then
    status="$(git status --porcelain --untracked-files=all)" \
      || die "git worktree status could not be verified"
  else
    die "git worktree status could not be verified"
  fi

  while IFS= read -r entry; do
    case "$entry" in
      ''|'?? .env'|'?? .deploy.lock'|'?? .deploy_prev_sha'|'?? .deploy_green_sha') ;;
      '!! .env'|'!! .deploy.lock'|'!! .deploy_prev_sha'|'!! .deploy_green_sha') ;;
      '!! .next/'|'!! node_modules/'|'!! tsconfig.tsbuildinfo') ;;
      '!! data/raw/'|'!! data/processed/') ;;
      *) die "server worktree is dirty; refuse to deploy a tree that differs from its commit" ;;
    esac
  done <<< "$status"
}

env_value() {
  local name="$1"
  awk -v key="${name}=" '
    index($0, key) == 1 {
      count++
      value = substr($0, length(key) + 1)
      sub(/\r$/, "", value)
    }
    END {
      if (count > 1) exit 2
      if (count == 1) printf "%s", value
    }
  ' .env
}

load_processing_mode() {
  PROCESSING_MODE="$(env_value DEMEU_PROCESSING_MODE)" \
    || die "DEMEU_PROCESSING_MODE is duplicated in .env"
  [ -n "$PROCESSING_MODE" ] || PROCESSING_MODE="external_llm"
  case "$PROCESSING_MODE" in
    external_llm|deterministic) ;;
    *) die "DEMEU_PROCESSING_MODE must be external_llm or deterministic" ;;
  esac
}

validate_secret_file() {
  [ -f .env ] || die ".env is missing in APP_DIR"
  [ ! -L .env ] || die ".env must not be a symlink"
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    die ".env must not be tracked by git"
  fi
  [ "$PROCESSING_MODE" = "external_llm" ] || return 0

  awk '
    index($0, "ANTHROPIC_API_KEY=") == 1 {
      count++
      value = substr($0, length("ANTHROPIC_API_KEY=") + 1)
      sub(/\r$/, "", value)
    }
    END {
      lower = tolower(value)
      bad = value !~ /^sk-ant-[A-Za-z0-9_-]+$/ || length(value) < 40
      bad = bad || lower ~ /(replace|change|placeholder|example|todo|your[_-]|xxx)/
      bad = bad || value ~ /(ЗАМЕНИ|замени|<|>)/
      if (count != 1 || bad) exit 1
    }
  ' .env || die "ANTHROPIC_API_KEY is missing, duplicated, or still a placeholder"
}

validate_server_config() {
  local configured_domain configured_port configured_branch reconnaissance configured_base_url

  configured_domain="${DEMEU_DOMAIN-}"
  configured_port="${APP_PORT-}"
  configured_branch="${TLS_BRANCH-}"
  reconnaissance="${VPS_RECON_CONFIRMED-}"
  configured_base_url="${APP_BASE_URL-}"

  [ -n "$configured_domain" ] || configured_domain="$(env_value DEMEU_DOMAIN)" \
    || die "DEMEU_DOMAIN is duplicated in .env"
  [ -n "$configured_port" ] || configured_port="$(env_value APP_PORT)" \
    || die "APP_PORT is duplicated in .env"
  [ -n "$configured_branch" ] || configured_branch="$(env_value TLS_BRANCH)" \
    || die "TLS_BRANCH is duplicated in .env"
  [ -n "$reconnaissance" ] || reconnaissance="$(env_value VPS_RECON_CONFIRMED)" \
    || die "VPS_RECON_CONFIRMED is duplicated in .env"
  [ -n "$configured_base_url" ] || configured_base_url="$(env_value APP_BASE_URL)" \
    || die "APP_BASE_URL is duplicated in .env"

  [ "$reconnaissance" = "yes" ] \
    || die "VPS reconnaissance is not confirmed; refuse to choose a TLS branch"

  case "$configured_branch" in
    branch-a-nginx|branch-a-caddy|branch-b-caddy) ;;
    *) die "TLS_BRANCH must be branch-a-nginx, branch-a-caddy, or branch-b-caddy" ;;
  esac

  DEMEU_DOMAIN="$configured_domain"
  APP_PORT="$configured_port"
  TLS_BRANCH="$configured_branch"
  APP_BASE_URL="$configured_base_url"
  if [ "$DEMEU_DOMAIN" = "109.123.248.16" ] \
    && [ "$TLS_BRANCH" != "branch-b-caddy" ]; then
    die "109.123.248.16 requires TLS_BRANCH=branch-b-caddy"
  fi
  [ "$APP_BASE_URL" = "https://${DEMEU_DOMAIN}" ] \
    || die "APP_BASE_URL must exactly match the selected HTTPS domain"
  export DEMEU_DOMAIN APP_PORT TLS_BRANCH APP_BASE_URL

  if [ "$DEMEU_DOMAIN" = "$CURRENT_PRODUCTION_DOMAIN" ]; then
    [ "$TLS_BRANCH" = "branch-b-caddy" ] \
      || die "current production requires TLS_BRANCH=branch-b-caddy"
  else
    DEMEU_DOMAIN="$DEMEU_DOMAIN" APP_PORT="$APP_PORT" TLS_BRANCH="$TLS_BRANCH" \
      ./deploy/tls.sh preflight >/dev/null
  fi
}

configure_compose() {
  COMPOSE_ARGS=(-f docker-compose.yml)
  case "$TLS_BRANCH" in
    branch-b-caddy)
      COMPOSE_ARGS+=(-f deploy/compose.caddy.yml)
      if [ "$DEMEU_DOMAIN" != "$CURRENT_PRODUCTION_DOMAIN" ]; then
        DEMEU_DOMAIN="$DEMEU_DOMAIN" APP_PORT="$APP_PORT" TLS_BRANCH="$TLS_BRANCH" \
          ./deploy/tls.sh branch-b-config
      fi
      ;;
    branch-a-nginx|branch-a-caddy)
      COMPOSE_ARGS+=(-f deploy/compose.host-proxy.yml)
      ;;
  esac

  # The workspace mounts are part of the application runtime, not an optional
  # operator convenience. Omitting this overlay silently starts a fresh
  # in-container workspace and drops the account file from the auth surface.
  COMPOSE_ARGS+=(-f deploy/compose.workspace.yml)
  if [ "$DEMEU_DOMAIN" = "$CURRENT_PRODUCTION_DOMAIN" ]; then
    [ "$TLS_BRANCH" = "branch-b-caddy" ] \
      || die "current production requires TLS_BRANCH=branch-b-caddy"
    COMPOSE_ARGS+=(-f deploy/compose.new-server-ip.yml)
  fi
  configure_private_mis
  docker compose "${COMPOSE_ARGS[@]}" config --quiet
}

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

health_probe() {
  local expected_commit="$1"
  compose exec -T app node -e '
    const expected = process.argv[1];
    const expectedMode = process.argv[2];
    // demeu-workspace-health:v1 makes workspace/auth part of the release gate.
    (async () => {
        const response = await fetch("http://127.0.0.1:3000/api/healthz");
        if (!response.ok) process.exit(1);
        const body = await response.json();
        const llmReady = expectedMode === "deterministic" || body.llm_ok === true;
        const exact = Object.keys(body).sort().join(",") === "commit,llm_ok,model_version,ok,processing_mode";
        if (!(body.ok === true && exact && body.commit === expected && body.processing_mode === expectedMode && llmReady)) process.exit(1);
        const page = await fetch("http://127.0.0.1:3000/workspace", { redirect: "manual" });
        if (page.status !== 200 || !(page.headers.get("content-type") || "").includes("text/html")) process.exit(1);
        const authResponse = await fetch("http://127.0.0.1:3000/api/workspace/auth");
        if (authResponse.status !== 200) process.exit(1);
        const auth = await authResponse.json();
        const authExact = Object.keys(auth).sort().join(",") === "actor,enabled";
        process.exit(authExact && auth.enabled === true && auth.actor === null ? 0 : 1);
      })().catch(() => process.exit(1));
  ' "$expected_commit" "$PROCESSING_MODE" >/dev/null 2>&1
}

health_probe_existing() {
  local expected_commit="${1-}" expected_mode="${2-}"
  compose exec -T app node -e '
    // demeu-existing-health:v1 validates the running release independently of the desired mode.
    // demeu-workspace-health:v1 also proves that workspace mounts and anonymous auth bootstrap work.
    (async () => {
        const response = await fetch("http://127.0.0.1:3000/api/healthz");
        if (!response.ok) process.exit(1);
        const body = await response.json();
        const expectedCommit = process.argv[1];
        const expectedMode = process.argv[2];
        const keys = Object.keys(body).sort().join(",");
        const legacy = keys === "commit,llm_ok,model_version,ok";
        const currentMode = legacy ? "external_llm" : body.processing_mode;
        const exact = legacy || keys === "commit,llm_ok,model_version,ok,processing_mode";
        const ready = currentMode === "deterministic" || body.llm_ok === true;
        const matches = !expectedMode || currentMode === expectedMode;
        if (!(body.ok === true && exact && ready && matches && (!expectedCommit || body.commit === expectedCommit))) process.exit(1);
        const page = await fetch("http://127.0.0.1:3000/workspace", { redirect: "manual" });
        if (page.status !== 200 || !(page.headers.get("content-type") || "").includes("text/html")) process.exit(1);
        const authResponse = await fetch("http://127.0.0.1:3000/api/workspace/auth");
        if (authResponse.status !== 200) process.exit(1);
        const auth = await authResponse.json();
        if (Object.keys(auth).sort().join(",") !== "actor,enabled" || auth.enabled !== true || auth.actor !== null) process.exit(1);
        process.stdout.write(currentMode);
      })().catch(() => process.exit(1));
  ' "$expected_commit" "$expected_mode" 2>/dev/null
}

wait_for_health() {
  local expected_commit="$1" attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if health_probe "$expected_commit"; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

wait_for_existing_health() {
  local expected_commit="${1-}" expected_mode="${2-}" attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if health_probe_existing "$expected_commit" "$expected_mode" >/dev/null; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

deterministic_readiness_probe() {
  local expected_commit="$1"
  compose exec -T app node -e '
    // demeu-deterministic-readiness:v1 is pure and makes no provider request.
    const expectedCommit = process.argv[1];
    fetch("http://127.0.0.1:3000/api/healthz?probe=extract")
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const body = await response.json();
        const exact = Object.keys(body).sort().join(",") === "commit,llm_ok,model_version,ok,processing_mode";
        process.exit(exact && body.ok === true && body.commit === expectedCommit && body.processing_mode === "deterministic" && body.llm_ok === true ? 0 : 1);
      })
      .catch(() => process.exit(1));
  ' "$expected_commit" >/dev/null 2>&1
}

anthropic_env_count() {
  compose exec -T app sh -c 'env | grep -c "^ANTHROPIC_API_KEY="' 2>/dev/null
}

deep_extraction_probe() {
  local expected_commit="$1"
  compose exec -T app node -e '
    const { createHmac } = require("node:crypto");
    const expectedCommit = process.argv[1];
    const timeoutMs = Number(process.argv[2]);
    const key = process.env.ANTHROPIC_API_KEY;
    const startedAt = Date.now();
    const fail = (category, status) => {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      process.stdout.write(`${category} status=${status} elapsed_ms=${elapsedMs}\n`);
      process.exit(1);
    };
    if (!key || !expectedCommit) fail("auth_rejected", 0);
    if (!Number.isInteger(timeoutMs)) fail("extraction_failed", 0);
    const proof = createHmac("sha256", key)
      .update(`demeu-health-extract:v1:${expectedCommit}`)
      .digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch("http://127.0.0.1:3000/api/healthz?probe=extract", {
      headers: { "x-demeu-health-proof": proof },
      signal: controller.signal,
    })
      .then(async (response) => {
        let body;
        try {
          body = await response.json();
        } catch {
          fail("extraction_failed", response.status);
        }
        const keys = Object.keys(body).sort().join(",");
        const exactKeys = keys === "commit,llm_ok,model_version,ok,processing_mode";
        if (
          response.status === 200 && exactKeys && body.ok === true &&
          body.commit === expectedCommit && body.llm_ok === true &&
          body.processing_mode === "external_llm"
        ) process.exit(0);
        fail(response.status === 404 ? "auth_rejected" : "extraction_failed", response.status);
      })
      .catch((error) => fail(error?.name === "AbortError" ? "timeout" : "extraction_failed", 0))
      .finally(() => clearTimeout(timer));
  ' "$expected_commit" "$DEEP_PROBE_TIMEOUT_MS" 2>/dev/null
}

read_sha_marker() {
  local path="$1" value
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  value="$(cat "$path")" || return 2
  case "$value" in
    ''|*[!0-9a-f]*) return 2 ;;
  esac
  [ "${#value}" -ge 7 ] && [ "${#value}" -le 40 ] || return 2
  printf '%s' "$value"
}

snapshot_deploy_markers() {
  local value
  if value="$(read_sha_marker .deploy_green_sha)"; then
    OLD_GREEN_SHA="$value"
    OLD_GREEN_SHA_PRESENT=1
  elif [ -e .deploy_green_sha ]; then
    die ".deploy_green_sha is invalid"
  fi
  if value="$(read_sha_marker .deploy_prev_sha)"; then
    OLD_PREV_SHA="$value"
    OLD_PREV_SHA_PRESENT=1
  elif [ -e .deploy_prev_sha ]; then
    die ".deploy_prev_sha is invalid"
  fi
}

restore_deploy_markers() {
  local failed=0
  if [ "$OLD_GREEN_SHA_PRESENT" = "1" ]; then
    printf '%s\n' "$OLD_GREEN_SHA" > .deploy_green_sha || failed=1
  else
    rm -f .deploy_green_sha || failed=1
  fi
  if [ "$OLD_PREV_SHA_PRESENT" = "1" ]; then
    printf '%s\n' "$OLD_PREV_SHA" > .deploy_prev_sha || failed=1
  else
    rm -f .deploy_prev_sha || failed=1
  fi
  return "$failed"
}

image_commit_sha() {
  local image="$1" value
  value="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" \
    | awk -F= '$1 == "COMMIT_SHA" { count++; value=substr($0,12) } END { if (count == 1) printf "%s", value; else exit 1 }')" \
    || return 1
  [[ "$value" =~ ^[0-9a-f]{7,40}$ ]] || return 1
  printf '%s' "$value"
}

assert_marker_only_child_layer() {
  local base="$1" prepared="$2" schema="$3" status=0
  PREPARED_IMAGE_ARCHIVE="$(mktemp "${APP_DIR}/.prepared-recovery-image.XXXXXX")" || return 1
  if ! docker image save --output "$PREPARED_IMAGE_ARCHIVE" "$prepared"; then
    rm -f "$PREPARED_IMAGE_ARCHIVE"
    PREPARED_IMAGE_ARCHIVE=""
    return 1
  fi
  docker run --rm --network none --read-only --cap-drop ALL --user 0 \
    --security-opt no-new-privileges \
    --mount "type=bind,src=${PREPARED_IMAGE_ARCHIVE},dst=/archive/image.tar,readonly" \
    --tmpfs /work:rw,noexec,nosuid,nodev,size=16777216 \
    --entrypoint node "$base" -e '
      // demeu-recovery-layer:v1
      const fs = require("node:fs");
      const { spawnSync } = require("node:child_process");
      const archive = process.argv[1];
      const work = process.argv[2];
      const expectedSchema = process.argv[3];
      const baseAppPath = process.argv[4];
      const fail = () => process.exit(1);
      const untar = (...args) => {
        const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
        if (result.status !== 0) fail();
        return result.stdout;
      };
      try {
        untar("-xf", archive, "-C", work, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(`${work}/manifest.json`, "utf8"));
        if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0].Layers)
          || manifest[0].Layers.length < 1) fail();
        const layer = manifest[0].Layers.at(-1);
        if (typeof layer !== "string" || layer.startsWith("/") || layer.includes("..")
          || !/^[A-Za-z0-9._/-]+$/.test(layer)) fail();
        untar("-xf", archive, "-C", work, layer);
        const layerPath = `${work}/${layer}`;
        const layerInfo = fs.lstatSync(layerPath);
        if (!layerInfo.isFile() || layerInfo.isSymbolicLink() || layerInfo.size < 1 || layerInfo.size > 1048576) fail();
        const header = Buffer.alloc(2);
        const descriptor = fs.openSync(layerPath, "r");
        try {
          if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) fail();
        } finally {
          fs.closeSync(descriptor);
        }
        const compressed = header[0] === 0x1f && header[1] === 0x8b;
        const entries = untar(compressed ? "-tzf" : "-tf", layerPath).trim().split("\n").filter(Boolean)
          .map((entry) => entry.replace(/^\.\//, ""));
        const markerOnly = entries.length === 1 && entries[0] === "app/referral-schema-version";
        const markerWithParent = entries.length === 2 && entries[0] === "app/"
          && entries[1] === "app/referral-schema-version";
        if (!markerOnly && !markerWithParent) fail();
        fs.mkdirSync(`${work}/layer`, { mode: 0o700 });
        untar(compressed ? "-xzf" : "-xf", layerPath, "-C", `${work}/layer`);
        const app = fs.lstatSync(`${work}/layer/app`);
        const baseApp = fs.lstatSync(baseAppPath);
        const marker = fs.lstatSync(`${work}/layer/app/referral-schema-version`);
        if (!app.isDirectory() || app.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink()) fail();
        if (markerWithParent && (!baseApp.isDirectory() || baseApp.isSymbolicLink()
          || app.uid !== baseApp.uid || app.gid !== baseApp.gid
          || (app.mode & 0o7777) !== (baseApp.mode & 0o7777))) fail();
        if (fs.readdirSync(`${work}/layer`).join(",") !== "app"
          || fs.readdirSync(`${work}/layer/app`).join(",") !== "referral-schema-version") fail();
        const value = fs.readFileSync(`${work}/layer/app/referral-schema-version`, "utf8");
        process.exit(value === `${expectedSchema}\n` ? 0 : 1);
      } catch { fail(); }
    ' /archive/image.tar /work "$schema" /app >/dev/null 2>&1 || status=1
  rm -f "$PREPARED_IMAGE_ARCHIVE" || status=1
  PREPARED_IMAGE_ARCHIVE=""
  return "$status"
}

assert_prepared_recovery_image() {
  local prepared="$1" expected_commit="$2" running latest resolved full short source_schema image_schema checkout_commit
  local current_config prepared_config
  local -a current_layers prepared_layers

  running="$(docker inspect --format '{{.Image}}' demeu-app 2>/dev/null)" || return 1
  [[ "$running" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  latest="$(resolve_recovery_image demeu-app:latest)" || return 1
  [ "$running" = "$latest" ] || return 1
  assert_recovery_image_marker_absent "$running" || return 1
  if [ "$OLD_GREEN_SHA_PRESENT" = "1" ]; then
    [ "$OLD_GREEN_SHA" = "$expected_commit" ] || return 1
  fi
  if [ "$SERVER_GIT_MODE" = "1" ]; then
    [ "$PREVIOUS_SHA" = "$expected_commit" ] || return 1
  else
    checkout_commit="$(git rev-parse --short HEAD)" || return 1
    [ "$checkout_commit" = "$expected_commit" ] || return 1
  fi
  resolved="$(resolve_recovery_image "$prepared")" || return 1
  [ "$resolved" = "$prepared" ] || return 1
  [ "$(image_commit_sha "$running")" = "$expected_commit" ] || return 1
  [ "$(image_commit_sha "$prepared")" = "$expected_commit" ] || return 1

  full="$(git rev-parse --verify "${expected_commit}^{commit}" 2>/dev/null)" || return 1
  short="$(git rev-parse --short "$full")" || return 1
  [ "$expected_commit" = "$short" ] || [ "$expected_commit" = "$full" ] || return 1
  source_schema="$(git show "${full}:deploy/referral-schema-version" 2>/dev/null | tr -d '\n\r')" || return 1
  [[ "$source_schema" =~ ^[1-6]$ ]] || return 1
  image_schema="$(read_recovery_image_schema "$prepared")" || return 1
  [ "$image_schema" = "$source_schema" ] || return 1

  current_config="$(docker image inspect --format '{{json .Config}}' "$running")" || return 1
  prepared_config="$(docker image inspect --format '{{json .Config}}' "$prepared")" || return 1
  [ "$current_config" = "$prepared_config" ] || return 1
  mapfile -t current_layers < <(docker image inspect --format '{{join .RootFS.Layers "\n"}}' "$running") \
    || return 1
  mapfile -t prepared_layers < <(docker image inspect --format '{{join .RootFS.Layers "\n"}}' "$prepared") \
    || return 1
  [ "${#current_layers[@]}" -gt 0 ] \
    && [ "${#prepared_layers[@]}" -eq "$(( ${#current_layers[@]} + 1 ))" ] || return 1
  local index
  for ((index = 0; index < ${#current_layers[@]}; index++)); do
    [[ "${current_layers[index]}" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
    [ "${current_layers[index]}" = "${prepared_layers[index]}" ] || return 1
  done
  [[ "${prepared_layers[-1]}" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  assert_marker_only_child_layer "$running" "$prepared" "$source_schema" || return 1
}

snapshot_recovery_image() {
  local current_health_ok=0 detected_mode="" expected_commit="${OLD_GREEN_SHA-}"
  if docker image inspect "$LAST_GREEN_IMAGE" >/dev/null 2>&1; then
    LAST_GREEN_SAFE=1
  fi
  if [ -n "$PREPARED_RECOVERY_IMAGE_ID" ]; then
    expected_commit="$PREPARED_RECOVERY_COMMIT"
    LAST_GREEN_SAFE=0
  fi
  if docker image inspect demeu-app:latest >/dev/null 2>&1; then
    if [ -n "$expected_commit" ]; then
      detected_mode="$(health_probe_existing "$expected_commit" || true)"
    else
      detected_mode="$(health_probe_existing || true)"
    fi
    if [ -n "$detected_mode" ]; then
      CURRENT_PROCESSING_MODE="$detected_mode"
      current_health_ok=1
    fi
    if [ "$current_health_ok" = "1" ]; then
      PREEXISTING_APP_PRESENT=1
      if [ -n "$PREPARED_RECOVERY_IMAGE_ID" ]; then
        assert_prepared_recovery_image "$PREPARED_RECOVERY_IMAGE_ID" "$PREPARED_RECOVERY_COMMIT" \
          || die "prepared recovery image provenance is invalid"
        docker image tag "$PREPARED_RECOVERY_IMAGE_ID" "$RECOVERY_IMAGE"
        RECOVERY_IMAGE_ID="$(resolve_recovery_image "$RECOVERY_IMAGE")" \
          || die "prepared recovery image identity could not be pinned"
        [ "$RECOVERY_IMAGE_ID" = "$PREPARED_RECOVERY_IMAGE_ID" ] \
          || die "prepared recovery image identity changed while pinning"
        RECOVERY_IMAGE_AVAILABLE=1
        RECOVERY_EXPECTED_SHA="$PREPARED_RECOVERY_COMMIT"
        LAST_GREEN_SAFE=1
      else
        docker image tag demeu-app:latest "$LAST_GREEN_IMAGE"
        LAST_GREEN_SAFE=1
      fi
    elif [ "$OLD_GREEN_SHA_PRESENT" = "1" ] || [ "$LAST_GREEN_SAFE" = "1" ]; then
      die "existing production health could not be verified before build"
    fi
  elif [ -n "$PREPARED_RECOVERY_IMAGE_ID" ]; then
    die "prepared recovery image requires the existing production image and container"
  fi
  if [ "$LAST_GREEN_SAFE" = "1" ] && [ "$RECOVERY_IMAGE_AVAILABLE" != "1" ]; then
    docker image tag "$LAST_GREEN_IMAGE" "$RECOVERY_IMAGE"
    RECOVERY_IMAGE_ID="$(resolve_recovery_image "$RECOVERY_IMAGE")" || die "recovery image identity could not be pinned"
    RECOVERY_IMAGE_AVAILABLE=1
  fi
  if [ "$RECOVERY_IMAGE_AVAILABLE" = "1" ]; then
    assert_recovery_image_compatible "$RECOVERY_IMAGE_ID" \
      || die "saved recovery image cannot read current persistent state"
    assert_private_mis_readable "$RECOVERY_IMAGE_ID" \
      || die "MIS credentials are invalid or unreadable by saved runtime UID"
  fi
}

recover_deployment() {
  local recovery_failed=0 last_green_restored=0

  if [ "$ACTIVATION_STARTED" != "1" ] || [ "$DEPLOY_SUCCEEDED" = "1" ]; then
    return 0
  fi
  if [ "$RECOVERY_RUNNING" = "1" ]; then
    return 1
  fi
  RECOVERY_RUNNING=1
  log "activation failed; recovering the last green release"
  if [ "$RUNTIME_MUTATION_STARTED" = "1" ] && [ "$RECOVERY_IMAGE_AVAILABLE" = "1" ]; then
    if ! assert_recovery_image_compatible "$RECOVERY_IMAGE_ID" || ! assert_private_mis_readable "$RECOVERY_IMAGE_ID"; then
      printf '[deploy] FAIL: recovery image is incompatible with current persistent state or private mounts; retain current runtime and use validated recovery\n' >&2
      return 1
    fi
  fi

  if [ "$SERVER_GIT_MODE" = "1" ] && [ -n "$PREVIOUS_SHA" ]; then
    git reset --hard --quiet "$PREVIOUS_SHA" || recovery_failed=1
  fi

  if [ "$COMPOSE_READY" = "1" ]; then
    if [ "$PREEXISTING_APP_PRESENT" = "1" ] \
      && [ "$RUNTIME_MUTATION_STARTED" != "1" ]; then
      if [ "$OLD_GREEN_SHA_PRESENT" = "1" ]; then
        wait_for_existing_health "$OLD_GREEN_SHA" "$CURRENT_PROCESSING_MODE" || recovery_failed=1
      else
        wait_for_existing_health "" "$CURRENT_PROCESSING_MODE" || recovery_failed=1
      fi
      if [ "$recovery_failed" = "0" ]; then
        last_green_restored=1
      fi
    elif [ "$RECOVERY_IMAGE_AVAILABLE" = "1" ]; then
      docker image tag "$RECOVERY_IMAGE_ID" "$LAST_GREEN_IMAGE" || recovery_failed=1
      docker image tag "$LAST_GREEN_IMAGE" demeu-app:latest || recovery_failed=1
      compose up -d --no-build --force-recreate app >/dev/null \
        || recovery_failed=1
      if [ "$recovery_failed" = "0" ] && [ -n "$RECOVERY_EXPECTED_SHA" ]; then
        wait_for_existing_health "$RECOVERY_EXPECTED_SHA" "$CURRENT_PROCESSING_MODE" || recovery_failed=1
      elif [ "$recovery_failed" = "0" ] && [ "$OLD_GREEN_SHA_PRESENT" = "1" ]; then
        wait_for_existing_health "$OLD_GREEN_SHA" "$CURRENT_PROCESSING_MODE" || recovery_failed=1
      elif [ "$recovery_failed" = "0" ]; then
        wait_for_existing_health "" "$CURRENT_PROCESSING_MODE" || recovery_failed=1
      fi
      if [ "$recovery_failed" = "0" ]; then
        last_green_restored=1
      fi
    elif [ "$LAST_GREEN_SAFE" = "1" ]; then
      local fallback_id
      fallback_id="$(resolve_recovery_image "$LAST_GREEN_IMAGE")" || return 1
      assert_recovery_image_compatible "$fallback_id" && assert_private_mis_readable "$fallback_id" || return 1
      docker image tag "$fallback_id" demeu-app:latest || recovery_failed=1
      compose up -d --no-build --force-recreate app >/dev/null \
        || recovery_failed=1
      if [ "$recovery_failed" = "0" ]; then
        wait_for_existing_health "" "$CURRENT_PROCESSING_MODE" || recovery_failed=1
      fi
      if [ "$recovery_failed" = "0" ]; then
        last_green_restored=1
      fi
    else
      compose rm -sf app >/dev/null 2>&1 || recovery_failed=1
    fi
  fi

  restore_deploy_markers || recovery_failed=1

  if [ "$recovery_failed" = "0" ]; then
    log "recovery complete; previous production state is active"
    if [ "$last_green_restored" = "1" ]; then
      printf '[deploy] FAIL: last green release is active\n' >&2
    fi
    return 0
  fi
  printf '[deploy] FAIL: automatic recovery could not verify a green production state\n' >&2
  return 1
}

handle_exit() {
  local status="$?" recovery_status=0
  trap - EXIT INT TERM
  set +e

  if [ -n "$PREPARED_IMAGE_ARCHIVE" ]; then
    rm -f "$PREPARED_IMAGE_ARCHIVE" >/dev/null 2>&1 || true
    PREPARED_IMAGE_ARCHIVE=""
  fi

  if [ "$status" -ne 0 ] && [ "$ACTIVATION_STARTED" = "1" ] \
    && [ "$DEPLOY_SUCCEEDED" != "1" ]; then
    recover_deployment || recovery_status=1
  fi
  release_deploy_lock

  if [ "$status" -eq 0 ] && [ "$recovery_status" -ne 0 ]; then
    status=1
  fi
  exit "$status"
}

handle_signal() {
  local signal_name="$1" exit_code="$2"
  printf '[deploy] interrupted by %s; recovery will run before exit\n' "$signal_name" >&2
  exit "$exit_code"
}

activate_server_release() {
  local supplied_sha="${1-}" env_fingerprint commit_sha env_count

  require_command docker
  require_command git
  require_command awk
  require_command cksum

  cd "$APP_DIR" || die "APP_DIR does not exist"
  acquire_deploy_lock
  load_processing_mode
  if [ "$PROCESSING_MODE" = "external_llm" ]; then
    require_deep_probe_authorization
  fi
  validate_secret_file
  snapshot_deploy_markers
  env_fingerprint="$(cksum .env | awk '{ print $1 ":" $2 }')"
  validate_server_config

  if [ -z "$supplied_sha" ]; then
    SERVER_GIT_MODE=1
    assert_clean_worktree
    PREVIOUS_SHA="$(git rev-parse --short HEAD)"
    ACTIVATION_STARTED=1
    log "updating ${BRANCH} on server"
    git pull --ff-only --quiet origin "$BRANCH"
    commit_sha="$(git rev-parse --short HEAD)"
    assert_clean_worktree
  else
    case "$supplied_sha" in
      ''|*[!0-9a-f]* ) die "rsync commit SHA is invalid" ;;
    esac
    [ "${#supplied_sha}" -ge 7 ] && [ "${#supplied_sha}" -le 40 ] \
      || die "rsync commit SHA is invalid"
    commit_sha="$supplied_sha"
    ACTIVATION_STARTED=1
  fi

  if [ -z "$supplied_sha" ]; then
    audit_git_history
  fi
  configure_compose
  COMPOSE_READY=1
  snapshot_recovery_image

  export COMMIT_SHA="$commit_sha"
  log "building commit ${COMMIT_SHA}"
  RUNTIME_MUTATION_STARTED=1
  compose build --pull app
  assert_private_mis_readable demeu-app:latest || die "MIS credential JSON or mapped runtime UID readability is invalid"
  compose up -d --remove-orphans

  if ! wait_for_health "$COMMIT_SHA"; then
    die "candidate health check failed"
  fi

  if [ "$PROCESSING_MODE" = "external_llm" ]; then
    env_count="$(anthropic_env_count || true)"
    if [ "$env_count" != "1" ]; then
      die "container must contain exactly one ANTHROPIC_API_KEY variable"
    fi
  fi

  [ "$env_fingerprint" = "$(cksum .env | awk '{ print $1 ":" $2 }')" ] || {
    die ".env changed during deployment"
  }

  if [ "$PROCESSING_MODE" = "external_llm" ]; then
    local deep_probe_diagnostic
    if ! deep_probe_diagnostic="$(deep_extraction_probe "$COMMIT_SHA")"; then
      if [[ ! "$deep_probe_diagnostic" =~ ^(auth_rejected|extraction_failed|timeout)\ status=[0-9]{1,3}\ elapsed_ms=[0-9]+$ ]]; then
        deep_probe_diagnostic="extraction_failed status=0 elapsed_ms=0"
      fi
      die "candidate deep extraction gate failed: ${deep_probe_diagnostic}"
    fi
  elif ! deterministic_readiness_probe "$COMMIT_SHA"; then
    die "candidate deterministic readiness gate failed"
  fi

  docker image tag demeu-app:latest "$LAST_GREEN_IMAGE"
  LAST_GREEN_SAFE=0
  printf '%s\n' "$COMMIT_SHA" > .deploy_green_sha
  if [ -n "$PREVIOUS_SHA" ]; then
    printf '%s\n' "$PREVIOUS_SHA" > .deploy_prev_sha
  fi
  DEPLOY_SUCCEEDED=1
  docker image rm "$RECOVERY_IMAGE" >/dev/null 2>&1 || true
  log "release is healthy: commit verified, processing_mode=${PROCESSING_MODE}"
}

check_prepared_recovery() {
  local detected_mode
  [ -n "$PREPARED_RECOVERY_IMAGE_ID" ] && [ -n "$PREPARED_RECOVERY_COMMIT" ] \
    || die "prepared recovery preflight requires both one-shot variables"
  require_command docker
  require_command git
  require_command awk
  require_command mktemp

  cd "$APP_DIR" || die "APP_DIR does not exist"
  acquire_deploy_lock
  load_processing_mode
  validate_secret_file
  snapshot_deploy_markers
  validate_server_config
  configure_compose
  COMPOSE_READY=1

  detected_mode="$(health_probe_existing "$PREPARED_RECOVERY_COMMIT" || true)"
  [ -n "$detected_mode" ] || die "existing production health does not match prepared recovery commit"
  CURRENT_PROCESSING_MODE="$detected_mode"
  assert_prepared_recovery_image "$PREPARED_RECOVERY_IMAGE_ID" "$PREPARED_RECOVERY_COMMIT" \
    || die "prepared recovery image provenance is invalid"
  assert_recovery_image_compatible "$PREPARED_RECOVERY_IMAGE_ID" \
    || die "prepared recovery image cannot read current persistent state"
  assert_private_mis_readable "$PREPARED_RECOVERY_IMAGE_ID" \
    || die "MIS credentials are invalid or unreadable by prepared runtime UID"
  log "prepared recovery preflight passed: provenance, persistent state and private mounts"
}

run_rsync_mode() {
  local repo_root commit_sha
  require_command git
  require_command rsync
  require_command ssh

  [[ "$SERVER" =~ ^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$ ]] \
    || die "SERVER is invalid"

  repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_root"
  assert_clean_worktree rsync-source
  audit_git_history
  commit_sha="$(git rev-parse --short HEAD)"

  log "syncing commit ${commit_sha} to server"
  rsync -az --delete \
    --filter='protect .env' --filter='protect .env.*' \
    --filter='protect .deploy.lock' \
    --filter='protect .deploy_prev_sha' --filter='protect .deploy_green_sha' \
    --filter='protect .git' \
    --exclude='.env' --exclude='.env.*' \
    --exclude='.deploy.lock' \
    --exclude='.deploy_prev_sha' --exclude='.deploy_green_sha' \
    --exclude='.git' --exclude='.git/' --exclude='.next/' --exclude='node_modules/' \
    --exclude='.orchestrator/' --exclude='.worktrees/' --exclude='.venv/' \
    --exclude='scripts/' --exclude='tests/' \
    --include='/eval/' --include='/eval/report.json' --exclude='/eval/***' \
    --include='/reports/' --include='/reports/redflags/' \
    --include='/reports/redflags/redflags-benchmark-v1.json' \
    --include='/reports/referral-refusal-baseline-v0.json' \
    --include='/reports/wait-time-baseline-v0.json' \
    --include='/reports/lab-load-v1.json' --exclude='/reports/***' \
    --exclude='data/raw/' --exclude='data/processed/' \
    --exclude='*.csv' --exclude='*.parquet' --exclude='*.zip' \
    --exclude='*.npy' --exclude='*.npz' --exclude='*.pkl' \
    --exclude='*.joblib' --exclude='*.bin' \
    -- ./ "${SERVER}:${APP_DIR}/"

  ssh -- "$SERVER" \
    "cd '$APP_DIR' && APP_DIR='$APP_DIR' DEMEU_DEEP_PROBE='$DEEP_PROBE_AUTHORIZATION' DEMEU_PREPARED_RECOVERY_IMAGE_ID='$PREPARED_RECOVERY_IMAGE_ID' DEMEU_PREPARED_RECOVERY_COMMIT='$PREPARED_RECOVERY_COMMIT' bash deploy/deploy.sh --activate-rsync '$commit_sha'"
}

validate_common_inputs
trap 'handle_exit' EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

if [ "${1-}" = --check-prepared-recovery ]; then
  [ "$#" -eq 1 ] || die "prepared recovery preflight does not accept extra arguments"
  check_prepared_recovery
  exit 0
fi

case "$DEPLOY_MODE" in
  rsync)
    [ "$#" -eq 0 ] || die "rsync mode does not accept arguments"
    run_rsync_mode
    ;;
  git)
    case "${1-}" in
      '')
        [ "$#" -eq 0 ] || die "unexpected deploy arguments"
        activate_server_release
        ;;
      --activate-rsync)
        [ "$#" -eq 2 ] || die "invalid internal rsync activation"
        activate_server_release "$2"
        ;;
      *) die "unknown deploy command" ;;
    esac
    ;;
  *) die "DEPLOY_MODE must be git or rsync" ;;
esac
