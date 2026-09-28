# Implementation status

## Current production migration — 2026-09-28

The organizer repository is `BAITC-Hacks/hack-eb79fd40-specimen-ai` and the
canonical origin is `https://specimen-ai.govtech-kz.com`. The shared VPS uses
host Caddy, rootless Docker, and loopback port 8019. Persistent workspace state
was copied directly between servers without downloading secrets: the migration
snapshot contains 0 active sessions, 16 referrals, 19 delivery records, and
7 accounts.
The previous service at `https://84.247.161.211` remains a rollback target until
the new origin passes exact-SHA health, TLS, authenticated L1, state parity, and
access-control checks. See
[the current operator runbook](production-astana-hub.md).

The sections below retain earlier implementation snapshots and dated
production evidence. They must not be interpreted as the current host or
repository configuration.

## September local working state — 2026-09-13

Uncommitted worktree `codex/september-foundation`, based on `7076e8a`:

- [Foundation](september-foundation.md): link access-code enforcement and rate limiting, bounded historical symptom handling, content-based eval checks.
- [Workspace and referrals](september-contracts.md): authenticated doctor/owner/analyst scopes, independent doctor-confirmed facts, immutable correction history, examinations and patient-safe memo.
- [Workspace redesign](workspace-redesign.md): role-specific overview and eight navigation sections, responsive shell, record identity and authorization failure guards.
- [File storage](file-storage.md): opt-in durable local snapshots for one process; in-memory behavior remains only when not configured. Delivery journal is part of backup scope.
- [Patient resume](patient-resume.md): active interview restoration with a separate patient capability in workspace mode.

These local changes supersede the corresponding limitations below. They do not
prove deployment, live AI/Telegram delivery, validated examination requirements,
or readiness for real patient data. ClickUp tasks are the PRD; a separate PRD
document is not a blocker. Outstanding product questions are in
[Ardan questions](ardan-questions.md).

## Historical July snapshot

All tables and operational limitations below describe the named July revision,
not the current September worktree.

This is the authoritative mutable snapshot for what the repository and accepted
evidence show now. It is not a replacement for SPINE: frozen contract changes
still require an explicit contract decision.

| Field | Value |
|---|---|
| Updated | 2026-07-17 |
| Implementation baseline | `19aa75528974582de44e5d8b1e7027289776f6e4` |
| Contract canon | SPINE v2 |
| New repository | `demeu-ai/demeu`, private, default branch `main` |
| Evidence rule | Code proves implementation; reports prove only their timestamped observation |

## Current snapshot

