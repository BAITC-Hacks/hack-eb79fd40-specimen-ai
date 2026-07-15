#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/demeu}"
SERVER="${SERVER:-root@109.123.248.16}"
BRANCH="${BRANCH:-main}"
DEPLOY_MODE="${DEPLOY_MODE:-git}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"
LAST_GREEN_IMAGE="demeu-app:last-green"
RECOVERY_IMAGE="demeu-app:deploy-recovery"
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
LAST_GREEN_SAFE=0
PREEXISTING_APP_PRESENT=0
RUNTIME_MUTATION_STARTED=0
OLD_GREEN_SHA=""
OLD_GREEN_SHA_PRESENT=0
OLD_PREV_SHA=""
OLD_PREV_SHA_PRESENT=0

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

validate_secret_file() {
  [ -f .env ] || die ".env is missing in APP_DIR"
  [ ! -L .env ] || die ".env must not be a symlink"
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    die ".env must not be tracked by git"
  fi

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
  [ "$APP_BASE_URL" = "https://${DEMEU_DOMAIN}" ] \
    || die "APP_BASE_URL must exactly match the selected HTTPS domain"
  export DEMEU_DOMAIN APP_PORT TLS_BRANCH APP_BASE_URL

  DEMEU_DOMAIN="$DEMEU_DOMAIN" APP_PORT="$APP_PORT" \
    ./deploy/tls.sh preflight >/dev/null
}

configure_compose() {
  COMPOSE_ARGS=(-f docker-compose.yml)
  case "$TLS_BRANCH" in
    branch-b-caddy)
      COMPOSE_ARGS+=(-f deploy/compose.caddy.yml)
      DEMEU_DOMAIN="$DEMEU_DOMAIN" APP_PORT="$APP_PORT" \
        ./deploy/tls.sh branch-b-config
      ;;
    branch-a-nginx|branch-a-caddy)
      COMPOSE_ARGS+=(-f deploy/compose.host-proxy.yml)
      docker compose "${COMPOSE_ARGS[@]}" config --quiet
      ;;
  esac
}

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

health_probe() {
  local expected_commit="$1"
  compose exec -T app node -e '
    const expected = process.argv[1];
    fetch("http://127.0.0.1:3000/api/healthz")
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const body = await response.json();
        process.exit(body.ok === true && body.commit === expected && body.llm_ok === true ? 0 : 1);
      })
      .catch(() => process.exit(1));
  ' "$expected_commit" >/dev/null 2>&1
}

health_probe_any_commit() {
  compose exec -T app node -e '
    fetch("http://127.0.0.1:3000/api/healthz")
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const body = await response.json();
        process.exit(body.ok === true && body.llm_ok === true ? 0 : 1);
      })
      .catch(() => process.exit(1));
  ' >/dev/null 2>&1
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

