# Demeu deployment runbook

The current production target is the organizer-provided shared VPS documented
in [`docs/production-astana-hub.md`](../docs/production-astana-hub.md). It uses
host Caddy, rootless Docker, `specimen-ai.govtech-kz.com`, and loopback port
8019. Every mutation remains an explicit operator action through
`deploy/deploy.sh`. The bare-IP sections below are retained as historical
rollback evidence and must not be used as the current topology.

## Required server state

Текущий production-профиль организаторов:

```dotenv
VPS_RECON_CONFIRMED=yes
TLS_BRANCH=branch-a-caddy
DEMEU_DOMAIN=specimen-ai.govtech-kz.com
APP_BASE_URL=https://specimen-ai.govtech-kz.com
APP_PORT=8019
DEMEU_PROCESSING_MODE=external_llm
DEMEU_HOST_DATA_DIR=/home/specimen_ai/demeu-data
DEMEU_HOST_ACCOUNTS_FILE=/home/specimen_ai/demeu-config/accounts.json
```

На общем сервере 80/443 принадлежат host Caddy, поэтому release-скрипты
подключают `compose.host-proxy.yml` и `compose.workspace.yml`, но не запускают
Compose Caddy. Checkout расположен в `/home/specimen_ai/demeu`; source of truth
— `BAITC-Hacks/hack-eb79fd40-specimen-ai`, ветка `main`.

### Historical server profiles

Текущий сентябрьский production на `84.247.161.211` использует:

```dotenv
VPS_RECON_CONFIRMED=yes
TLS_BRANCH=branch-b-caddy
DEMEU_DOMAIN=84.247.161.211
APP_BASE_URL=https://84.247.161.211
APP_PORT=3100
DEMEU_HOST_DATA_DIR=/var/lib/demeu
DEMEU_HOST_ACCOUNTS_FILE=/etc/demeu/accounts.json
```

Для этого точного домена оба release-скрипта всегда используют четыре Compose-файла в порядке
`docker-compose.yml`, `compose.caddy.yml`, `compose.workspace.yml`, `compose.new-server-ip.yml`.
Для остальных поддержанных TLS-профилей workspace overlay также обязателен, а специальный ingress
overlay не подключается.

The accepted reconnaissance found Docker/Compose available and ports 80, 443, and 3100 free, so the
selected target configuration is branch B. Put these values in the server-only `/opt/demeu/.env`:

```dotenv
VPS_RECON_CONFIRMED=yes
TLS_BRANCH=branch-b-caddy
DEMEU_DOMAIN=109.123.248.16
APP_BASE_URL=https://109.123.248.16
APP_PORT=3100
DEMEU_PROCESSING_MODE=external_llm
```

`TLS_BRANCH` is exactly one of `branch-a-nginx`, `branch-a-caddy`, or `branch-b-caddy`.
The script still refuses to guess when reconnaissance or this selection is missing. Re-run the
read-only preflight immediately before activation because listener state can change. Keep the application
credentials in the same server-only `.env`, mode `0600`. Rotate every previously exposed token before
the first live deployment. The script validates credentials without printing their values and verifies
that the running container has exactly one `ANTHROPIC_API_KEY` variable in `external_llm` mode.
`DEMEU_PROCESSING_MODE` accepts only `external_llm` or `deterministic` and defaults to the former.
Deterministic mode does not require an Anthropic key.

Set `TELEGRAM_DOCTOR_CHAT_IDS` to a comma-separated ordered list of numeric Telegram `chat_id`
values for broadcast delivery. Duplicate values are removed while preserving first occurrence.
The plural variable wins whenever it is nonblank; an unset or blank plural variable falls back to
the legacy `TELEGRAM_DOCTOR_CHAT_ID` singleton. Empty list elements are ignored, but any other
malformed or out-of-signed-64-bit value fails closed. A mandatory text failure for one recipient
does not block later recipients, but marks the session-level aggregate delivery as failed. PDF
delivery is best-effort. Every independently delivered text chunk carries the mandatory disclaimer
inside the 4096-character budget. Recipient-specific delivery state is intentionally not stored in
this MVP.

