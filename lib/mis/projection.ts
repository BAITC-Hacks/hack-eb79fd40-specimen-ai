import { createHash } from "node:crypto";
import { evaluateCompleteness, localDate } from "../referrals/requirements";
import type { Referral, ReferralDatabase, RequirementCatalogue } from "../referrals/types";
import type {
  MisEventData, MisEventType, MisOutboxEvent, MisReadinessData, MisResearchRiskData, MisRiskEvaluation,
} from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function misPayloadHash(type: MisEventType, data: MisEventData): string {
  return createHash("sha256").update(canonical({ type, data })).digest("hex");
}

function semanticHash(type: MisEventType, data: MisEventData): string {
  if (type === "referral.research_risk.changed") {
    const stable = { ...(data as MisResearchRiskData), evaluatedAt: undefined };
    return createHash("sha256").update(canonical({ type, data: stable })).digest("hex");
  }
  if ((data as MisReadinessData).state === "not_ready") {
    const stable = { ...(data as Extract<MisReadinessData, { state: "not_ready" }>), evaluatedOn: undefined };
    return createHash("sha256").update(canonical({ type, data: stable })).digest("hex");
  }
  return misPayloadHash(type, data);
}

function currentPackage(referral: Referral, catalogue: RequirementCatalogue) {
  const profile = catalogue.profiles.find((entry) => entry.profile === referral.profile);
  const ids = new Set((profile?.requirements ?? []).map((entry) => entry.id));
  return {
    profile: referral.profile,
    scheduledDate: referral.scheduledDate,
    examinations: referral.examinations.filter((entry) => entry.requirementSnapshotId === referral.requirementSnapshotId
      && ids.has(entry.requirementId)),
  };
}

export function projectReadiness(referral: Referral, now: number): MisReadinessData {
  const reasons: string[] = [];
  const assessment = referral.doctorAssessment ?? null;
  const catalogue = referral.requirementSnapshot;
  if (referral.cancelled) reasons.push("REFERRAL_CANCELLED");
  if (!assessment) reasons.push("CLINICIAN_ASSESSMENT_MISSING");
  if (!assessment || assessment.careContext === "unknown") reasons.push("CARE_CONTEXT_REQUIRED");
  if (assessment && (assessment.profile !== referral.profile || assessment.icd10Code !== (referral.icd10Code ?? null))) {
    reasons.push("ASSESSMENT_NOT_CURRENT");
  }
  if (!assessment?.hypothesis?.trim()) reasons.push("PRELIMINARY_HYPOTHESIS_MISSING");
  if (!referral.icd10Code) reasons.push("ICD10_CODE_MISSING");
  if (!referral.destinationOrganization) reasons.push("DESTINATION_MISSING");
  if (referral.specialistReferred !== true) reasons.push("SPECIALIST_REFERRAL_UNCONFIRMED");
  if (!referral.scheduledDate) reasons.push("SCHEDULE_MISSING");
  else if (referral.scheduledDate < localDate(now)) reasons.push("SCHEDULE_IN_PAST");
  if (!catalogue || catalogue.status !== "available") reasons.push("REQUIREMENT_SNAPSHOT_UNAVAILABLE");
  if (!catalogue?.validated) reasons.push("CATALOGUE_UNVALIDATED");
  if (!referral.requirementSnapshotId) reasons.push("PACKAGE_IDENTITY_MISSING");
  if (assessment && assessment.careContext !== "unknown" && (catalogue?.scope?.treatment !== assessment.careContext
    || catalogue.profiles.length !== 1 || catalogue.profiles[0]?.profile !== referral.profile)) reasons.push("PACKAGE_NOT_CURRENT");

  const completeness = catalogue
    ? evaluateCompleteness(currentPackage(referral, catalogue), catalogue, now)
    : null;
  if (completeness?.status !== "complete") reasons.push(`PACKAGE_${(completeness?.status ?? "unknown").toUpperCase()}`);
  if (reasons.length > 0 || !assessment || !catalogue || !completeness || !referral.icd10Code
    || !referral.destinationOrganization || !referral.scheduledDate) {
    return { state: "not_ready", reasonCodes: [...new Set(reasons)].sort(), evaluatedOn: localDate(now) };
  }

  const requirements = completeness.entries.map((entry) => ({
    requirementId: entry.requirementId,
    label: entry.label,
    required: entry.required,
    status: entry.status,
    expiresOn: entry.expiresOn,
  }));
  const dated = requirements.filter((entry) => entry.status === "present").map((entry) => entry.expiresOn)
    .filter((value): value is string => value !== null).sort();
  return {
    state: "ready",
    hypothesis: assessment.hypothesis!,
    icd10Code: referral.icd10Code,
    profile: referral.profile,
    careContext: assessment.careContext as "operative" | "conservative",
    destinationOrganization: referral.destinationOrganization,
    urgency: referral.triageSnapshot?.urgency ?? null,
    redFlags: (referral.triageSnapshot?.red_flags ?? []).map(({ code, label, emergency }) => ({ code, label, emergency })),
    catalogue: { version: catalogue.version, validated: true },
    evaluatedOn: completeness.evaluatedOn,
    validUntil: dated[0] ?? null,
    requirements,
  };
}

