# Shared by stock activation/rollback. No secrets are read into shell variables.
MIS_VALIDATOR_CODE="$(<"${BASH_SOURCE[0]%/*}/validate-mis-credentials.cjs")" || { printf 'Private mount validator is unavailable\n' >&2; exit 1; }
[ -n "$MIS_VALIDATOR_CODE" ] || { printf 'Private mount validator is empty\n' >&2; exit 1; }
resolve_recovery_image() {
  local identity
  identity="$(docker image inspect --format '{{.Id}}' "$1" 2>/dev/null)" || return 1
  [[ "$identity" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  printf '%s' "$identity"
}

read_recovery_image_schema() {
  local image="$1"
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint node "$image" -e '
      // demeu-recovery-marker:v1
      const fs = require("node:fs");
      try {
        const path = "/app/referral-schema-version";
        const info = fs.lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4) process.exit(1);
        const marker = fs.readFileSync(path, "utf8");
        if (!/^[1-6]\n?$/.test(marker)) process.exit(1);
        process.stdout.write(marker.trim());
      } catch { process.exit(1); }
    '
}

assert_recovery_image_marker_absent() {
  local image="$1"
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint node "$image" -e '
      // demeu-recovery-marker-absent:v1
      const fs = require("node:fs");
      try {
        fs.lstatSync("/app/referral-schema-version");
        process.exit(1);
      } catch (error) {
        process.exit(error?.code === "ENOENT" ? 0 : 1);
      }
    ' >/dev/null 2>&1
}

assert_recovery_image_compatible() {
  local image="$1" explicit_schema="${2-}" data_dir
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  data_dir="$(env_value DEMEU_HOST_DATA_DIR)" || return 1
  [ -n "$data_dir" ] || return 0
  case "$data_dir" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$data_dir" in
    /|*/|*[!A-Za-z0-9_./-]*|*..*|*//*) return 1 ;;
  esac
  # Rootless runtime data can be owned by the mapped nextjs UID and therefore
  # unreadable to the host shell. Inspect it only through the exact immutable
  # image's normal UID. Docker must establish the directory mount; ENOENT is
  # accepted only when the in-image probe proves the snapshot itself is absent.
  # JSON.parse validates the entire document, including its trailing bytes.
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --mount "type=bind,src=${data_dir},dst=/state,readonly" \
    --entrypoint node "$image" -e '
      // demeu-recovery-schema:v1
      const fs = require("node:fs");
      try {
        const directory = process.argv[2];
        const directoryInfo = fs.lstatSync(directory);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) process.exit(1);
        const path = `${directory}/referrals.json`;
        let info;
        try {
          info = fs.lstatSync(path);
        } catch (error) {
          if (error?.code === "ENOENT") process.exit(0);
          process.exit(1);
        }
        const marker = process.argv[3] || fs.readFileSync(process.argv[1], "utf8");
        if (!/^[1-6]\n?$/.test(marker)) process.exit(1);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 33554432) process.exit(1);
        const bytes = fs.readFileSync(path);
        if (bytes.length > 33554432) process.exit(1);
        const state = JSON.parse(bytes.toString("utf8"));
        if (!state || typeof state !== "object" || Array.isArray(state) || !Number.isSafeInteger(state.schemaVersion)
          || state.schemaVersion < 1 || state.schemaVersion > 6 || state.schemaVersion > Number(marker.trim())) process.exit(1);
      } catch { process.exit(1); }
    ' /app/referral-schema-version /state "$explicit_schema" >/dev/null 2>&1
}

configure_private_mis() {
  local runtime_path size mode
  MIS_HOST_FILE="$(env_value DEMEU_HOST_MIS_CREDENTIALS_FILE)" || die "MIS host file setting is duplicated"
  runtime_path="$(env_value DEMEU_MIS_CREDENTIALS_FILE)" || die "MIS runtime file setting is duplicated"
  if [ -z "$MIS_HOST_FILE" ]; then
    [ -z "$runtime_path" ] || die "MIS runtime credentials require the explicit private host mount"
    return 0
  fi
  case "$MIS_HOST_FILE" in
    /*) ;;
    *) die "MIS host credentials file must be an absolute path" ;;
  esac
  case "$MIS_HOST_FILE" in
    /|*/|*[!A-Za-z0-9_./-]*|*..*|*//*) die "MIS host credentials path is unsafe" ;;
  esac
  [ -z "$runtime_path" ] || [ "$runtime_path" = /run/secrets/demeu-mis-credentials.json ] \
    || die "MIS runtime credential path must match the stock mount"
  [ -f "$MIS_HOST_FILE" ] && [ ! -L "$MIS_HOST_FILE" ] || die "MIS credentials must be a regular non-symlink file"
  size="$(stat -c '%s' "$MIS_HOST_FILE")" || die "MIS credential file size could not be checked"
  mode="$(stat -c '%a' "$MIS_HOST_FILE")" || die "MIS credential file permissions could not be checked"
  [[ "$size" =~ ^[0-9]+$ ]] && [ "$size" -gt 0 ] && [ "$size" -le 1000000 ] \
    || die "MIS credential file exceeds its size limit"
  [ "$mode" = 600 ] || die "MIS credentials require private mode 0600"
  export DEMEU_HOST_MIS_CREDENTIALS_FILE="$MIS_HOST_FILE"
  COMPOSE_ARGS+=(-f deploy/compose.mis.yml)
}

assert_private_mis_readable() {
  local image="$1"
  [ -n "${MIS_HOST_FILE-}" ] || return 0
  # Use the image's normal runtime UID (nextjs/1001), including rootless mapping.
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --mount "type=bind,src=${MIS_HOST_FILE},dst=/run/secrets/demeu-mis-credentials.json,readonly" \
    --entrypoint node "$image" -e "$MIS_VALIDATOR_CODE" \
    /run/secrets/demeu-mis-credentials.json >/dev/null 2>&1
}
