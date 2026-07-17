#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/demeu}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"
LAST_GREEN_IMAGE="demeu-app:last-green"
RECOVERY_IMAGE="demeu-app:rollback-recovery"
LOCK_FD=""
LOCK_HELD=0
ACTIVATION_STARTED=0
ROLLBACK_SUCCEEDED=0
RECOVERY_RUNNING=0
COMPOSE_READY=0
RECOVERY_IMAGE_AVAILABLE=0
COMPOSE_ARGS=()
OLD_GREEN_SHA=""
OLD_GREEN_FULL=""
OLD_GREEN_MODEL=""
OLD_PREV_SHA=""
TARGET_FULL=""
TARGET_SHORT=""
TARGET_MODEL=""
ENV_SNAPSHOT=""
ENV_SNAPSHOT_READY=0
ENV_FINGERPRINT=""
ENV_ORIGINAL_MODE=""
ENV_ORIGINAL_UID=""
ENV_ORIGINAL_GID=""

log() {
  printf '[rollback] %s\n' "$*"
}

die() {
  printf '[rollback] FAIL: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

validate_inputs() {
  [ "$#" -le 1 ] || die "usage: bash deploy/rollback.sh [full-commit-sha]"
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
  [[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]{0,2}$ ]] \
    || die "HEALTH_ATTEMPTS must be a canonical integer from 1 to 999"
  [[ "$HEALTH_INTERVAL_SECONDS" =~ ^(0|[1-9][0-9]{0,2})$ ]] \
    || die "HEALTH_INTERVAL_SECONDS must be a canonical integer from 0 to 999"
  if [ "$#" -eq 1 ]; then
    [[ "$1" =~ ^[0-9a-f]{40}$ ]] \
      || die "explicit rollback target must be a full 40-character commit SHA"
  fi
}

acquire_deploy_lock() {
  exec {LOCK_FD}>"$APP_DIR/.deploy.lock"
  if ! flock -n "$LOCK_FD"; then
    die "another deployment or rollback is already running"
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

assert_clean_worktree() {
  local status entry
  status="$(git status --porcelain --untracked-files=all --ignored=matching)" \
    || die "git worktree status could not be verified"
  while IFS= read -r entry; do
    case "$entry" in
      ''|'?? .env'|'?? .deploy.lock'|'?? .deploy_prev_sha'|'?? .deploy_green_sha') ;;
      '!! .env'|'!! .deploy.lock'|'!! .deploy_prev_sha'|'!! .deploy_green_sha') ;;
      *) die "server worktree is dirty; refuse to roll back an unsafe tree" ;;
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
  if [ "$DEMEU_DOMAIN" = "109.123.248.16" ] \
    && [ "$TLS_BRANCH" != "branch-b-caddy" ]; then
    die "109.123.248.16 requires TLS_BRANCH=branch-b-caddy"
  fi
  [ "$APP_BASE_URL" = "https://${DEMEU_DOMAIN}" ] \
    || die "APP_BASE_URL must exactly match the selected HTTPS domain"
  export DEMEU_DOMAIN APP_PORT TLS_BRANCH APP_BASE_URL

  [ -x deploy/tls.sh ] || die "deploy/tls.sh is missing or not executable"
  DEMEU_DOMAIN="$DEMEU_DOMAIN" APP_PORT="$APP_PORT" TLS_BRANCH="$TLS_BRANCH" \
    ./deploy/tls.sh preflight >/dev/null
}

configure_compose() {
  COMPOSE_ARGS=(-f docker-compose.yml)
  case "$TLS_BRANCH" in
    branch-b-caddy)
      COMPOSE_ARGS+=(-f deploy/compose.caddy.yml)
      DEMEU_DOMAIN="$DEMEU_DOMAIN" APP_PORT="$APP_PORT" TLS_BRANCH="$TLS_BRANCH" \
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

resolve_commit() {
  local value="$1" full
  full="$(git rev-parse --verify "${value}^{commit}")" || return 1
  [[ "$full" =~ ^[0-9a-f]{40}$ ]] || return 1
  git merge-base --is-ancestor "$full" HEAD >/dev/null 2>&1 || return 1
  printf '%s' "$full"
}

model_version_at() {
  local commit="$1" version
  version="$(git show "${commit}:models/triage-lr-v1.json" \
    | tr -d '\n\r' \
    | sed -n 's/.*"model_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" \
    || return 1
  case "$version" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  printf '%s' "$version"
}