export function projectResearchRisk(
  referral: Referral,
  evaluation: MisRiskEvaluation | null,
  enabled: boolean,
  now: number,
): MisResearchRiskData {
  const inputRevision = referral.events.find((event) => event.type === "registration_snapshot_recorded")?.revision ?? null;
  if (!enabled) return { state: "unavailable", researchOnly: true, modelVersion: null, inputRevision,
    evaluatedAt: now, reasonCode: "RESEARCH_EXPORT_DISABLED" };
  if (!referral.registrationSnapshot || inputRevision === null) return { state: "unavailable", researchOnly: true,
    modelVersion: null, inputRevision, evaluatedAt: now, reasonCode: "REGISTRATION_SNAPSHOT_MISSING" };
  if (!evaluation || evaluation.status === "unavailable") return { state: "unavailable", researchOnly: true,
    modelVersion: null, inputRevision, evaluatedAt: now, reasonCode: evaluation?.reason ?? "ARTIFACT_UNAVAILABLE" };
  if (evaluation.riskBand !== "at_or_above_working_threshold") return { state: "below_threshold", researchOnly: true,
    modelVersion: evaluation.modelVersion, inputRevision, evaluatedAt: now, reasonCode: "BELOW_WORKING_THRESHOLD" };
  return {
    state: "high",
    researchOnly: true,
    modelVersion: evaluation.modelVersion,
    inputRevision,
    refusalProbabilityAmongMatureOutcomes: evaluation.refusalProbabilityAmongMatureOutcomes,
    workingThreshold: evaluation.workingThreshold,
    riskBand: "at_or_above_working_threshold",
    evaluatedAt: now,
    limitations: [...evaluation.limitations],
  };
}

function positive(type: MisEventType, data: MisEventData): boolean {
  return type === "referral.readiness.changed"
    ? (data as MisReadinessData).state === "ready"
    : (data as MisResearchRiskData).state === "high";
}

export function reconcileMisEvent(
  state: ReferralDatabase,
  referral: Referral,
  type: MisEventType,
  data: MisEventData,
  now: number,
  id: () => string,
  retainInitialNegative = false,
): MisOutboxEvent | null {
  const outbox = (state.misOutbox ??= []);
  const history = [...outbox].reverse().filter((entry) => entry.referralId === referral.id && entry.type === type);
  const payloadHash = misPayloadHash(type, data);
  const transitionHash = semanticHash(type, data);
  for (const entry of history) {
    if (entry.status === "leased" && entry.leaseUntil !== null && entry.leaseUntil <= now
      && semanticHash(type, entry.data) !== transitionHash) {
      entry.status = "superseded";
      entry.supersededAt = now;
    }
  }
  const prior = history.find((entry) => entry.status !== "superseded");
  const escapedDifferentAfterPrior = prior ? history.some((entry) => entry.sequence > prior.sequence
    && semanticHash(type, entry.data) !== transitionHash
    && (entry.status === "leased" || entry.status === "acked" || entry.status === "superseded" && entry.deliveryAttempt > 0)) : false;
  if (prior && semanticHash(type, prior.data) === transitionHash
    && (prior.status === "pending" || prior.status === "leased" || !escapedDifferentAfterPrior)) return null;

  if (prior?.status === "pending") {
    prior.status = "superseded";
    prior.supersededAt = now;
    prior.deliveryId = null;
    prior.leasedByIntegrationId = null;
    prior.leasedAt = null;
    prior.leaseUntil = null;
  }
  if (!positive(type, data) && !retainInitialNegative && history.length === 0) return null;

  const event: MisOutboxEvent = {
    eventId: id(),
    organizationId: referral.organizationId,
    referralId: referral.id,
    referralRevision: referral.revision,
    sequence: outbox.filter((entry) => entry.referralId === referral.id).reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1,
    type,
    schemaVersion: 1,
    occurredAt: now,
    payloadHash,
    data: structuredClone(data),
    status: "pending",
    deliveryAttempt: 0,
    deliveryId: null,
    leasedByIntegrationId: null,
    leasedAt: null,
    leaseUntil: null,
    ackedAt: null,
    ackedDeliveryId: null,
    ackedByIntegrationId: null,
    supersededAt: null,
  };
  outbox.push(event);
  return event;
}

export function reconcileReadiness(state: ReferralDatabase, referral: Referral, now: number, id: () => string): MisOutboxEvent | null {
  return reconcileMisEvent(state, referral, "referral.readiness.changed", projectReadiness(referral, now), now, id);
}

export function reconcileResearchRisk(
  state: ReferralDatabase,
  referral: Referral,
  evaluation: MisRiskEvaluation | null,
  enabled: boolean,
  now: number,
  id: () => string,
  retainInitialNegative = false,
): MisOutboxEvent | null {
  return reconcileMisEvent(state, referral, "referral.research_risk.changed",
    projectResearchRisk(referral, evaluation, enabled, now), now, id, retainInitialNegative);
}
