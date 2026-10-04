# Finalization contract amendments — October 2026

These explicit amendments implement ClickUp z8udzk9xyu and extend the July SPINE web-PDF and patient-retention limitations. September safe closing, clinician triage, catalogue and session contracts remain authoritative. The patient package is an additional preparation projection, never a clinical result.

## B3 registration snapshot and research estimate

Referral persistence schema **v5** adds one immutable `registrationSnapshot`
and a `registration_snapshot_recorded` journal event. Only the assigned doctor
may create it, once, with explicit registration-time attestation. The snapshot
uses exactly `bed_profile`, `icd10_ref_diag_code`, `referring_mo`,
`hospital_mo`, `territorial_type`, `finance_source`, and `referral_purpose`.
No mutable referral field is copied into it. Only `bed_profile` may be null.

`GET /api/referrals/{id}/risk` applies the existing owner/assigned-doctor scope
before touching the server-only JSON artifact. Missing inputs or failed
artifact verification return an explicit unavailable state. An available value
is the probability of refusal among mature, non-conflicting observed outcomes,
with a validation-selected working threshold. It carries
`limitationsLabel: "experimental_research_only"`, has no causal explanation, and cannot affect any
clinical or operational decision. The source license is not verified and the
March benchmark was previously examined.

## Patient preparation access

Patient intake invitations are created by doctor accounts only. Owners retain organizational read/admin access and manual organizational directions; they cannot create owner-owned patient questionnaires. Preparation issuance/reissue requires an active assigned doctor in the same organization, resolved from current accounts in production. Legacy owner-owned directions return `409 DOCTOR_ASSIGNMENT_REQUIRED` rather than creating an unconfirmable patient flow. Physician confirmation requires the assigned doctor; managerial owner status is not a clinical attestation.

- Chat start adds optional `preparationId`, `preparationUrl`, or `preparationPending: true`. The initial capability is persisted in the referral repository before returning it, bound to the proven source session and link owner. Creation of the direction binds that grant to the immutable source episode.
- Preparation access lasts **30 days** independently of session transcript retention. Database stores the purpose-separated SHA256 hash, scope, issue/expiration/revocation times and issuing/revoking actor. It never stores plaintext capability tokens. Initial HMAC-derived token supports an authenticated retry using the existing chat cookie if the grant write fails. Retry cannot extend, revive or replace an expired/revoked grant, nor silently replace one after authentication-secret rotation.
- On grant persistence failure, the successful chat response and chat cookie remain usable and `preparationPending` signals recovery. `POST /api/chat/preparation` requires the existing session cookie and live source session; it persists/replays that same initial grant. After source cleanup a physician can issue a new preparation link from the direction.
- Patient cookies are unique per access ID, HttpOnly, SameSite=Strict, production Secure, restricted to `/api/patient`. Each request proves the matching capability and scope. Doctor invitation token, session ID or workspace cookie alone is insufficient.
- `POST /api/patient/access { token }` exchanges the unique `/p/{token}` preparation link for a cookie. Client replaces the bearer URL with `/p/{accessId}` immediately. Page metadata and API/fetch policies prohibit referrers; APIs use no-store. The unique preparation URL works in another browser.
- Original `/c/{doctorToken}` first resolves a saved nonsecret access ID and capability cookie. With browser storage cleared, `POST /api/patient/discover { token: doctorToken }` resolves only a grant whose corresponding preparation cookie proves its capability and whose persisted source-link hash matches. Invitation token alone never returns a package. Discovery persists no raw invitation token and never selects another episode implicitly.
- `GET /api/referrals/{id}/patient-access` is doctor/owner scoped and returns `accessRevision`, `active`, `expiresAt`. `POST` accepts `{ action: "reissue" | "revoke", expectedAccessRevision, idempotencyKey }`. Revision is the number of grants plus revoked grants for this episode. Successful commands are idempotent; reissue deterministically reproduces the same purpose-separated HMAC token for retry and revokes previous links. Stale competing commands fail 409. Previously revoked reissue commands cannot revive old links. Physician UI provides issuance/revocation and the unique link.

## Patient checklist and PDF