| Area | State at `19aa755` | Evidence anchor |
|---|---|---|
| Web application | Next.js 15.5, React 19, TypeScript implementation present | [`app/`](../app/), [`package.json`](../package.json) |
| Dialogue/extraction | Anthropic adapter and structured extraction implemented | [`lib/llm.ts`](../lib/llm.ts), [`lib/extract.ts`](../lib/extract.ts) |
| Urgent rules | Patient-only quote rules plus derived context flags implemented | [`lib/redflags.ts`](../lib/redflags.ts) |
| Local ML | JSON-backed multinomial LR scorer integrated | [`lib/model.ts`](../lib/model.ts), [`models/triage-lr-v1.json`](../models/triage-lr-v1.json) |
| Routing | Committed pathology-to-specialty table used at runtime | [`data/pathology_map.json`](../data/pathology_map.json) |
| State | In-process `MemoryStore`; no durable sessions | [`lib/store.ts`](../lib/store.ts) |
| Physician output | Telegram summary and PDF adapters implemented | [`lib/telegram.ts`](../lib/telegram.ts), [`lib/pdf.ts`](../lib/pdf.ts) |
| Deployment | Node 24 standalone container and Caddy topologies implemented | [`deploy/`](../deploy/), [Deployment](deployment.md) |
| CI/CD | No repository automation; operator-run scripts only | [Deployment](deployment.md#deploy-flow) |

## Production evidence

The latest accepted P0 production report is local, untracked evidence under
`reports/live-e2e/`; it is not part of baseline commit `19aa755`. The report is
dated 2026-07-17 and records exact revision
`19aa75528974582de44e5d8b1e7027289776f6e4` at the bare-IP origin.

That report supports an as-observed statement only. This document does not claim
that the service is currently reachable, that certificates have since renewed,
or that external providers are currently healthy.

| Evidence item | Accepted statement |
|---|---|
| Revision | Production reported exact SHA `19aa75528974582de44e5d8b1e7027289776f6e4` |
| Current pointer | `current` matched the recorded last-green revision |
| Public origin | Bare-IP HTTPS was the report-backed canonical origin |
| P0 scope | Shallow and authenticated deep health, TLS, no-SNI, and application isolation were exercised |
| Excluded inference | P0 is not perpetual uptime, clinical validation, or full Telegram proof |

The `109-123-248-16.sslip.io` address is now a rollback alias. Historical SPINE
text naming it canonical is superseded operationally for this snapshot, not
silently edited.

## Artifact and evaluation ledger

| Artifact | Snapshot state | Claim boundary |
|---|---|---|
| [`models/triage-lr-v1.json`](../models/triage-lr-v1.json) | Present and consumed by TypeScript | Training metrics inside it are not public eval metrics |
| [`data/evidences_ru.json`](../data/evidences_ru.json) | Present | Supplies human-readable contribution labels |
| [`data/pathology_map.json`](../data/pathology_map.json) | Present | Clinical validation state must be read from the artifact/report |
| [`eval/report.json`](../eval/report.json) | Present | Sole source for published production-path metrics |
| [`eval/report.md`](../eval/report.md) | Human-readable rendering present | Must remain consistent with JSON |
| [`reports/training_report.json`](../reports/training_report.json) | Training evidence present | Does not replace TypeScript-path evaluation |
| [`reports/pathology_map_validation.json`](../reports/pathology_map_validation.json) | Validation report present | Consult [Evaluation](evaluation.md) before claims |

Use [Data and ML pipeline](data-ml-pipeline.md) for provenance and
[Evaluation](evaluation.md) for exact metrics, denominators, and limitations.

## Known contract and runtime divergences

These are explicit differences, not undocumented “improvements”.

| Topic | SPINE intent | Baseline reality / consequence |
|---|---|---|
| `/api/link` auth | Optional `DOCTOR_ACCESS_CODE` enforcement | Variable is declared but unused; link creation is not protected by it |
| `429` | Reserved for rate limiting with `Retry-After` | Runtime does not fully implement the specified rate-limit mapping/contract |
| Symptom severity | Required numeric field | Runtime structured path permits nullable severity |
| Post-model hypothesis | LLM narrative after abstention/model decision | Runtime builds a deterministic hypothesis without a second LLM call |
| Public origin | `sslip.io` canonical in frozen text | Accepted production report uses bare-IP HTTPS; `sslip.io` is rollback alias |
| Consent | No stored `consentAt` in the session contract | UI has a consent gate, but it is not persisted as session consent evidence |
| Health | Shallow `/api/healthz` contract | Runtime adds an opt-in deep probe; shallow behavior remains the base contract |
| Link semantics | Doctor token can create sessions | UI copy can imply one patient, but the token is reusable |

The full final result also reaches the patient browser response while remaining
hidden in the default UI. This is an acknowledged MVP exposure, not a supported
patient-facing feature.

Low-back label absence and sparse-evidence out-of-label-space behavior are
verified by current artifact/evaluation evidence. Only the exact live rhinitis
path remains unverified among the named low-acuity scenarios.

## Operational limitations

- Recreate, deploy, rollback, or crash loses every in-memory token and session.
- Browser timeout is shorter than the backend's full LLM retry allowance.
- Browser completion does not independently prove Telegram/PDF delivery.
- Reloading the patient page does not restore the active interview.
- The hypothesis renderer is deterministic and has limited narrative synthesis.
- No CI automatically verifies or deploys `main`.
- Deep health can fail because of a dependency while shallow liveness remains green.

## Unverified items

The following require new evidence rather than confident prose:

1. Current production reachability after the accepted 2026-07-17 P0 report.
2. Continued automatic renewal and broad client compatibility of the IP certificate.
3. Current no-SNI behavior after any Caddy or certificate change.
4. End-to-end Telegram delivery for a newly created real session.
5. Equal clinical extraction and rule quality for Kazakh patient text.
6. Clinical validity outside the evaluated corpus and reviewed routing rows.
7. Exact live rhinitis behavior on the current production revision.
8. Effective abuse protection while `DOCTOR_ACCESS_CODE` remains unused.
9. Recovery behavior under concurrent deploys with active patient sessions.

## Superseded statements

| Earlier statement | Snapshot correction |
|---|---|
| “The prototype has never run live” | Superseded for exact SHA `19aa755` by the accepted 2026-07-17 P0 report |
| “The VPS and ports are uninspected” | Superseded only to the extent recorded by the accepted deployment report |
| “`sslip.io` is the production canonical origin” | Bare IP is report-backed canonical; `sslip.io` is the rollback alias |
| “The old GitHub repository is the project home” | `demeu-ai/demeu` is the accepted private repository with default `main` |
| “A generated link is necessarily single-patient” | The underlying doctor token is reusable across sessions |

Statements about unavailable external services, missing credentials, or absent
artifacts in early planning documents should be treated as historical unless a
current code artifact or accepted report confirms them.

## Updating this snapshot

1. Name the exact commit and evidence timestamp.
2. Link a repository artifact or accepted report for every changed status.
3. Keep observed production facts separate from current-live assertions.
4. Add new SPINE drift here before changing explanatory docs.
5. Never include credentials, patient transcripts, or Telegram identifiers.
6. Re-run terminology, relative-link, lint, TypeScript, and relevant test audits.
