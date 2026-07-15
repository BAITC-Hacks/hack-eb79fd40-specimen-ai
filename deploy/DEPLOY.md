# Demeu deployment runbook

Read-only SSH reconnaissance and a repeat preflight have been accepted. Live mutation remains an
explicit operator action through `deploy/deploy.sh`; the accepted attempt stopped before transfer or
build because the dirty worktree had no truthful commit provenance.

## Required server state

The accepted reconnaissance found Docker/Compose available and ports 80, 443, and 3100 free, so the
selected target configuration is branch B. Put these values in the server-only `/opt/demeu/.env`:

```dotenv
VPS_RECON_CONFIRMED=yes
TLS_BRANCH=branch-b-caddy
DEMEU_DOMAIN=109-123-248-16.sslip.io
APP_PORT=3100
```

`TLS_BRANCH` is exactly one of `branch-a-nginx`, `branch-a-caddy`, or `branch-b-caddy`.
The script still refuses to guess when reconnaissance or this selection is missing. Re-run the
read-only preflight immediately before activation because listener state can change. Keep the application
credentials in the same server-only `.env`, mode `0600`. Rotate every previously exposed token before
the first live deployment. The script validates credentials without printing their values and verifies
that the running container has exactly one `ANTHROPIC_API_KEY` variable.

## Default mode: Git on the server

The repository is private. Create a read-only SSH deploy key on the VPS, add only its public half in
GitHub under repository Settings → Deploy keys, and pin GitHub's host key through an independently
verified fingerprint. Never copy a personal SSH key or PAT to the server.

```bash
cd /opt/demeu
bash deploy/deploy.sh
```

The default mode performs a fast-forward-only `git pull`, audits history for an Anthropic credential
pattern, validates the chosen TLS compose branch in quiet mode, builds, starts the stack, and verifies
`/api/healthz` from inside the app container. Both `commit` and `llm_ok:true` must match. On failure the
last green image is restored before the command exits non-zero. `.env` is never overwritten.

Server activation takes a non-blocking kernel lock on `.deploy.lock`. A concurrent run fails before
`git pull`; a stale file after a crash is harmless because `flock` ownership is tied to the process
file descriptor and is released on exit. `EXIT`, `INT`, and `TERM` share one recovery path and release
the lock without recursively invoking recovery. Before pull, the script rejects tracked or untracked
worktree changes except the server-only `.env`, lock file, and deployment SHA markers. Every failure
after activation starts—including pull, image build, container start, health, environment-count, and
fingerprint checks—restores the previous Git SHA and last-green image, restarts it, and verifies health.
On a first deployment with no last-green image, the failed app is removed and the command exits nonzero.
Before build, the current container must be proven healthy and snapshotted. If creating or verifying that
snapshot fails, build never starts: the Git tree is returned to its previous SHA, the already-running
container is left untouched, and its health is checked again. Absence of a backup tag is therefore not
misclassified as a first deployment when a healthy production container is already present.

## Fallback mode: rsync from the local repository

```bash
DEPLOY_MODE=rsync SERVER=root@109.123.248.16 APP_DIR=/opt/demeu \
  bash deploy/deploy.sh
```

The rsync filter protects and excludes every `.env*` file, raw/processed datasets, offline Python,
tests, eval outputs, caches, binary weights, and archives. Runtime JSON artifacts remain included.
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
rendering secrets, snapshots `demeu-app:last-green`, and keeps a mode-`0600` temporary `.env` snapshot
outside the repository and Docker context. It then rebuilds the selected commit and
requires `/api/healthz` to match that commit, its model version, and `llm_ok:true`. After success both
deployment markers point at the active rollback target, so repeating the implicit rollback is safe.
Any build, start, health-contract, marker-write, environment, or interruption failure restores the
original `.env` atomically with its prior mode/ownership, then restores the last-green image, its Git
SHA, and the original markers. Both candidate and recovered containers must independently prove the
exact health contract and exactly one `ANTHROPIC_API_KEY` environment entry before either path is
called verified. The temporary secret snapshot is removed on every success or failure path.

## Still requires live evidence

Reconnaissance, branch selection, repeat preflight, and dry-run rsync are accepted. Live acceptance
remains blocked until the accepted worktree has an explicitly authorized commit/push whose SHA
describes the deployed bytes. After that, the operator installs server-only credentials, activates
branch B, confirms external firewall reachability and certificate issuance, and verifies public HTTPS
without `-k`. L1 and the separately authorized L2 must then pass; none of those production claims is
currently complete.

## Public smoke after deployment

Both smoke levels are hard-pinned to `https://109-123-248-16.sslip.io`; another host, HTTP, a port,
path, redirect, certificate error, DNS error, timeout, non-JSON API response, or unexpected status
fails closed. The scripts do not retry. The smoke wrapper is the single owner of its default artifact
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

L1 makes exactly five no-key requests: TLS/hostname plus `/`, exact `/api/healthz`, `/api/link`, a
well-formed unknown token returning `404`, and the patient page returning HTML. The current
`/api/chat/start` returns a static greeting and does not contact Anthropic, so calling it cannot prove
LLM readiness and is deliberately not counted as the sixth check.

```bash
DEMEU_SMOKE_LIVE=I_ACCEPT_PRODUCTION_SMOKE \
  bash deploy/smoke-l1.sh
```

Run L2 only after L1 is green, health reports `llm_ok:true`, the three production credentials are
configured, and the operator explicitly authorizes cost. It sends the three frozen SPINE scenarios,
always calls `POST /api/chat/finalize`, repeats finalize to prove replay equality, and requires a
completed-session chat to return `409 SESSION_COMPLETED`. Scenario 1 must return emergency urgency,
the chest-pain flag, verified quote evidence, and emergency/cardiology routing. Scenarios 2 and 3
accept safe model abstention/fallback but still require a contract-valid summary. The client sends at
most 22 HTTP requests and no retries; under the current server retry policy the conservative upper
bound is 24 Anthropic requests. A previous local scenario-1 run already spent two calls and is not
repeated by this procedure.

```bash
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

For a newly deployed commit, `deploy/smoke-scenario1-once.sh` persists the exact seven-request
scenario-1 sequence: health, link, start, one chat line, finalize, finalize replay, and completed-chat
`409`. It requires the canonical host, an exact seven-character lowercase `EXPECTED_COMMIT`, and a
separate production opt-in. The fixed marker is
`reports/live-e2e/prod-s1-<commit>-once.json`; it is reserved with exclusive mode `0600` before the
first request. An existing marker fails before fetch, so there is no automatic rerun.

```bash
EXPECTED_COMMIT=<deployed-short-sha> \
DEMEU_SCENARIO1_LIVE=I_AUTHORIZE_ONE_PRODUCTION_SCENARIO1_ONCE \
  npm run e2e:scenario1:production-once
```

This command is a separately authorized paid production check and must not be run merely to test the
harness. The existing `prod-s1-e0f3f43-once.json` artifact remains untouched and ignored. Its
semantics and privacy were independently accepted and are now cross-corroborated by the persisted
harness, which was added after that run; the repository does not claim the historical run was
retroactively executed by this code.