`GET /api/patient/{accessId}/package` returns exactly `{ package: PatientPackage }`. It accepts either no query parameters for JSON, or `format=pdf` with optional `lang=ru|kk`; PDF language defaults to Russian. Duplicate keys, unknown keys, an invalid format or language return `400`. Patient package POST endpoints reject every query parameter. Capability, cookie, scope and same-origin checks run before query validation so malformed input cannot probe another episode. The PDF uses the bundled Unicode font. The projection includes episode label, destination/date, care context, catalogue version/source/validation status, requirements, durations, applicability, server-calculated dates, preparation and confirmed-completeness states. It contains no clinical snapshot, symptoms, hypotheses, routing, risk, confidence, transcript, doctor identity or credential hashes.

Requirements come exclusively from the persisted `requirementSnapshot`. Legacy records without a snapshot show unavailable requirements; the current catalogue never silently rewrites the episode. The unvalidated source remains explicitly unvalidated in both languages and PDF. Calendar validity may be shown as a preliminary preparation calculation without claiming clinician validation or verified readiness.

Expiry is the performance date plus the persisted number of calendar days. Patient cannot submit expiration or applicability. Conditional items need explicit physician applicability `yes` before patient marks are accepted; `no` or unknown cannot be changed by the patient. Results performed after the appointment are never presented as valid at that appointment. Missing validity and missing information remain unknown. Physician-confirmed expiration, when available and earlier, limits verified preparation; a new patient claim never borrows expiration from a different old result.

## Self-reports and clinical confirmation

`POST /api/patient/{accessId}/package` accepts only `{ requirementId, performedOn, resultAvailable, expectedRevision, idempotencyKey }`. Calendar dates are validated against the current Kazakhstan date. Audit entries are immutable `patient_self_report` records with actor access ID, time, catalogue version, item revision and accepted command payload/key. Replays do not duplicate entries; conflicting payloads and stale revisions fail 409. Identical edits with a new key fail `NO_CHANGES` without appending. Durable limits are ten changed claims per minute per grant, twenty claims per item and two hundred per episode; reaching a limit returns 429 and directs the patient to the physician. History remains intact and one patient cannot fill shared storage through unlimited repeated writes.

Patient reports update the preparation projection and appear in the physician direction. They never mutate physician examinations, the doctor event journal or verified readiness automatically.

`POST /api/referrals/{id}/patient-reports/confirm` accepts `{ reportId, expectedReportRevision, expectedRevision, idempotencyKey }`. Only the assigned physician with the doctor role can explicitly confirm the current claim after checking its actual result. The transaction validates both revisions, calculates expiration from the snapshot, writes an examination with `patientReportId`, and adds a doctor-confirmation event with actor, time and claim reference. Stale claims or claims for requirements absent from the current snapshot cannot be confirmed. Confirmation is idempotent; patient UI/PDF distinguish confirmed claims from reports still awaiting checking. Manual physician corrections remove obsolete report provenance.

## Physician assessment and care context

The completed intake `triageSnapshot` is immutable. A physician-authored correction is stored separately as `doctorAssessment`: text, profile, ICD-10 code, care context, server-resolved author, server time and independent assessment revision. `POST /api/referrals/{id}/doctor-assessment` requires the assigned doctor, global `expectedRevision`, `expectedAssessmentRevision`, an idempotency key and a nonempty reason. Owners retain scoped read access but cannot author this assessment. Foreign doctors and organizations receive `404` before body parsing. Unknown query keys are rejected.

Each accepted correction appends `doctor_assessment_changed`; the event preserves before/after assessment and requirement snapshots. It cannot rewrite the intake result. Profile and ICD-10 remain top-level compatibility projections for existing readers. Legacy profile/ICD PATCH remains accepted only for the assigned physician with a reason and is routed through the same assessment audit. The dedicated endpoint remains the canonical write contract.

Care context is `operative`, `conservative` or `unknown`. Unknown context has no active checklist, memo items or patient PDF items. A previously persisted operative draft remains in audit state but is not presented as applicable. Changing profile or care context creates a new requirement snapshot identity. Patient reports and physician-confirmed examination applicability are bound to that identity and cannot silently reappear after operative → conservative → operative changes. A text-only or ICD-only correction that leaves the package unchanged preserves the identity and current evidence.