## Default mode: Git on the server

The repository is private. Create a read-only SSH deploy key on the VPS, add only its public half in
GitHub under repository Settings → Deploy keys, and pin GitHub's host key through an independently
verified fingerprint. Never copy a personal SSH key or PAT to the server.

```bash
cd /opt/demeu
DEMEU_DEEP_PROBE=I_AUTHORIZE_ONE_STRUCTURED_EXTRACTION \
  bash deploy/deploy.sh
```

The default mode performs a fast-forward-only `git pull`, audits history for an Anthropic credential
pattern, validates the chosen TLS compose branch in quiet mode, builds, starts the stack, and verifies
the shallow `/api/healthz`, `/workspace`, and anonymous `/api/workspace/auth` bootstrap from inside
the app container. The auth response must prove that workspace mode is enabled and that no actor is
implicitly authenticated. It then makes exactly one authorized
structured extraction call through the HMAC-protected loopback-only `?probe=extract` gate before
marking the image green. The opt-in is checked before Docker or provider access; no new secret is
stored because the proof is derived inside the container from the runtime key and commit. Both
`commit` and deep `llm_ok:true` must match. Recovery and Docker health remain shallow and make no
provider call. In deterministic mode the script skips the authorization, key-cardinality and Anthropic
probe gates, then requires a provider-free deep self-test of the fixed questionnaire and three safety
scenarios. It still requires the exact commit, model version, processing mode and all other deployment
gates. Preflight captures the mode reported by the currently running container independently of the
new desired mode; a legacy four-field health response is accepted only as a ready `external_llm`
release. On failure the
last green image is restored before the command exits non-zero. `.env` is never overwritten.

Server activation takes a non-blocking kernel lock on `.deploy.lock`. A concurrent run fails before
`git pull`; a stale file after a crash is harmless because `flock` ownership is tied to the process
file descriptor and is released on exit. `EXIT`, `INT`, and `TERM` share one recovery path and release
the lock without recursively invoking recovery. Before pull, the script rejects tracked or untracked
worktree changes except the server-only `.env`, lock file, and deployment SHA markers. The clean-tree
gate also accepts only the exact ignored build/data paths already excluded from the
Docker context: `.next/`, `node_modules/`, `tsconfig.tsbuildinfo`, `data/raw/`, and `data/processed/`.
Arbitrary ignored files remain a hard failure. Every failure
after activation starts—including pull, image build, container start, health, environment-count, and
fingerprint checks—restores the previous Git SHA and last-green image, restarts it, and verifies health.
On a first deployment with no last-green image, the failed app is removed and the command exits nonzero.
Before build, the current container must be proven healthy and snapshotted. If creating or verifying that
snapshot fails, build never starts: the Git tree is returned to its previous SHA, the already-running
container is left untouched, and its health is checked again. Absence of a backup tag is therefore not
misclassified as a first deployment when a healthy production container is already present.

## Fallback mode: rsync from the local repository

```bash
DEMEU_DEEP_PROBE=I_AUTHORIZE_ONE_STRUCTURED_EXTRACTION \
  DEPLOY_MODE=rsync SERVER=root@109.123.248.16 APP_DIR=/opt/demeu \
  bash deploy/deploy.sh
```

The rsync filter protects the server repository metadata whether the local source uses a `.git`
directory or a worktree `.git` pointer file, and protects and excludes every `.env*` file, raw/processed datasets, offline Python,
tests, per-case eval outputs, caches, binary weights, and archives. It allowlists only the aggregate
runtime evidence consumed by the model API (`eval/report.json`, the red-flag benchmark, wait-time,
referral-refusal, and laboratory-load reports); all other `eval/` and `reports/` files remain excluded.
Runtime JSON artifacts remain included.
The server runs the same guarded activation after transfer. A failed candidate therefore keeps the
last green container active in either mode.

