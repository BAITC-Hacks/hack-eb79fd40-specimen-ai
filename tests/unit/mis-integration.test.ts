import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import conservativeCatalogueData from "../../data/examination_requirements_conservative.json";
import { misPayloadHash, projectReadiness, reconcileMisEvent, reconcileResearchRisk } from "../../lib/mis/projection";
import { MisService } from "../../lib/mis/service";
import { validateMisStorage } from "../../lib/mis/state";
import type { MisEventData, MisOutboxEvent, MisPrincipal, MisRiskPort } from "../../lib/mis/types";
import type { Referral, ReferralDatabase, ReferralRepository, RequirementCatalogue } from "../../lib/referrals/types";
import { DEFAULT_REQUIREMENTS, validateRequirementCatalogue } from "../../lib/referrals/requirements";
import { FileReferralRepository, MemoryReferralRepository, ReferralService, validateReferralDatabase } from "../../lib/referrals/service";

const now = Date.parse("2026-10-04T06:00:00Z");
const full: MisPrincipal = { integrationId: "integration-a", credentialId: "credential-a", organizationId: "org-a",
  scopes: ["events:pull", "events:ack", "events:research"] };
const ordinary: MisPrincipal = { ...full, scopes: ["events:pull", "events:ack"] };

function catalogue(treatment: "operative" | "conservative" = "operative"): RequirementCatalogue {
  return { schemaVersion: 1, version: `validated-${treatment}`, status: "available", source: "synthetic-test-only", validated: true,
    scope: { population: "adult", careSetting: "inpatient", treatment }, profiles: [{ profile: "Хирургический", requirements: [
      { id: "required", label: "Обязательное", required: true, conditional: false, validForDays: 30 },
      { id: "optional", label: "Условное", required: false, conditional: true, validForDays: null },
    ] }] };
}

function referral(treatment: "operative" | "conservative" = "operative"): Referral {
  return {
    id: "ref-a", organizationId: "org-a", doctorId: "doctor-a", patientLabel: "Синтетический эпизод", sourceSessionId: null,
    triageSnapshot: null, registrationSnapshot: null, profile: "Хирургический", icd10Code: "I20.9", specialistReferred: true,
    preparationStarted: true, destinationOrganization: "Стационар", sent: null, queue: null, scheduledDate: "2026-10-10",
    attendance: null, cancelled: false, createdAt: now, updatedAt: now, revision: 4, events: [],
    doctorAssessment: { hypothesis: "Предварительная гипотеза", profile: "Хирургический", icd10Code: "I20.9", careContext: treatment,
      authorId: "doctor-a", authorName: "Врач", recordedAt: now, revision: 1 },
    requirementSnapshot: catalogue(treatment), requirementSnapshotId: "package-1",
    examinations: [
      { id: "exam-1", requirementSnapshotId: "package-1", requirementId: "required", label: "Обязательное", resultAvailable: true,
        performedOn: "2026-10-01", expiresOn: "2026-10-31", applicability: "yes" },
      { id: "exam-2", requirementSnapshotId: "package-1", requirementId: "optional", label: "Условное", resultAvailable: null,
        performedOn: null, expiresOn: null, applicability: "no" },
    ],
  };
}

function database(record = referral()): ReferralDatabase {
  return { schemaVersion: 6, referrals: [record], links: [], commands: [], patientAccess: [], patientReports: [], misOutbox: [], misCommands: [] };
}