Operative and conservative drafts are separate catalogues. The conservative draft is `validated:false`, adult/inpatient/conservative scope, and cites [Appendix 5 in the 17 February 2025 № 9 revision](https://old.adilet.zan.kz/rus/docs/V2200027218). The source-backed common portion includes the shared blood, urine and core biochemistry studies; urea/glucose, coagulation and ECG retain their documented conditions, including the separate oncology ECG validity period. Therapist is absent from this projection. Profile additions are explicitly `profile_addition_unverified`, `required:null` and conditional until a physician confirms applicability. This source provenance does not claim hospital clinician validation.

The vascular pilot is explicit: a physician may select `Сосудистая хирургия` with I65.2. Codes do not choose profiles automatically. I67.1 does not create or infer a neurosurgical profile, and no such profile is added to the closed catalogue.

## Persistence and rollback

Referral database schema is **v6**; requirement catalogue schema remains v1. v1/v2 snapshots migrate through the empty patient-access state. Genuine v3 snapshots require patient access/report arrays and migrate to `doctorAssessment:null`; their historical operative draft remains stored but inactive until the assigned physician chooses a care context. Because v3 reports did not identify a package epoch, migration retains them under a non-active legacy identity rather than guessing that they belong to the last profile. Early v3 access records without optional `sourceLinkHash` normalize that hint to null and gain no discovery authority. V4 assessment, package identity, reports and access state are preserved exactly while adding `registrationSnapshot:null`. V5 additionally validates the single assigned-doctor registration event against the immutable top-level snapshot. V5 → v6 creates empty MIS outbox and ACK-command ledgers. It does not backfill or export any historical referral. Unknown fields and future or nonnumeric schema versions fail closed.

`deploy/referral-schema-version` is 6. Existing fail-closed deployment/rollback schema gates must reject rollback to a binary supporting only v5 once v6 state is active. No production migration or server run is claimed by this document.

## MIS pull and ACK integration

MIS uses two POST-only endpoints: `POST /api/mis/v1/events/pull` and
`POST /api/mis/v1/events/{eventId}/ack`. They accept only a dedicated bearer
credential bound to one organization and one stable `integrationId`. Browser,
patient and workspace cookies grant no MIS access. `events:pull` and
`events:ack` are separate scopes; research events also require
`events:research`. Credentials are reread on every request, so disabling or
rotating a key is effective without a process restart. Rotation preserves the
stable integration identity and therefore can continue an existing lease.

The credential JSON has schema version 1 and contains integrations with
`integrationId`, `organizationId`, `enabled`, and one or more keys. Each key
contains `credentialId`, a purpose-separated `sha256$...` hash, `enabled`, a
nonempty exact scope list, and an optional millisecond `expiresAt`. Store the
file outside Git, as a regular non-symlink file. Production requires mode
`0600`. Set `DEMEU_MIS_CREDENTIALS_FILE` to its container path. Never put a
plaintext credential or hash into `.env`, logs, examples, or support messages.
The stock deployment needs a Stage 6 reviewed optional read-only mount and
preflight before this integration can be enabled; this document does not claim
that mount or any external MIS connection is active.

Pull creates a five-minute lease. `eventId` remains stable across retries,
`deliveryId` changes on each lease attempt, and `sequence` increases per
referral across event families. A consumer deduplicates by `eventId`, tracks
freshness independently for each `(referralId, type)`, and ignores a late lower
sequence only within that same event type. Gaps are valid because credentials
without research scope cannot see that event family. ACK after lease expiry, a stale
delivery, a cross-organization lookup, or a revoked research scope fails
closed. The idempotency ledger binds the integration, key, event, delivery,
ACK time and exact response. Outbox mutation and the referral mutation that
causes it share one referral repository transaction. `payloadHash` detects
snapshot inconsistency; it is not a cryptographic tamper-evidence claim.

Readiness events contain only the physician-confirmed preliminary hypothesis,
ICD-10 code, active profile and care context, destination, safe urgency/red
flag labels, and validated package projection. A ready state requires a
current physician assessment, future or current scheduled date, matching
operative or conservative package, and a `validated:true` catalogue. The
catalogues shipped in this repository remain `validated:false`, so real data
cannot currently produce ready. Positive readiness fixtures are synthetic.
Pull rechecks calendar expiry and current referral state, and publishes the
current negative state after channel enrollment or a later state change.
The readiness channel is enrolled when its first positive state is evaluated,
even before delivery. If that pending positive becomes false, it is replaced
by the current `not_ready` state. Consumers must treat messages as ordered
state updates and use `data.state`; receipt of an event alone is not a ready
alert.

Research events are a separate state stream. The server opt-in
`DEMEU_MIS_RESEARCH_EVENTS=I_ACKNOWLEDGE_RESEARCH_ONLY` controls baseline
persistence and trusted scoring. The credential scope `events:research`
separately controls evaluation during pull, delivery and ACK. Removing that
scope does not erase an already persisted baseline. A new v6 registration can publish an initial sanitized
`below_threshold` or `unavailable` state so later verified artifact recovery
can transition to `high`. `high` is emitted only by the trusted SHA and oracle
verified scorer at or above its working threshold. Initial state updates are
not alerts. Migrated v5 registrations are not enrolled and are never scored or
exported implicitly. Turning the server gate off publishes or retains a safe
unavailable correction for an enrolled stream. Raw registration features,
coverage categories, patient reports, transcript, actor names and delivery
capabilities are never stored in the MIS payload.

## OpenAPI and API portal

`GET /api/openapi` and `docs/openapi.json` are generated from the same route
registry used by `/api-docs`. The OpenAPI 3.1 document covers 38 successful
operations and four intentional unsupported-method contracts, distinct
workspace, patient and MIS security schemes, conditional deep-health proof,
strict query metadata, service scopes, rate limits, PDF media types, B3
available/unavailable responses and the closed MIS event unions. Dynamic
patient capability cookies are issued by the server; examples use a cookie jar
instead of inventing a fixed cookie name. External MIS acceptance, replay
tests against a partner implementation and live credential provisioning remain
external gates.

This phase does not automatically delete MIS outbox or ACK ledger entries.
Retention window, replay horizon, polling and availability SLA, partner
correlation rules and external acceptance are still explicit external
decisions before a live connector can be enabled.

## Remaining external acceptance

The clinical source is still unvalidated pending the hospital physician. Local mock acceptance checks can prove access isolation, persistence, reporting, PDF, language states and doctor confirmation; they cannot establish clinical validation or live production delivery. Those facts must be recorded separately with actual evidence.


## Acceptance remnants — explicit October 4 amendments

- Aborted Telegram notices omit naked session identifiers and doctor/capability
  tokens. Scoped delivery may include `/workspace/intakes/{nonsecret sessionId}`;
  that endpoint still requires the appropriate authenticated doctor scope. Private
  delivery-journal identity and payload are hashes, not outbound identifiers.
- Analyst responses replay immutable audited events and expose only the last safe
  publication: at least five meaningfully changed referrals in every affected
  before/after cell. Stage-entry timing changes count; cosmetic, assessment or
  examination changes without a disclosed contribution change do not. Pending
  changes never toggle total, suppression, period, timing or another response field.
  Before the first release, the public empty-period sentinel is 1970-01-01.
- Installation-fixture cleanup removes only that exact referral and dependent
  patient grants/claims, commands and MIS events/ACK commands. It keeps unrelated
  source bindings/links and audit fields unchanged. Patient grants live 30 days
  independently of chat retention; source-token ownership bindings remain available
  for their validation and cannot be erased as an incidental transcript cleanup.
- Current red-flag report refresh runs only deterministic TS rules offline. Current
  source, runner, frozen corpus and predictions are SHA-bound. Historical candidate
  metadata, dates and artifact bytes are pinned; Qwen/Jev were not reevaluated.
  No unseen-generalization or clinical-validation claim is introduced.
- Database reader schema is 6 after audited care-context, registration and MIS
  amendments. Docker bakes the exact reader marker. Automatic fallback uses the
  saved immutable image capability against full live JSON both before activation
  and before recovery; missing capability fails closed. Supported writable recovery
  and the legacy markerless first-boundary gate are in deploy/DEPLOY.md.
- Optional stock MIS mount uses an explicit private host file, read-only normal
  mapped runtime UID, strict bounded schema validation and mode 0600. It is absent
  by default and does not bypass health, readiness or rollback gates.

The observed production on 04.10 remains e5cc4a2; the finalization worktree is not
claimed deployed. Clinical validation and real MIS acceptance remain external.