## Rollback

Rollback runs only on the server and never fetches remote state. Without an argument it resolves the
strictly validated SHA in `.deploy_prev_sha`; an explicit target must be a full 40-character commit
SHA that is already reachable from the current repository history.

```bash
cd /opt/demeu
bash deploy/rollback.sh
# or: bash deploy/rollback.sh <full-40-character-commit-sha>
```

The script takes the same `.deploy.lock` as `deploy.sh`, rejects dirty or incomplete server state
before changing Git or containers, validates `.env` and the selected proxy compose branch without
rendering secrets, and compares the live referral snapshot's `schemaVersion` with the rollback
target capability declared in `deploy/referral-schema-version`. A newer live snapshot makes the
rollback fail before Git, image, or container mutation. When a live referral snapshot exists, a
release without the marker is treated as an unknown reader and is rejected before mutation: historical
markerless releases reused the same root version for incompatible strict shapes. The script then
snapshots `demeu-app:last-green` and keeps a mode-`0600` temporary `.env` snapshot
outside the repository and Docker context. It then rebuilds the selected commit and
requires `/api/healthz` to match that commit, its model version and processing mode and requires the
workspace/auth surface to remain available; external mode also requires `llm_ok:true`. After success both
deployment markers point at the active rollback target, so repeating the implicit rollback is safe.
Any build, start, health-contract, marker-write, environment, or interruption failure restores the
original `.env` atomically with its prior mode/ownership, then restores the last-green image, its Git
SHA, and the original markers. Both candidate and recovered containers must independently prove the
exact health contract and, in external mode, exactly one `ANTHROPIC_API_KEY` environment entry before either path is
called verified. The temporary secret snapshot is removed on every success or failure path.

## Bare-IP live evidence still required

The current `sslip.io` runtime remains accepted until cutover. After this change has an explicitly
authorized commit/push, the operator keeps the old `.env` for the first code-only deploy. A second
activation of the same commit atomically changes the non-secret origin values to exact
`109.123.248.16`, obtains the public short-lived certificate through HTTP-01, verifies SAN/redirect
and public HTTPS without `-k`, then runs L1 against the explicit IP origin. The IP Caddy config uses
`default_sni 109.123.248.16` for clients that omit SNI and keeps
the exact old sslip hostname as a rollback alias to the same backend. L2 remains separately
cost-authorized and is not required merely to prove the origin switch.

## Public smoke after deployment

Both smoke levels are pinned to an explicit trusted production origin. The current default is
`https://specimen-ai.govtech-kz.com`; for a custom domain set
`EXPECTED_PRODUCTION_ORIGIN=https://demo.example.kz`. `BASE_URL`, when supplied, must equal that
origin exactly. HTTP, a different host, a port, path, redirect, certificate error, DNS error,
timeout, non-JSON API response, or unexpected status fails closed. Accepted hosts use the same
validator as `deploy/tls.sh`: only the exact production IP or a normalized lowercase ASCII FQDN is
accepted; every other IP, wildcard, localhost, Unicode and punycode is rejected. The scripts do not retry. The smoke wrapper is the single owner of its default artifact
root in both Git and rsync deployments: before the first request it creates exactly project-relative
`reports/` and `reports/live-e2e/` with mode `0700` when absent, then validates them. It does not create
arbitrary custom parents. Existing components must be real directories owned by the current deploy
user and not world-writable. The reserved JSON file uses `O_EXCL|O_NOFOLLOW`, mode `0600`, one link,
and its path/inode/owner/mode/link count are revalidated immediately before writing any bytes. Do not
put credentials in command arguments or artifact path names. A custom location requires both an
absolute `SMOKE_ARTIFACT_ROOT` and a contained absolute `SMOKE_ARTIFACT`; either variable alone fails
before network.