health_probe() {
  local expected_commit="$1" expected_model="$2"
  compose exec -T app node -e '
    const expectedCommit = process.argv[1];
    const expectedModel = process.argv[2];
    fetch("http://127.0.0.1:3000/api/healthz")
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const body = await response.json();
        process.exit(
          body.ok === true &&
          body.commit === expectedCommit &&
          body.model_version === expectedModel &&
          body.llm_ok === true ? 0 : 1
        );
      })
      .catch(() => process.exit(1));
  ' "$expected_commit" "$expected_model" >/dev/null 2>&1
}

wait_for_health() {
  local expected_commit="$1" expected_model="$2" attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if health_probe "$expected_commit" "$expected_model"; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

anthropic_env_count() {
  compose exec -T app sh -c 'env | grep -c "^ANTHROPIC_API_KEY="' 2>/dev/null
}

verify_anthropic_env_cardinality() {
  local count status
  if count="$(anthropic_env_count)"; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -ne 0 ]; then
    if [[ "$count" =~ ^[0-9]+$ ]]; then
      printf '[rollback] FAIL: container ANTHROPIC_API_KEY count=%s, expected 1\n' \
        "$count" >&2
    else
      printf '[rollback] FAIL: container environment cardinality check failed\n' >&2
    fi
    return 1
  fi
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    printf '[rollback] FAIL: container environment cardinality check returned invalid output\n' >&2
    return 1
  fi
  if [ "$count" != "1" ]; then
    printf '[rollback] FAIL: container ANTHROPIC_API_KEY count=%s, expected 1\n' \
      "$count" >&2
    return 1
  fi
}

file_fingerprint() {
  cksum "$1" | awk '{ print $1 ":" $2 }'
}

snapshot_env() {
  local snapshot_fingerprint
  [ -f .env ] && [ ! -L .env ] || return 1
  ENV_ORIGINAL_MODE="$(stat -c '%a' .env)" || return 1
  ENV_ORIGINAL_UID="$(stat -c '%u' .env)" || return 1
  ENV_ORIGINAL_GID="$(stat -c '%g' .env)" || return 1
  [[ "$ENV_ORIGINAL_MODE" =~ ^[0-7]{3,4}$ ]] || return 1
  [[ "$ENV_ORIGINAL_UID" =~ ^[0-9]+$ ]] || return 1
  [[ "$ENV_ORIGINAL_GID" =~ ^[0-9]+$ ]] || return 1

  ENV_SNAPSHOT="$(mktemp /tmp/demeu-rollback-env.XXXXXXXX)" || return 1
  [ -f "$ENV_SNAPSHOT" ] && [ ! -L "$ENV_SNAPSHOT" ] || return 1
  chmod 600 "$ENV_SNAPSHOT" || return 1
  cp -- .env "$ENV_SNAPSHOT" || return 1
  chmod 600 "$ENV_SNAPSHOT" || return 1
  [ "$(stat -c '%a' "$ENV_SNAPSHOT")" = "600" ] || return 1

  ENV_FINGERPRINT="$(file_fingerprint .env)" || return 1
  snapshot_fingerprint="$(file_fingerprint "$ENV_SNAPSHOT")" || return 1
  [ "$snapshot_fingerprint" = "$ENV_FINGERPRINT" ] || return 1
  [ -f .env ] && [ ! -L .env ] || return 1
  ENV_SNAPSHOT_READY=1
}

env_matches_snapshot() {
  local current_fingerprint
  [ "$ENV_SNAPSHOT_READY" = "1" ] || return 1
  [ -f "$ENV_SNAPSHOT" ] && [ ! -L "$ENV_SNAPSHOT" ] || return 1
  [ -f .env ] && [ ! -L .env ] || return 1
  current_fingerprint="$(file_fingerprint .env)" || return 1
  [ "$current_fingerprint" = "$ENV_FINGERPRINT" ] || return 1
  [ "$(stat -c '%a' .env)" = "$ENV_ORIGINAL_MODE" ] || return 1
  [ "$(stat -c '%u' .env)" = "$ENV_ORIGINAL_UID" ] || return 1
  [ "$(stat -c '%g' .env)" = "$ENV_ORIGINAL_GID" ] || return 1
}