wait_for_any_green_health() {
  local attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if health_probe_any_commit; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

anthropic_env_count() {
  compose exec -T app sh -c 'env | grep -c "^ANTHROPIC_API_KEY="' 2>/dev/null
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

snapshot_recovery_image() {
  local current_health_ok=0
  if docker image inspect "$LAST_GREEN_IMAGE" >/dev/null 2>&1; then
    LAST_GREEN_SAFE=1
  fi
  if docker image inspect demeu-app:latest >/dev/null 2>&1; then
    if [ "$OLD_GREEN_SHA_PRESENT" = "1" ]; then
      health_probe "$OLD_GREEN_SHA" && current_health_ok=1
    else
      health_probe_any_commit && current_health_ok=1
    fi
    if [ "$current_health_ok" = "1" ]; then
      PREEXISTING_APP_PRESENT=1
      docker image tag demeu-app:latest "$LAST_GREEN_IMAGE"
      LAST_GREEN_SAFE=1
    elif [ "$OLD_GREEN_SHA_PRESENT" = "1" ] || [ "$LAST_GREEN_SAFE" = "1" ]; then
      die "existing production health could not be verified before build"
    fi
  fi
  if [ "$LAST_GREEN_SAFE" = "1" ]; then
    docker image tag "$LAST_GREEN_IMAGE" "$RECOVERY_IMAGE"
    RECOVERY_IMAGE_AVAILABLE=1
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

  if [ "$SERVER_GIT_MODE" = "1" ] && [ -n "$PREVIOUS_SHA" ]; then
    git reset --hard --quiet "$PREVIOUS_SHA" || recovery_failed=1
  fi

  if [ "$COMPOSE_READY" = "1" ]; then
    if [ "$PREEXISTING_APP_PRESENT" = "1" ] \
      && [ "$RUNTIME_MUTATION_STARTED" != "1" ]; then
      if [ "$OLD_GREEN_SHA_PRESENT" = "1" ]; then
        wait_for_health "$OLD_GREEN_SHA" || recovery_failed=1
      else
        wait_for_any_green_health || recovery_failed=1
      fi
      if [ "$recovery_failed" = "0" ]; then
        last_green_restored=1
      fi
    elif [ "$RECOVERY_IMAGE_AVAILABLE" = "1" ]; then
      docker image tag "$RECOVERY_IMAGE" "$LAST_GREEN_IMAGE" || recovery_failed=1
      docker image tag "$LAST_GREEN_IMAGE" demeu-app:latest || recovery_failed=1
      compose up -d --no-build --force-recreate app >/dev/null \
        || recovery_failed=1
      if [ "$recovery_failed" = "0" ] && [ "$OLD_GREEN_SHA_PRESENT" = "1" ]; then
        wait_for_health "$OLD_GREEN_SHA" || recovery_failed=1
      elif [ "$recovery_failed" = "0" ]; then
        wait_for_any_green_health || recovery_failed=1
      fi
      if [ "$recovery_failed" = "0" ]; then
        last_green_restored=1
      fi
    elif [ "$LAST_GREEN_SAFE" = "1" ]; then
      docker image tag "$LAST_GREEN_IMAGE" demeu-app:latest || recovery_failed=1
      compose up -d --no-build --force-recreate app >/dev/null \
        || recovery_failed=1
      if [ "$recovery_failed" = "0" ]; then
        wait_for_any_green_health || recovery_failed=1
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
  compose up -d --remove-orphans

  if ! wait_for_health "$COMMIT_SHA"; then
    die "candidate health check failed"
  fi

  env_count="$(anthropic_env_count || true)"
  if [ "$env_count" != "1" ]; then
    die "container must contain exactly one ANTHROPIC_API_KEY variable"
  fi

  [ "$env_fingerprint" = "$(cksum .env | awk '{ print $1 ":" $2 }')" ] || {
    die ".env changed during deployment"
  }

  docker image tag demeu-app:latest "$LAST_GREEN_IMAGE"
  LAST_GREEN_SAFE=0
  printf '%s\n' "$COMMIT_SHA" > .deploy_green_sha
  if [ -n "$PREVIOUS_SHA" ]; then
    printf '%s\n' "$PREVIOUS_SHA" > .deploy_prev_sha
  fi
  DEPLOY_SUCCEEDED=1
  docker image rm "$RECOVERY_IMAGE" >/dev/null 2>&1 || true
  log "release is healthy: commit verified, llm_ok=true"
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
    --exclude='.env' --exclude='.env.*' \
    --exclude='.deploy.lock' \
    --exclude='.deploy_prev_sha' --exclude='.deploy_green_sha' \
    --exclude='.git/' --exclude='.next/' --exclude='node_modules/' \
    --exclude='.orchestrator/' --exclude='.worktrees/' --exclude='.venv/' \
    --exclude='scripts/' --exclude='tests/' --exclude='eval/' --exclude='reports/' \
    --exclude='data/raw/' --exclude='data/processed/' \
    --exclude='*.csv' --exclude='*.parquet' --exclude='*.zip' \
    --exclude='*.npy' --exclude='*.npz' --exclude='*.pkl' \
    --exclude='*.joblib' --exclude='*.bin' \
    -- ./ "${SERVER}:${APP_DIR}/"

  ssh -- "$SERVER" \
    "cd '$APP_DIR' && APP_DIR='$APP_DIR' bash deploy/deploy.sh --activate-rsync '$commit_sha'"
}

validate_common_inputs
trap 'handle_exit' EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

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