Threat model: these checks prevent operator mistakes and reject unsafe or rebound paths visible to
the smoke process. They are not a sandbox against code already injected into the same Node process,
nor against a root process; either already has filesystem authority. The deterministic binding order
still matters: after the final path `lstat`, the descriptor is `fstat`-checked for one link before the
immediate write, and the pinned root/parent identities are rechecked after `realpath` before `open`.

L1 makes exactly five no-key requests: TLS/hostname plus `/workspace`, exact `/api/healthz`, `/api/link`, a
well-formed unknown token returning `404`, and the patient page returning HTML. The current
`/api/chat/start` returns a static greeting and does not contact Anthropic, so calling it cannot prove
LLM readiness and is deliberately not counted as the sixth check.

```bash
EXPECTED_PRODUCTION_ORIGIN="https://${DEMEU_DOMAIN}" \
DEMEU_SMOKE_LIVE=I_ACCEPT_PRODUCTION_SMOKE \
  bash deploy/smoke-l1.sh
```

When workspace auth is enabled, set `DEMEU_WORKSPACE_COOKIE` to a short-lived doctor
session cookie through the process environment. The harness keeps it out of artifacts
and carries the patient capability cookie returned by `/api/chat/start` automatically.

Run L2 only after L1 is green, health reports `llm_ok:true`, the three production credentials are
configured, and the operator explicitly authorizes cost. It sends the three frozen SPINE scenarios,
always calls `POST /api/chat/finalize`, repeats finalize to prove replay equality, and requires a
completed-session chat to return `409 SESSION_COMPLETED`. Scenario 1 must return emergency urgency,
the chest-pain flag, verified quote evidence, and emergency/cardiology routing. Scenarios 2 and 3
accept safe model abstention/fallback but still require a contract-valid summary. The client sends at
most 25 HTTP requests and no retries; authenticated intake reads verify clinician-only results without
exposing them through patient endpoints. Under the current server retry policy the conservative upper
bound is 24 Anthropic requests. A previous local scenario-1 run already spent two calls and is not
repeated by this procedure.

```bash
EXPECTED_PRODUCTION_ORIGIN="https://${DEMEU_DOMAIN}" \
DEMEU_SMOKE_LIVE=I_AUTHORIZE_3_SCENARIOS_AND_UP_TO_24_ANTHROPIC_REQUESTS \
  bash deploy/smoke-scenarios.sh
```

Success artifacts contain a health-contract verification flag and pass/fail summaries only. Failure
artifacts contain an enum error code, never a dynamic endpoint path or response body. Neither form
contains a doctor/patient token, session identifier, transcript, quote, or credential; console output
does not print the artifact path. Public API responses do not expose delivery state. Telegram
acceptance therefore remains a separate operator check; a Bot API HTTP 200 with message/document
result identifiers proves API acceptance, not that a person read the summary.

### One-shot scenario 1 evidence harness

For a newly deployed commit, `deploy/smoke-scenario1-once.sh` persists the exact eight-request
scenario-1 sequence: health, link, start, one chat line, finalize, finalize replay, completed-chat
`409`, and the authenticated clinician intake used to verify the result without exposing it to the
patient API. It requires an explicit trusted production origin, an exact seven-character lowercase
`EXPECTED_COMMIT`, and a separate production opt-in. Only the historical sslip origin retains
`reports/live-e2e/prod-s1-<commit>-once.json`; the new IP and every other origin are bound into the marker name as
`prod-s1-<commit>-<bounded-hostname-slug>-<origin-sha256>-once.json`. The full SHA-256 prevents two
different valid hostnames with the same slug from sharing a marker. It is reserved with exclusive
mode `0600` before the first request. An existing marker fails before fetch, so there is no automatic
rerun.