restore_env_snapshot() {
  local temporary=".env.rollback.$$" temporary_uid temporary_gid
  [ "$ENV_SNAPSHOT_READY" = "1" ] || return 1
  [ -f "$ENV_SNAPSHOT" ] && [ ! -L "$ENV_SNAPSHOT" ] || return 1
  [ "$(file_fingerprint "$ENV_SNAPSHOT")" = "$ENV_FINGERPRINT" ] || return 1

  rm -f -- "$temporary" || return 1
  (umask 077 && cp -- "$ENV_SNAPSHOT" "$temporary") || return 1
  [ -f "$temporary" ] && [ ! -L "$temporary" ] || return 1
  chmod "$ENV_ORIGINAL_MODE" "$temporary" || return 1
  temporary_uid="$(stat -c '%u' "$temporary")" || return 1
  temporary_gid="$(stat -c '%g' "$temporary")" || return 1
  if [ "$temporary_uid" != "$ENV_ORIGINAL_UID" ] \
    || [ "$temporary_gid" != "$ENV_ORIGINAL_GID" ]; then
    chown "${ENV_ORIGINAL_UID}:${ENV_ORIGINAL_GID}" "$temporary" || return 1
  fi
  [ "$(stat -c '%a' "$temporary")" = "$ENV_ORIGINAL_MODE" ] || return 1
  [ "$(stat -c '%u' "$temporary")" = "$ENV_ORIGINAL_UID" ] || return 1
  [ "$(stat -c '%g' "$temporary")" = "$ENV_ORIGINAL_GID" ] || return 1
  mv -f -- "$temporary" .env || return 1
  env_matches_snapshot
}

cleanup_env_snapshot() {
  local failed=0
  rm -f -- .env.rollback.* >/dev/null 2>&1 || failed=1
  if [ -n "$ENV_SNAPSHOT" ]; then
    if [ -L "$ENV_SNAPSHOT" ]; then
      :
    elif [ -f "$ENV_SNAPSHOT" ]; then
      chmod 600 "$ENV_SNAPSHOT" >/dev/null 2>&1 || failed=1
    elif [ -e "$ENV_SNAPSHOT" ]; then
      failed=1
    fi
    rm -f -- "$ENV_SNAPSHOT" >/dev/null 2>&1 || failed=1
    if [ -e "$ENV_SNAPSHOT" ] || [ -L "$ENV_SNAPSHOT" ]; then
      failed=1
    fi
  fi
  ENV_SNAPSHOT_READY=0
  return "$failed"
}

write_marker() {
  local path="$1" value="$2" temporary
  temporary="${path}.rollback.$$"
  printf '%s\n' "$value" > "$temporary"
  mv -f -- "$temporary" "$path"
}

restore_markers() {
  local failed=0
  write_marker .deploy_green_sha "$OLD_GREEN_SHA" || failed=1
  write_marker .deploy_prev_sha "$OLD_PREV_SHA" || failed=1
  return "$failed"
}

recover_rollback() {
  local failed=0
  if [ "$ACTIVATION_STARTED" != "1" ] || [ "$ROLLBACK_SUCCEEDED" = "1" ]; then
    return 0
  fi
  if [ "$RECOVERY_RUNNING" = "1" ]; then
    return 1
  fi
  RECOVERY_RUNNING=1
  log "rollback activation failed; restoring the last green release"

  restore_env_snapshot || failed=1
  git reset --hard --quiet "$OLD_GREEN_FULL" || failed=1
  restore_markers || failed=1
  if [ "$COMPOSE_READY" = "1" ] && [ "$RECOVERY_IMAGE_AVAILABLE" = "1" ]; then
    docker image tag "$RECOVERY_IMAGE" "$LAST_GREEN_IMAGE" || failed=1
    docker image tag "$LAST_GREEN_IMAGE" demeu-app:latest || failed=1
    if [ "$failed" = "0" ]; then
      env_matches_snapshot || failed=1
    fi
    if [ "$failed" = "0" ]; then
      export COMMIT_SHA="$OLD_GREEN_SHA"
      compose up -d --no-build --force-recreate app >/dev/null || failed=1
    fi
    if [ "$failed" = "0" ]; then
      wait_for_health "$OLD_GREEN_SHA" "$OLD_GREEN_MODEL" || failed=1
    fi
    if [ "$failed" = "0" ]; then
      verify_anthropic_env_cardinality || failed=1
    fi
    if [ "$failed" = "0" ]; then
      env_matches_snapshot || failed=1
    fi
  else
    failed=1
  fi

  if [ "$failed" = "0" ]; then
    log "recovery complete; last green release is active and verified"
    printf '[rollback] FAIL: rollback target was not activated\n' >&2
    return 0
  fi
  printf '[rollback] FAIL: automatic recovery could not verify the last green release\n' >&2
  return 1
}