class TestRepository implements ReferralRepository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public state: ReferralDatabase) {}
  async read<R>(fn: (state: Readonly<ReferralDatabase>) => R): Promise<R> {
    await this.queue;
    return structuredClone(fn(structuredClone(this.state)));
  }
  transaction<R>(fn: (draft: ReferralDatabase) => R | Promise<R>): Promise<R> {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      this.state = draft;
      return structuredClone(result);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

const ready = (profile = "Хирургический"): MisEventData => ({ state: "ready", hypothesis: "Предварительная гипотеза", icd10Code: "I20.9", profile,
  careContext: "operative", destinationOrganization: "Стационар", urgency: "planned", redFlags: [], catalogue: { version: "test", validated: true },
  evaluatedOn: "2026-10-10", validUntil: "2026-10-31", requirements: [] });
const notReady = (reason = "SCHEDULE_IN_PAST"): MisEventData => ({ state: "not_ready", reasonCodes: [reason], evaluatedOn: "2026-10-04" });
const high = (): MisEventData => ({ state: "high", researchOnly: true, modelVersion: "test-model", inputRevision: 5,
  refusalProbabilityAmongMatureOutcomes: 0.8, workingThreshold: 0.4, riskBand: "at_or_above_working_threshold", evaluatedAt: now,
  limitations: ["Synthetic test only"] });
const unavailable = (reasonCode: "RESEARCH_EXPORT_DISABLED" | "REGISTRATION_SNAPSHOT_MISSING" | "INPUTS_INCOMPLETE" | "ARTIFACT_UNAVAILABLE" | "ARTIFACT_INVALID" = "ARTIFACT_UNAVAILABLE"): MisEventData => ({ state: "unavailable", researchOnly: true,
  modelVersion: null, inputRevision: 5, evaluatedAt: now, reasonCode });

function append(state: ReferralDatabase, type: MisOutboxEvent["type"], data: MisEventData, at: number, id: string) {
  return reconcileMisEvent(state, state.referrals[0], type, data, at, () => id, true)!;
}
function acked(event: MisOutboxEvent, at = now + 1) {
  event.status = "acked"; event.deliveryAttempt = 1; event.deliveryId = `delivery-${event.eventId}`;
  event.leasedByIntegrationId = "integration-a"; event.leasedAt = now; event.leaseUntil = now + 300_000;
  event.ackedAt = at; event.ackedDeliveryId = event.deliveryId; event.ackedByIntegrationId = "integration-a";
}
function leased(event: MisOutboxEvent, until: number) {
  event.status = "leased"; event.deliveryAttempt = 1; event.deliveryId = `delivery-${event.eventId}`;
  event.leasedByIntegrationId = "integration-a"; event.leasedAt = now; event.leaseUntil = until;
}

describe("MIS readiness projection", () => {
  it.each(["operative", "conservative"] as const)("exports a validated %s package and preserves honest optional status", (treatment) => {
    const projected = projectReadiness(referral(treatment), now);
    expect(projected).toMatchObject({ state: "ready", careContext: treatment, catalogue: { validated: true } });
    if (projected.state === "ready") expect(projected.requirements.find((item) => item.requirementId === "optional")?.status).toBe("not_applicable");
  });

  it("rejects real unvalidated and past-date packages", () => {
    const record = referral();
    record.requirementSnapshot = { ...catalogue(), validated: false };
    expect(projectReadiness(record, now)).toMatchObject({ state: "not_ready", reasonCodes: expect.arrayContaining(["CATALOGUE_UNVALIDATED"]) });
    record.requirementSnapshot = catalogue();
    record.scheduledDate = "2026-10-03";
    expect(projectReadiness(record, now)).toMatchObject({ state: "not_ready", reasonCodes: expect.arrayContaining(["SCHEDULE_IN_PAST"]) });
  });

  it.each([
    ["operative", DEFAULT_REQUIREMENTS],
    ["conservative", validateRequirementCatalogue(conservativeCatalogueData)],
  ] as const)("never projects shipped %s catalogue data as ready", (treatment, shipped) => {
    const record = referral(treatment);
    record.requirementSnapshot = { ...structuredClone(shipped),
      profiles: shipped.profiles.filter((entry) => entry.profile === record.profile) };
    record.examinations = [];
    expect(record.requirementSnapshot.validated).toBe(false);
    expect(projectReadiness(record, now)).toMatchObject({ state: "not_ready",
      reasonCodes: expect.arrayContaining(["CATALOGUE_UNVALIDATED"]) });
  });

  it("does not let an inapplicable stale expiry shorten ready-package validity", () => {
    const record = referral();
    record.examinations[1].expiresOn = "2026-10-01";
    const projected = projectReadiness(record, now);
    expect(projected).toMatchObject({ state: "ready", validUntil: "2026-10-31",
      requirements: expect.arrayContaining([expect.objectContaining({ requirementId: "optional", status: "not_applicable", expiresOn: "2026-10-01" })]) });
  });
});

describe("MIS outbox state machine", () => {
  it("leases at least once with stable eventId, increasing delivery attempts and a monotonic wire sequence", async () => {
    let clock = now;
    const state = database();
    append(state, "referral.readiness.changed", projectReadiness(state.referrals[0], clock), clock, "event-1");
    const repository = new TestRepository(state);
    let serial = 0;
    const service = new MisService(repository, { now: () => clock, id: () => `generated-${++serial}`,
      risk: { evaluate: async () => ({ status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }) }, researchEventsEnabled: false });
    const first = await service.pull(full, 10);
    expect(first.events[0]).toMatchObject({ eventId: "event-1", sequence: 1, deliveryAttempt: 1 });
    expect((await service.pull(full, 10)).events).toEqual([]);
    clock += 300_001;
    const second = await service.pull(full, 10);
    expect(second.events[0]).toMatchObject({ eventId: "event-1", sequence: 1, deliveryAttempt: 2 });
    expect(second.events[0].deliveryId).not.toBe(first.events[0].deliveryId);
    await expect(service.ack(full, "event-1", { deliveryId: first.events[0].deliveryId, idempotencyKey: "ack-old-1" }))
      .rejects.toMatchObject({ code: "DELIVERY_STALE" });
    const accepted = await service.ack(full, "event-1", { deliveryId: second.events[0].deliveryId, idempotencyKey: "ack-new-1" });
    expect(accepted).toMatchObject({ acked: true, replayed: false });
    expect(await service.ack(full, "event-1", { deliveryId: second.events[0].deliveryId, idempotencyKey: "ack-new-1" }))
      .toMatchObject({ acked: true, replayed: true });
  });

  it("keeps readiness ordering independent from hidden research and requires research scope for its ACK", async () => {
    const record = referral();
    record.registrationSnapshot = { bed_profile: null, icd10_ref_diag_code: "I20.9", referring_mo: "A", hospital_mo: "B",
      territorial_type: "C", finance_source: "D", referral_purpose: "E" };
    record.events.push({ id: "registration-event", type: "registration_snapshot_recorded", actorId: "doctor-a", actorName: "Врач",
      source: "doctor_confirmation", occurredAt: null, recordedAt: now, reason: null, before: null, after: record.registrationSnapshot, revision: 5 });
    record.revision = 5;
    const state = database(record);
    append(state, "referral.research_risk.changed", high(), now, "risk-1");
    append(state, "referral.readiness.changed", projectReadiness(state.referrals[0], now + 1), now + 1, "ready-1");
    const service = new MisService(new TestRepository(state), { now: () => now + 2, id: () => "delivery-1",
      risk: { evaluate: async () => ({ status: "available", researchOnly: true, modelVersion: "test-model",
        refusalProbabilityAmongMatureOutcomes: 0.8, workingThreshold: 0.4, riskBand: "at_or_above_working_threshold", limitations: ["Synthetic test only"] }) }, researchEventsEnabled: true });
    const readiness = (await service.pull(ordinary, 10)).events;
    expect(readiness.map((event) => [event.type, event.sequence])).toEqual([["referral.readiness.changed", 2]]);
    const research = (await service.pull(full, 10)).events;
    expect(research.map((event) => [event.type, event.sequence])).toEqual([["referral.research_risk.changed", 1]]);
    await expect(service.ack(ordinary, "risk-1", { deliveryId: research[0].deliveryId, idempotencyKey: "research-ack" })).rejects.toMatchObject({ status: 404 });
  });

  it("leases once under concurrent pulls, hides cross-org events, and permits key rotation within one integration", async () => {
    const repository = new MemoryReferralRepository();
    let serial = 0;
    const actor = { id: "doctor-a", displayName: "Врач", role: "doctor" as const, organizationId: "org-a" };
    const referrals = new ReferralService(repository, { now: () => now, id: () => `domain-${++serial}`,
      catalogue: { ...catalogue(), profiles: [{ profile: "Хирургический", requirements: [catalogue().profiles[0].requirements[0]] }] } });
    let record = await referrals.create(actor, { patientLabel: "Atomic", profile: "Хирургический", icd10Code: "I20.9",
      destinationOrganization: "Стационар", idempotencyKey: "atomic-create" });
    record = await referrals.assess(actor, record.id, { expectedRevision: record.revision, expectedAssessmentRevision: 0,
      idempotencyKey: "atomic-assess", reason: "Подтверждено", assessment: { hypothesis: "Предварительная гипотеза",
        profile: "Хирургический", icd10Code: "I20.9", careContext: "operative" } });
    record = await referrals.update(actor, record.id, { expectedRevision: record.revision, idempotencyKey: "atomic-facts",
      patch: { specialistReferred: true, scheduledDate: "2026-10-10" } });
    await referrals.examination(actor, record.id, { expectedRevision: record.revision, idempotencyKey: "atomic-exam",
      record: { requirementId: "required", label: "Обязательное", resultAvailable: true, performedOn: "2026-10-01",
        expiresOn: "2026-10-31", applicability: "yes" } });
    const service = new MisService(repository, { now: () => now, id: () => `delivery-${++serial}`,
      risk: { evaluate: async () => ({ status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }) }, researchEventsEnabled: false });
    const pulls = await Promise.all([service.pull(full, 10), service.pull(full, 10)]);
    expect(pulls.flatMap((result) => result.events)).toHaveLength(1);
    const event = pulls.flatMap((result) => result.events)[0];
    await expect(service.ack({ ...full, organizationId: "org-z" }, event.eventId,
      { deliveryId: event.deliveryId, idempotencyKey: "foreign-ack" })).rejects.toMatchObject({ status: 404 });
    const rotated = { ...full, credentialId: "credential-rotated" };
    await expect(service.ack(rotated, event.eventId, { deliveryId: event.deliveryId, idempotencyKey: "rotated-ack" }))
      .resolves.toMatchObject({ acked: true });
  });

  it("re-evaluates calendar currentness and emits a past-date state update", async () => {
    let clock = now;
    const state = database();
    append(state, "referral.readiness.changed", projectReadiness(state.referrals[0], clock), clock, "ready-time");
    const repository = new TestRepository(state);
    let serial = 0;
    const service = new MisService(repository, { now: () => clock, id: () => `time-${++serial}`,
      risk: { evaluate: async () => ({ status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }) }, researchEventsEnabled: false });
    const delivered = (await service.pull(full, 1)).events[0];
    await service.ack(full, delivered.eventId, { deliveryId: delivered.deliveryId, idempotencyKey: "time-ack" });
    clock = Date.parse("2026-10-11T06:00:00Z");
    expect((await service.pull(full, 1)).events[0]).toMatchObject({ sequence: 2,
      data: { state: "not_ready", reasonCodes: expect.arrayContaining(["SCHEDULE_IN_PAST"]) } });
  });

  it("suppresses an expired unACKed ready lease before delivering its current not-ready state", async () => {
    let clock = now;
    const state = database();
    append(state, "referral.readiness.changed", projectReadiness(state.referrals[0], clock), clock, "stale-ready");
    const repository = new TestRepository(state);
    let serial = 0;
    const service = new MisService(repository, { now: () => clock, id: () => `stale-${++serial}`,
      risk: { evaluate: async () => ({ status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }) }, researchEventsEnabled: false });
    const first = (await service.pull(full, 1)).events[0];
    expect(first).toMatchObject({ eventId: "stale-ready", data: { state: "ready" } });
    clock = Date.parse("2026-10-11T06:00:00Z");
    const next = (await service.pull(full, 10)).events;
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ sequence: 2, data: { state: "not_ready", reasonCodes: expect.arrayContaining(["SCHEDULE_IN_PAST"]) } });
    expect(next[0].eventId).not.toBe(first.eventId);
  });

  it("never reuses evidence from an old package identity", () => {
    const record = referral();
    record.examinations[0].requirementSnapshotId = "old-package";
    expect(projectReadiness(record, now)).toMatchObject({ state: "not_ready",
      reasonCodes: expect.arrayContaining(["PACKAGE_INCOMPLETE"]) });
  });

  it("retracts an ACKed positive across pending changes and cyclic states", () => {
    const state = database();
    const first = append(state, "referral.readiness.changed", ready(), now, "ready-a");
    acked(first);
    append(state, "referral.readiness.changed", ready("Кардиология"), now + 2, "ready-b");
    const correction = reconcileMisEvent(state, state.referrals[0], "referral.readiness.changed", notReady(), now + 3, () => "negative-c")!;
    expect(state.misOutbox![1]).toMatchObject({ eventId: "ready-b", status: "superseded", deliveryAttempt: 0 });
    expect(correction).toMatchObject({ eventId: "negative-c", data: { state: "not_ready" }, status: "pending", sequence: 3 });
    acked(correction, now + 4);
    const again = reconcileMisEvent(state, state.referrals[0], "referral.readiness.changed", ready(), now + 5, () => "ready-d")!;
    expect(again).toMatchObject({ data: { state: "ready" }, sequence: 4 });
  });

  it("replaces an enrolled pending positive with the current negative state", () => {
    const state = database();
    const pending = append(state, "referral.readiness.changed", ready(), now, "ready-pending");
    const correction = reconcileMisEvent(state, state.referrals[0], "referral.readiness.changed", notReady(), now + 1, () => "negative-hidden");
    expect(pending.status).toBe("superseded");
    expect(correction).toMatchObject({ eventId: "negative-hidden", status: "pending", data: { state: "not_ready" } });
    expect(state.misOutbox!.filter((event) => event.status === "pending")).toHaveLength(1);
  });

  it("resubmits a negative after an unACKed positive escaped after the last negative ACK", () => {
    const state = database();
    const negative = append(state, "referral.readiness.changed", notReady(), now, "negative-a");
    acked(negative);
    const positive = append(state, "referral.readiness.changed", ready(), now + 2, "ready-b");
    leased(positive, now + 3);
    const correction = reconcileMisEvent(state, state.referrals[0], "referral.readiness.changed", notReady(), now + 4, () => "negative-c");
    expect(positive.status).toBe("superseded");
    expect(correction).toMatchObject({ eventId: "negative-c", status: "pending" });
  });

  it.each([
    ["referral.readiness.changed", ready(), notReady("FIRST_REASON"), notReady("CHANGED_REASON")],
    ["referral.research_risk.changed", high(), unavailable("ARTIFACT_UNAVAILABLE"), unavailable("RESEARCH_EXPORT_DISABLED")],
  ] as const)("does not lose a %s correction when its expired delivery changes", (type, initial, firstNegative, changedNegative) => {
    const state = database();
    const positive = append(state, type, initial, now, "positive-a"); acked(positive);
    const negative = append(state, type, firstNegative, now + 2, "negative-b"); leased(negative, now + 3);
    const replacement = reconcileMisEvent(state, state.referrals[0], type, changedNegative, now + 4, () => "negative-c");
    expect(negative.status).toBe("superseded");
    expect(replacement).toMatchObject({ eventId: "negative-c", status: "pending" });
  });

  it.each([
    ["referral.readiness.changed", ready(), notReady()],
    ["referral.research_risk.changed", high(), unavailable()],
  ] as const)("re-emits the same positive %s state after an escaped correction", (type, initial, negative) => {
    const state = database();
    const first = append(state, type, initial, now, "positive-a"); acked(first);
    const correction = append(state, type, negative, now + 2, "negative-b"); leased(correction, now + 3);
    const restored = reconcileMisEvent(state, state.referrals[0], type, initial, now + 4, () => "positive-c");
    expect(correction.status).toBe("superseded");
    expect(restored).toMatchObject({ eventId: "positive-c", status: "pending", sequence: 3 });
  });

  it.each([
    ["referral.readiness.changed", notReady("REASON_A"), notReady("REASON_B")],
    ["referral.research_risk.changed", unavailable("ARTIFACT_UNAVAILABLE"), unavailable("RESEARCH_EXPORT_DISABLED")],
  ] as const)("re-emits a restored negative %s state after a different correction escaped", (type, firstData, secondData) => {
    const state = database();
    const first = append(state, type, firstData, now, "negative-a"); acked(first);
    const second = append(state, type, secondData, now + 2, "negative-b"); leased(second, now + 3);
    const restored = reconcileMisEvent(state, state.referrals[0], type, firstData, now + 4, () => "negative-c");
    expect(second.status).toBe("superseded");
    expect(restored).toMatchObject({ eventId: "negative-c", status: "pending", sequence: 3 });
  });

  it("keeps the latest enrolled research state before the first delivery", () => {
    const state = database();
    const first = append(state, "referral.research_risk.changed", unavailable(), now, "baseline-a");
    const below: MisEventData = { state: "below_threshold", researchOnly: true, modelVersion: "verified-v1", inputRevision: 5,
      evaluatedAt: now + 1, reasonCode: "BELOW_WORKING_THRESHOLD" };
    const second = reconcileMisEvent(state, state.referrals[0], "referral.research_risk.changed", below, now + 1, () => "baseline-b");
    expect(first.status).toBe("superseded");
    expect(second).toMatchObject({ eventId: "baseline-b", status: "pending", data: { state: "below_threshold" } });
    const third = reconcileMisEvent(state, state.referrals[0], "referral.research_risk.changed", unavailable(), now + 2, () => "baseline-c");
    expect(second?.status).toBe("superseded");
    expect(third).toMatchObject({ eventId: "baseline-c", status: "pending", data: { state: "unavailable" } });
  });

  it("keeps an initial unavailable research marker and observes later verified recovery", async () => {
    const record = referral();
    record.registrationSnapshot = { bed_profile: null, icd10_ref_diag_code: "I20.9", referring_mo: "A", hospital_mo: "B",
      territorial_type: "C", finance_source: "D", referral_purpose: "E" };
    record.events.push({ id: "registration-event", type: "registration_snapshot_recorded", actorId: "doctor-a", actorName: "Врач",
      source: "doctor_confirmation", occurredAt: null, recordedAt: now, reason: null, before: null, after: record.registrationSnapshot, revision: 5 });
    record.revision = 5;
    const state = database(record);
    reconcileResearchRisk(state, record, { status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }, true, now, () => "baseline", true);
    const risk: MisRiskPort = { evaluate: async () => ({ status: "available", researchOnly: true, modelVersion: "verified-v1",
      refusalProbabilityAmongMatureOutcomes: 0.8, workingThreshold: 0.4, riskBand: "at_or_above_working_threshold", limitations: ["research only"] }) };
    const service = new MisService(new TestRepository(state), { now: () => now + 1, id: () => "recovered", risk, researchEventsEnabled: true });
    const events = (await service.pull(full, 10)).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "referral.research_risk.changed", data: { state: "high", researchOnly: true } });
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) { keys.add(key); visit(child); }
    };
    const privateReferral = referral();
    privateReferral.triageSnapshot = {
      anamnesis: { chief_complaint: "Секретная жалоба", symptom: { onset: "", location: "", quality: "", severity: null, modifiers: "", associated: [] },
        past_history: [], chronic: [], allergies: [], medications: [], context: { age: null, sex: "unknown", pregnancy: "na", risk_factors: [] } },
      red_flags: [{ code: "flag", label: "Безопасная метка", evidence: "дословная приватная цитата", evidence_kind: "quote",
        emergency: true, source_message_index: 1 }], urgency: "emergency", urgency_reasons: ["приватная причина"],
      routing: [{ specialty: "Кардиология", confidence: 0.9 }], hypothesis: { text: "Приватный исходный текст", confidence: 0.5,
        disclaimer: "Это не диагноз, решает врач" }, source: "rules_only", processing_mode: "deterministic",
    };
    const safeReadiness = projectReadiness(privateReferral, now);
    expect(safeReadiness).toMatchObject({ state: "ready", redFlags: [{ code: "flag", label: "Безопасная метка", emergency: true }] });
    [events[0], { data: safeReadiness }].forEach(visit);
    for (const denied of ["transcript", "messages", "anamnesis", "triageSnapshot", "evidence", "bed_profile", "icd10_ref_diag_code",
      "referring_mo", "hospital_mo", "territorial_type", "finance_source", "referral_purpose", "inputCoverage", "weight", "weights",
      "intercept", "contribution", "contributions", "patientAccess", "capabilityHash", "sourceSessionId", "doctorId", "actorId",
      "telegramChatId", "telegram", "patientLabel", "token", "cookie", "secret", "patientReportId", "deliveryStatus",
      "patientReports", "commands"]) expect(keys.has(denied), denied).toBe(false);
  });

  it("does not call the scorer without both server opt-in and research scope, and retracts high when the gate closes", async () => {
    const record = referral();
    record.registrationSnapshot = { bed_profile: null, icd10_ref_diag_code: "I20.9", referring_mo: "A", hospital_mo: "B",
      territorial_type: "C", finance_source: "D", referral_purpose: "E" };
    record.events.push({ id: "registration-event", type: "registration_snapshot_recorded", actorId: "doctor-a", actorName: "Врач",
      source: "doctor_confirmation", occurredAt: null, recordedAt: now, reason: null, before: null, after: record.registrationSnapshot, revision: 5 });
    record.revision = 5;
    const state = database(record);
    const initial = append(state, "referral.research_risk.changed", high(), now, "high-a"); acked(initial);
    const evaluate = vi.fn(async () => ({ status: "available" as const, researchOnly: true as const, modelVersion: "verified-v1",
      refusalProbabilityAmongMatureOutcomes: 0.8, workingThreshold: 0.4, riskBand: "at_or_above_working_threshold" as const,
      limitations: ["research only"] }));
    const repository = new TestRepository(state);
    const enabled = new MisService(repository, { now: () => now + 2, id: () => "unused", risk: { evaluate }, researchEventsEnabled: true });
    expect((await enabled.pull(ordinary, 10)).events).toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
    const disabled = new MisService(repository, { now: () => now + 3, id: () => "gate-off", risk: { evaluate }, researchEventsEnabled: false });
    expect((await disabled.pull(full, 10)).events[0]).toMatchObject({ data: { state: "unavailable", reasonCode: "RESEARCH_EXPORT_DISABLED" } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("migrates v5 with empty MIS ledgers and no historical export", async () => {
    const repository = new MemoryReferralRepository();
    let serial = 0;
    const service = new ReferralService(repository, { now: () => now, id: () => `legacy-${++serial}` });
    const actor = { id: "doctor-a", displayName: "Врач", role: "doctor" as const, organizationId: "org-a" };
    const created = await service.create(actor,
      { patientLabel: "Legacy", profile: "Хирургический", idempotencyKey: "legacy-create" });
    await service.recordRegistrationSnapshot(actor, created.id, { expectedRevision: created.revision, idempotencyKey: "legacy-registration",
      attestedAtRegistration: true, features: { bed_profile: null, icd10_ref_diag_code: "I20.9", referring_mo: "A", hospital_mo: "B",
        territorial_type: "C", finance_source: "D", referral_purpose: "E" } });
    const legacy = await repository.read((state) => structuredClone(state)) as ReferralDatabase;
    legacy.schemaVersion = 5;
    delete legacy.misOutbox;
    delete legacy.misCommands;
    const migrated = validateReferralDatabase(legacy);
    expect(migrated).toMatchObject({ schemaVersion: 6, misOutbox: [], misCommands: [] });
    expect(migrated.referrals[0]).toMatchObject({ registrationSnapshot: { icd10_ref_diag_code: "I20.9" },
      events: expect.arrayContaining([expect.objectContaining({ type: "registration_snapshot_recorded" })]) });
    const evaluate = vi.fn();
    const mis = new MisService(new TestRepository(migrated), { now: () => now + 1, id: () => "never",
      risk: { evaluate }, researchEventsEnabled: true });
    expect((await mis.pull(full, 10)).events).toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("MIS snapshot integrity", () => {
  function validState() {
    const state = database();
    const event = append(state, "referral.readiness.changed", ready(), now, "event-a");
    acked(event);
    state.misCommands!.push({ integrationId: "integration-a", organizationId: "org-a", key: "ack-key-1",
      payload: JSON.stringify({ deliveryId: event.deliveryId, eventId: event.eventId }), eventId: event.eventId,
      response: JSON.stringify({ eventId: event.eventId, acked: true, ackedAt: event.ackedAt }), recordedAt: event.ackedAt! });
    return state;
  }

  it("binds hashes, sequence, delivery intervals and canonical ACK ledger", () => {
    expect(() => validateMisStorage(validState())).not.toThrow();
    for (const mutate of [
      (state: ReferralDatabase) => { state.misOutbox![0].payloadHash = "0".repeat(64); },
      (state: ReferralDatabase) => { state.misOutbox![0].sequence = 2; },
      (state: ReferralDatabase) => { state.misOutbox![0].ackedAt = state.misOutbox![0].leasedAt! - 1; },
      (state: ReferralDatabase) => { state.misOutbox![0].occurredAt = state.misOutbox![0].ackedAt! + 1; },
      (state: ReferralDatabase) => { state.misCommands![0].integrationId = "other"; },
      (state: ReferralDatabase) => { state.misCommands![0].response = JSON.stringify({ eventId: "other", acked: true, ackedAt: now + 1 }); },
      (state: ReferralDatabase) => { Object.assign(state.misOutbox![0].data, { state: "below_threshold", modelVersion: null,
        inputRevision: null, evaluatedAt: now, reasonCode: "ARTIFACT_UNAVAILABLE", researchOnly: true }); state.misOutbox![0].type = "referral.research_risk.changed";
        state.misOutbox![0].payloadHash = misPayloadHash(state.misOutbox![0].type, state.misOutbox![0].data); },
    ]) {
      const state = validState(); mutate(state);
      expect(() => validateMisStorage(state)).toThrow("Invalid MIS snapshot");
    }
    const superseded = database();
    const delivered = append(superseded, "referral.readiness.changed", ready(), now, "delivered-a");
    leased(delivered, now + 1);
    reconcileMisEvent(superseded, superseded.referrals[0], "referral.readiness.changed", notReady(), now + 2, () => "negative-b");
    delivered.occurredAt = delivered.leasedAt! + 1;
    expect(() => validateMisStorage(superseded)).toThrow("Invalid MIS snapshot");
  });

  it("binds event type to its payload family", () => {
    const state = validState();
    state.misOutbox![0].type = "referral.research_risk.changed";
    state.misOutbox![0].payloadHash = misPayloadHash(state.misOutbox![0].type, state.misOutbox![0].data);
    expect(() => validateMisStorage(state)).toThrow("Invalid MIS snapshot");
  });

  it("reopens a source-backed ACK ledger and leaves disk state unchanged after a failed transaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "demeu-mis-store-"));
    const path = join(dir, "referrals.json");
    let repository: FileReferralRepository | undefined;
    try {
      repository = new FileReferralRepository(path);
      let serial = 0;
      const actor = { id: "doctor-a", displayName: "Врач", role: "doctor" as const, organizationId: "org-a" };
      const risk: MisRiskPort = { evaluate: async () => ({ status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }) };
      const referrals = new ReferralService(repository, { now: () => now, id: () => `persist-${++serial}`, risk, researchEventsEnabled: true });
      const created = await referrals.create(actor, { patientLabel: "Persistent", profile: "Хирургический", idempotencyKey: "persist-create" });
      await referrals.recordRegistrationSnapshot(actor, created.id, { expectedRevision: created.revision, idempotencyKey: "persist-registration",
        attestedAtRegistration: true, features: { bed_profile: null, icd10_ref_diag_code: "I20.9", referring_mo: "A", hospital_mo: "B",
          territorial_type: "C", finance_source: "D", referral_purpose: "E" } });
      const mis = new MisService(repository, { now: () => now + 1, id: () => `delivery-${++serial}`, risk, researchEventsEnabled: true });
      const event = (await mis.pull(full, 1)).events[0];
      await mis.ack(full, event.eventId, { deliveryId: event.deliveryId, idempotencyKey: "persist-ack" });
      await repository.close(); repository = undefined;
      const reopened = new FileReferralRepository(path);
      repository = reopened;
      expect(await reopened.read((state) => [state.misOutbox?.[0].status, state.misCommands?.length])).toEqual(["acked", 1]);
      await expect(reopened.transaction(() => { throw new Error("simulated failure"); })).rejects.toThrow("simulated failure");
      expect(await reopened.read((state) => [state.misOutbox?.[0].status, state.misCommands?.length])).toEqual(["acked", 1]);
    } finally {
      await repository?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