```bash
EXPECTED_PRODUCTION_ORIGIN="https://${DEMEU_DOMAIN}" \
EXPECTED_COMMIT=<deployed-short-sha> \
DEMEU_SCENARIO1_LIVE=I_AUTHORIZE_ONE_PRODUCTION_SCENARIO1_ONCE \
  npm run e2e:scenario1:production-once
```

This command is a separately authorized paid production check and must not be run merely to test the
harness. The existing `prod-s1-e0f3f43-once.json` artifact remains untouched and ignored. Its
semantics and privacy were independently accepted and are now cross-corroborated by the persisted
harness, which was added after that run; the repository does not claim the historical run was
retroactively executed by this code.

## Bare-IP production rollout and rollback

Phase 1 deploys the accepted code while the server-only `.env` still contains the old sslip origin.
This proves that the new binary and dual Caddy mounts preserve the current service. Phase 2 prepares
a mode-`0600` temporary env with the exact non-secret origin pair, atomically replaces `.env`, and
activates the same commit:

```dotenv
DEMEU_DOMAIN=109.123.248.16
APP_BASE_URL=https://109.123.248.16
TLS_BRANCH=branch-b-caddy
```

Run `./deploy/tls.sh preflight`, quiet compose validation, activation, certificate SAN inspection,
HTTP→HTTPS check, public HTTPS and L1 with `EXPECTED_PRODUCTION_ORIGIN=https://109.123.248.16`.
The ACME `shortlived` certificate lifetime is about 160 hours; Caddy renews it natively using ARI and
persists state in `caddy_data`/`caddy_config`. Do not use `down -v`.

Changing `APP_BASE_URL` recreates the app. Because sessions are process-local, schedule the switch
with no active patients and regenerate all links afterward. Config rollback is separate from code
rollback: atomically restore exact sslip `DEMEU_DOMAIN`/`APP_BASE_URL`, run the same guarded deploy,
and verify L1. `deploy/rollback.sh` remains the exact-SHA code rollback tool and validates either
accepted origin. The IP config also serves sslip throughout, so the old URL remains an emergency
alias even before canonical-link rollback.

The bare-IP acceptance is not an explicit-SNI certificate check. It requires both ordinary curl and
an explicit no-SNI handshake against the public trust chain:

```bash
curl -fsS https://109.123.248.16/api/healthz
openssl s_client -connect 109.123.248.16:443 -noservername \
  -verify_return_error -verify_ip 109.123.248.16 -brief </dev/null
```

An auxiliary `openssl s_client ... -servername 109.123.248.16` may inspect the SAN path, but cannot
replace either acceptance command. Unknown non-empty SNI must still fail; do not add `fallback_sni`.


## Finalization schema6: recovery and optional MIS mount (04.10.2026)

This section describes the new, uncommitted finalization code. Read-only production
inspection on 04.10 observed `e5cc4a2`, `ok:true`, `external_llm`; this does not
claim that finalization is deployed. Preserve the shared rootless Docker profile,
`compose.host-proxy.yml`, port 8019 and organizer-managed host Caddy.

The runtime image now bakes `/app/referral-schema-version` from the reviewed reader
marker. Both stock scripts pin the saved recovery image to an immutable Docker
image ID **before activation**. They validate the entire bounded regular,
non-symlink `referrals.json` with JSON.parse and check its integer schema against
that exact image's baked capability. The configured data directory is mounted
read-only and existence/type/size are checked inside the exact image as its normal
runtime UID. This is required for rootless directories that the host login UID
cannot traverse; a host `EACCES` must never be interpreted as a missing snapshot.
An absent snapshot is accepted only when that in-image probe observes `ENOENT`.
The image probe runs without network,
read-only, with all capabilities dropped and no-new-privileges. A checked-out
marker or a subsequently retagged image cannot authorize fallback.

