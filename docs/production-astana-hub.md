# Production: Astana Hub infrastructure

This document is the current operator entry point for the organizer-provided
infrastructure. Historical bare-IP and magic-DNS evidence remains in the
repository as dated evidence; it is not the active topology.

| Field | Current value |
|---|---|
| Updated | 2026-09-28 |
| Public origin | `https://specimen-ai.govtech-kz.com` |
| Workspace | `https://specimen-ai.govtech-kz.com/workspace` |
| API portal | `https://specimen-ai.govtech-kz.com/api-docs` |
| Source repository | `BAITC-Hacks/hack-eb79fd40-specimen-ai`, branch `main` |
| Ingress | Shared host Caddy owned by the organizer |
| Application listener | Rootless Docker, loopback-only port `8019` |
| Runtime mode | `external_llm` |
| Previous service | `https://84.247.161.211`, rollback only during acceptance |

The application uses deployment branch `branch-a-caddy`: Compose starts only
the application and publishes `127.0.0.1:8019`; the shared host Caddy owns
ports 80/443 and terminates TLS. Do not start the bundled Caddy overlay on this
shared VPS.

## Server-only configuration

The following non-secret values belong in the server `.env`:

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

Secrets are never stored in git, screenshots, shell arguments, or this
document. The server `.env` and workspace account file must be mode `0600`.
The data and configuration directories must be accessible to container UID
`1001`; with rootless Docker the corresponding host owner is a subordinate UID,
not necessarily the interactive SSH user.

## Release path

The application checkout is `/home/specimen_ai/demeu`. Every activation uses
the fail-closed release script; manual `docker compose up`, skipped health
checks, or an uncommitted tree are not accepted release paths.

```bash
cd /home/specimen_ai/demeu
DEMEU_DEEP_PROBE=I_AUTHORIZE_ONE_STRUCTURED_EXTRACTION \
  APP_DIR=/home/specimen_ai/demeu BRANCH=main bash deploy/deploy.sh
```

The paid authorization is single-use for one structured-extraction readiness
probe. It does not authorize L2 or clinical scenario runs. After activation,
require all of the following:

1. `/api/healthz` reports the exact deployed commit, `ok: true`,
   `llm_ok: true`, and `processing_mode: external_llm`.
2. HTTPS is publicly trusted for the exact hostname and HTTP redirects to it.
3. Authenticated L1 passes against the exact production origin.
4. Anonymous model and reference endpoints return `401`.
5. Restored workspace counts match the migration snapshot: 0 active sessions,
   16 referrals, 19 delivery records, and 7 accounts.
6. The previous service remains reachable until this checklist is accepted.

## Persistent state and S3

Runtime JSON state stays on the private local bind mount because the current
application does not implement an object-storage adapter. The organizer S3
bucket is verified for bounded migration backups only. It uses its issued
S3-compatible endpoint, `us-east-1`, and path-style addressing; access keys are
server-only and are not application environment variables.

Back up `sessions.json`, `referrals.json`, `deliveries.json`, and the private
workspace accounts file together. A restore is accepted only after hashes or
independently measured record counts match. Never use `docker compose down -v`.

## Rollback

`deploy/rollback.sh` is the code rollback path after a green release exists on
the new VPS. During first-cutover acceptance, the already-running previous
service at `https://84.247.161.211` is the infrastructure rollback target. Do
not remove or repoint it until the new origin passes exact-SHA health, TLS, L1,
state-parity, and access-control checks.