handle_exit() {
  local status="$?" recovery_status=0 cleanup_status=0
  trap - EXIT INT TERM
  set +e
  rm -f -- .deploy_green_sha.rollback.* .deploy_prev_sha.rollback.* >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ "$ACTIVATION_STARTED" = "1" ] \
    && [ "$ROLLBACK_SUCCEEDED" != "1" ]; then
    recover_rollback || recovery_status=1
  fi
  if [ "$ROLLBACK_SUCCEEDED" = "1" ]; then
    docker image rm "$RECOVERY_IMAGE" >/dev/null 2>&1 || true
  fi
  cleanup_env_snapshot || cleanup_status=1
  if [ "$cleanup_status" -ne 0 ]; then
    printf '[rollback] FAIL: temporary environment snapshot cleanup failed\n' >&2
  fi
  release_deploy_lock
  if [ "$status" -eq 0 ] \
    && { [ "$recovery_status" -ne 0 ] || [ "$cleanup_status" -ne 0 ]; }; then
    status=1
  fi
  exit "$status"
}

handle_signal() {
  local signal_name="$1" exit_code="$2"
  printf '[rollback] interrupted by %s; recovery will run before exit\n' "$signal_name" >&2
  exit "$exit_code"
}

run_rollback() {
  local explicit_target="${1-}" raw_target

  for command in flock git docker awk cksum cat tr sed mv rm sleep \
    stat mktemp cp chmod chown; do
    require_command "$command"
  done
  cd "$APP_DIR" || die "APP_DIR does not exist"
  acquire_deploy_lock
  validate_secret_file
  assert_clean_worktree
  validate_server_config
  configure_compose
  COMPOSE_READY=1

  OLD_GREEN_SHA="$(read_sha_marker .deploy_green_sha)" \
    || die ".deploy_green_sha is missing or invalid"
  OLD_PREV_SHA="$(read_sha_marker .deploy_prev_sha)" \
    || die ".deploy_prev_sha is missing or invalid"
  OLD_GREEN_FULL="$(resolve_commit "$OLD_GREEN_SHA")" \
    || die ".deploy_green_sha does not resolve to a reachable commit"
  OLD_GREEN_MODEL="$(model_version_at "$OLD_GREEN_FULL")" \
    || die "last-green model version cannot be read from the repository"
  if [ -n "$explicit_target" ]; then
    raw_target="$explicit_target"
  else
    raw_target="$OLD_PREV_SHA"
  fi
  TARGET_FULL="$(resolve_commit "$raw_target")" \
    || die "rollback target does not resolve to a reachable commit"
  TARGET_SHORT="$(git rev-parse --short "$TARGET_FULL")" \
    || die "rollback target short SHA cannot be resolved"
  TARGET_MODEL="$(model_version_at "$TARGET_FULL")" \
    || die "rollback target model version cannot be read from the repository"

  snapshot_env || die "secure .env snapshot could not be created"
  docker image inspect "$LAST_GREEN_IMAGE" >/dev/null 2>&1 \
    || die "last-green image is missing; refuse an unsafe rollback"
  docker image tag "$LAST_GREEN_IMAGE" "$RECOVERY_IMAGE" \
    || die "last-green recovery snapshot could not be created"
  RECOVERY_IMAGE_AVAILABLE=1

  ACTIVATION_STARTED=1
  log "activating ${TARGET_SHORT} from verified local history"
  git reset --hard --quiet "$TARGET_FULL"
  assert_clean_worktree
  export COMMIT_SHA="$TARGET_SHORT"
  compose build app
  compose up -d --remove-orphans
  if ! wait_for_health "$TARGET_SHORT" "$TARGET_MODEL"; then
    die "rollback target health contract failed"
  fi
  verify_anthropic_env_cardinality \
    || die "container environment cardinality contract failed"
  env_matches_snapshot \
    || die ".env changed during rollback"

  docker image tag demeu-app:latest "$LAST_GREEN_IMAGE"
  write_marker .deploy_green_sha "$TARGET_SHORT"
  write_marker .deploy_prev_sha "$TARGET_SHORT"
  ROLLBACK_SUCCEEDED=1
  log "rollback is healthy: commit=${TARGET_SHORT}, model=${TARGET_MODEL}, llm_ok=true"
}

validate_inputs "$@"
trap 'handle_exit' EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM
run_rollback "${1-}"