The same check runs again immediately before automatic fallback, before checkout,
environment/marker restoration, image retags or container activation. A target can
write a newer schema before failing its health gate: the saved reader then may no
longer be compatible. In that case the script exits unsuccessfully, keeps the
current runtime and state, and does **not** claim the previous release is healthy.
A malformed complete JSON document, future schema, missing/invalid marker or
unreadable file also blocks activation. Manual rollback additionally checks the
requested target's reader marker before changing its checkout.

### First boundary from a markerless existing image

A legacy image with no baked reader marker is not assumed to support schema6.
With a persisted snapshot present, stock activation will refuse that recovery
image. This is a release preparation gate, not a reason to bypass the scripts.
Before requesting the first cutover:

1. Record the current exact deployed source, image ID, health, proxy/ports and
   private state-file ownership. Quiesce writes for a consistent backup of the
   accounts and referral snapshot together; keep originals and hashes private.
2. In an isolated environment, reopen the backup with the exact old reader and
   perform a reversible write/read against a **copy**. Prove its supported schema
   from code and tests. Build a preserved recovery image from that exact source
   with only the reviewed baked reader marker added; do not relabel an unknown
   reader. Verify the immutable image, private mounted-file readability and the
   same writable restore. This preparation does not activate any container.
3. The coordinator records the boundary decision and preserved recovery image
   evidence, then uses the stock deployment chain with fresh preflight. If that
   exact-source recovery image cannot be proved, the first cutover remains
   blocked; choose an approved roll-forward recovery release after providing a
   verified writable backup, rather than guessing a capability.
4. If state has already advanced beyond a recovery reader, do not lower the JSON
   schema field or discard new fields. Quiesce writes and use a compatible
   roll-forward release through the stock script, or restore the paired verified
   backup under an explicitly approved recovery procedure. Include any changes
   since the backup in that decision. Reopen/read/write a copied restored
   snapshot first, then require exact-SHA health, L1 smoke, mount readability and
   green/previous markers. A health response alone is not writable recovery.

No production cutover, backup restore or first-boundary approval is claimed by
these offline checks. Never manually activate Compose to bypass a blocked gate.

The executable one-shot contract for this first boundary uses two process
environment variables. They do not belong in `.env` and must be supplied together:

- `DEMEU_PREPARED_RECOVERY_IMAGE_ID=sha256:<64 lowercase hex>` is the immutable
  ID of a marker-only child of the exact running image.
- `DEMEU_PREPARED_RECOVERY_COMMIT=<7 lowercase hex>` is the current healthy
  release commit, not the incoming candidate.

On the authorized production server shell, build the prepared image in a private
temporary directory from the exact running image ID. The marker must come from
the same old source commit in the server's preserved Git history. This server-side
template uses placeholders from the fresh preflight:

```bash
cd '<absolute current production app dir>'
current_image_id='sha256:<exact running image ID>'
current_commit='<current healthy commit>'
preflight_runner='<absolute staged reviewed source>/deploy/deploy.sh'
preparation_dir="$(mktemp -d)"
chmod 700 "$preparation_dir"
git show "${current_commit}:deploy/referral-schema-version" > "$preparation_dir/referral-schema-version"
cat > "$preparation_dir/Dockerfile" <<'EOF'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=1001:1001 referral-schema-version /app/referral-schema-version
EOF
docker build --pull=false --no-cache \
  --build-arg "BASE_IMAGE=${current_image_id}" \
  --tag demeu-app:first-boundary-recovery "$preparation_dir"
prepared_image_id="$(docker image inspect --format '{{.Id}}' demeu-app:first-boundary-recovery)"
DEMEU_PREPARED_RECOVERY_IMAGE_ID="$prepared_image_id" \
DEMEU_PREPARED_RECOVERY_COMMIT="$current_commit" \
APP_DIR="$PWD" bash "$preflight_runner" --check-prepared-recovery
```

The staged runner must contain the reviewed candidate `deploy/deploy.sh`, sibling
`recovery-guards.sh` and `validate-mis-credentials.cjs`; the current production
checkout still contains the markerless old script. Stage this small bundle in a
private non-runtime directory and remove it after the check. `APP_DIR` continues
to point at the untouched current production checkout, state and `.env`.

Before candidate mutation, the stock script proves all of the following: the
running container and `demeu-app:latest` still resolve to the same immutable base;
that base is markerless; image `COMMIT_SHA`, current health, existing green marker
and old checkout identify the supplied commit; prepared config equals base config;
prepared rootfs is the exact canonical `sha256:<64 hex>` base sequence plus one
layer (read with a joined template so Docker's final newline is not a layer); and
the final saved layer
is either raw tar or gzip identified by its bytes. It contains one regular
`app/referral-schema-version` with the source marker and may contain the BuildKit
`app/` parent entry only when its owner, group and mode exactly match `/app` in the
base image. Unsupported compression, changed parent metadata, whiteouts and every
other archive entry fail closed.
The layer archive is private, bounded while unpacking, and removed on success,
failure or signal. The prepared image then passes the same state and optional MIS
readability probes as ordinary recovery before build or `up` is allowed.

The `--check-prepared-recovery` command performs current health, immutable image,
marker-only layer, rootless state and optional MIS checks. It acquires the deploy
lock but performs no tag, build, `up`, provider probe or application activation.

Exit the server shell. In the reviewed **local** source worktree, invoke the
ordinary rsync deployment path with the recorded non-secret literal image ID and
commit. The script forwards only these constrained values to internal activation:

```bash
DEMEU_PREPARED_RECOVERY_IMAGE_ID='sha256:<recorded server image ID>' \
DEMEU_PREPARED_RECOVERY_COMMIT='<recorded current 7-char commit>' \
DEPLOY_MODE=rsync SERVER='<user@host>' APP_DIR='<absolute app dir>' \
bash deploy/deploy.sh
```

Do not retag `demeu-app:latest`, manually run Compose or persist the prepared
variables. After the first successful boundary, the candidate image has a baked
marker and becomes `last-green`; remove the temporary build directory and the
one-shot preparation tag. Supplying this lane again against a marked current image
fails closed. If a failed candidate has already advanced persisted schema beyond
the old reader, automatic fallback also fails closed and leaves state untouched
for the reviewed roll-forward or paired-backup procedure above.

### Optional MIS service credentials

MIS remains disabled unless `DEMEU_HOST_MIS_CREDENTIALS_FILE` is explicitly set
to a private absolute host file in `.env`. Stock deploy/rollback add
`compose.mis.yml` only then. Its bind mount is read-only, disallows implicit
host-path creation, and fixes the runtime path to
`/run/secrets/demeu-mis-credentials.json`. An explicitly different runtime path or
a runtime path without its host mount is rejected. Existing workspace mounts and
rootless ingress remain unchanged.

The host file must be regular, non-symlink, nonempty, at most 1,000,000 bytes and
mode 0600. A probe using the actual image's normal nextjs UID validates complete
strict JSON and readability under the rootless UID mapping before activation;
it prints neither file contents nor credential values. Apply private ownership
for the mapped runtime UID, following the existing account-file mapping; do not
make the file world-readable to fix a mount. Candidate and recovery readers both
must pass. The validator is captured before any checkout, so an older target
cannot remove it and accidentally turn validation into a successful empty script.

Credential schema is version1 with explicit integrations and organization IDs,
keys carrying unique credential IDs, `sha256$...` hashes, enabled flags,
`events:pull` / `events:ack` / optional `events:research` scopes and nullable expiry.
Real service secrets stay outside Git and command arguments. Browser credentials
are not service authentication. Research export additionally requires exact
`DEMEU_MIS_RESEARCH_EVENTS=I_ACKNOWLEDGE_RESEARCH_ONLY`; it is disabled by default.
No real MIS credential, external delivery or live integration was tested here.
