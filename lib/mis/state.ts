import type { ReferralDatabase } from "../referrals/types";
import { misPayloadHash } from "./projection";
import type { MisCommand, MisEventData, MisOutboxEvent } from "./types";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const text = (value: unknown, max = 10000): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

function validReadinessData(value: Record<string, unknown>): boolean {
  if (value.state === "not_ready") return keys(value, ["state", "reasonCodes", "evaluatedOn"])
    && Array.isArray(value.reasonCodes) && value.reasonCodes.length > 0 && value.reasonCodes.every((entry) => text(entry, 100))
    && /^\d{4}-\d{2}-\d{2}$/u.test(String(value.evaluatedOn));
  if (value.state !== "ready" || !keys(value, ["state", "hypothesis", "icd10Code", "profile", "careContext",
    "destinationOrganization", "urgency", "redFlags", "catalogue", "evaluatedOn", "validUntil", "requirements"])) return false;
  if (!text(value.hypothesis, 4000) || !text(value.icd10Code, 32) || !text(value.profile, 200)
    || !["operative", "conservative"].includes(String(value.careContext)) || !text(value.destinationOrganization, 500)
    || ![null, "routine", "planned", "urgent", "emergency"].includes(value.urgency as null | string)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(String(value.evaluatedOn))
    || !(value.validUntil === null || /^\d{4}-\d{2}-\d{2}$/u.test(String(value.validUntil)))) return false;
  if (!object(value.catalogue) || !keys(value.catalogue, ["version", "validated"])
    || !text(value.catalogue.version, 200) || value.catalogue.validated !== true) return false;
  if (!Array.isArray(value.redFlags) || !value.redFlags.every((entry) => object(entry)
    && keys(entry, ["code", "label", "emergency"]) && text(entry.code, 200) && text(entry.label, 1000) && typeof entry.emergency === "boolean")) return false;
  return Array.isArray(value.requirements) && value.requirements.every((entry) => object(entry)
    && keys(entry, ["requirementId", "label", "required", "status", "expiresOn"])
    && text(entry.requirementId, 200) && text(entry.label, 1000) && (entry.required === null || typeof entry.required === "boolean")
    && ["present", "missing", "expired", "unknown", "not_applicable"].includes(String(entry.status))
    && (entry.expiresOn === null || /^\d{4}-\d{2}-\d{2}$/u.test(String(entry.expiresOn))));
}

function validRiskData(value: Record<string, unknown>): boolean {
  if (value.state === "high") return keys(value, ["state", "researchOnly", "modelVersion", "inputRevision",
    "refusalProbabilityAmongMatureOutcomes", "workingThreshold", "riskBand", "evaluatedAt", "limitations"])
    && value.researchOnly === true && text(value.modelVersion, 200) && Number.isSafeInteger(value.inputRevision) && Number(value.inputRevision) >= 1
    && probability(value.refusalProbabilityAmongMatureOutcomes) && probability(value.workingThreshold)
    && Number(value.refusalProbabilityAmongMatureOutcomes) >= Number(value.workingThreshold)
    && value.riskBand === "at_or_above_working_threshold" && timestamp(value.evaluatedAt)
    && Array.isArray(value.limitations) && value.limitations.length > 0 && value.limitations.every((entry) => text(entry, 1000));
  if (!keys(value, ["state", "researchOnly", "modelVersion", "inputRevision", "evaluatedAt", "reasonCode"])
    || value.researchOnly !== true || !timestamp(value.evaluatedAt)) return false;
  if (value.state === "below_threshold") return text(value.modelVersion, 200)
    && Number.isSafeInteger(value.inputRevision) && Number(value.inputRevision) >= 1
    && value.reasonCode === "BELOW_WORKING_THRESHOLD";
  return value.state === "unavailable" && value.modelVersion === null
    && (value.inputRevision === null || Number.isSafeInteger(value.inputRevision) && Number(value.inputRevision) >= 1)
    && ["RESEARCH_EXPORT_DISABLED", "REGISTRATION_SNAPSHOT_MISSING", "INPUTS_INCOMPLETE", "ARTIFACT_UNAVAILABLE", "ARTIFACT_INVALID"]
      .includes(String(value.reasonCode));
}

function validData(type: unknown, value: unknown): value is MisEventData {
  if (!object(value)) return false;
  return type === "referral.readiness.changed" ? validReadinessData(value)
    : type === "referral.research_risk.changed" && validRiskData(value);
}

function validDelivery(entry: Record<string, unknown>): boolean {
  const clearLease = entry.deliveryId === null && entry.leasedByIntegrationId === null && entry.leasedAt === null && entry.leaseUntil === null;
  const clearAck = entry.ackedAt === null && entry.ackedDeliveryId === null && entry.ackedByIntegrationId === null;
  if (entry.status === "pending") return entry.deliveryAttempt === 0 && clearLease && clearAck && entry.supersededAt === null;
  if (entry.status === "superseded") return timestamp(entry.supersededAt) && Number(entry.supersededAt) >= Number(entry.occurredAt) && clearAck && (entry.deliveryAttempt === 0 && clearLease
    || Number.isSafeInteger(entry.deliveryAttempt) && Number(entry.deliveryAttempt) >= 1 && text(entry.deliveryId, 200)
      && text(entry.leasedByIntegrationId, 200) && timestamp(entry.leasedAt) && timestamp(entry.leaseUntil)
      && Number(entry.leasedAt) >= Number(entry.occurredAt) && Number(entry.leaseUntil) > Number(entry.leasedAt)
      && Number(entry.leaseUntil) <= Number(entry.supersededAt));
  const leased = Number.isSafeInteger(entry.deliveryAttempt) && Number(entry.deliveryAttempt) >= 1 && text(entry.deliveryId, 200)
    && text(entry.leasedByIntegrationId, 200) && timestamp(entry.leasedAt) && timestamp(entry.leaseUntil)
    && Number(entry.leasedAt) >= Number(entry.occurredAt) && Number(entry.leaseUntil) > Number(entry.leasedAt);
  if (!leased) return false;
  if (entry.status === "leased") return clearAck && entry.supersededAt === null;
  return entry.status === "acked" && timestamp(entry.ackedAt) && Number(entry.ackedAt) >= Number(entry.leasedAt)
    && Number(entry.ackedAt) < Number(entry.leaseUntil) && entry.ackedDeliveryId === entry.deliveryId
    && text(entry.ackedByIntegrationId, 200) && entry.supersededAt === null;
}

export function validateMisStorage(state: ReferralDatabase): { outbox: MisOutboxEvent[]; commands: MisCommand[] } {
  if (!Array.isArray(state.misOutbox) || !Array.isArray(state.misCommands)) throw new Error("Invalid MIS snapshot");
  const ids = new Set<string>();
  const sequences = new Map<string, number>();
  for (const raw of state.misOutbox) {
    const entry = raw as unknown as Record<string, unknown>;
    if (!object(entry) || !keys(entry, ["eventId", "organizationId", "referralId", "referralRevision", "sequence", "type",
      "schemaVersion", "occurredAt", "payloadHash", "data", "status", "deliveryAttempt", "deliveryId",
      "leasedByIntegrationId", "leasedAt", "leaseUntil", "ackedAt", "ackedDeliveryId", "ackedByIntegrationId", "supersededAt"])
      || !text(entry.eventId, 200) || ids.has(String(entry.eventId)) || !text(entry.organizationId, 200) || !text(entry.referralId, 200)
      || !Number.isSafeInteger(entry.referralRevision) || Number(entry.referralRevision) < 1 || !Number.isSafeInteger(entry.sequence)
      || Number(entry.sequence) !== (sequences.get(String(entry.referralId)) ?? 0) + 1
      || !["referral.readiness.changed", "referral.research_risk.changed"].includes(String(entry.type))
      || entry.schemaVersion !== 1 || !timestamp(entry.occurredAt) || !/^[a-f0-9]{64}$/u.test(String(entry.payloadHash))
      || !validData(entry.type, entry.data) || !validDelivery(entry)) throw new Error("Invalid MIS snapshot");
    const referral = state.referrals.find((candidate) => candidate.id === entry.referralId);
    if (!referral || referral.organizationId !== entry.organizationId || Number(entry.referralRevision) > referral.revision
      || entry.payloadHash !== misPayloadHash(entry.type as MisOutboxEvent["type"], entry.data as MisEventData)) throw new Error("Invalid MIS snapshot");
    ids.add(String(entry.eventId));
    sequences.set(String(entry.referralId), Number(entry.sequence));
  }
  const commandKeys = new Set<string>();
  for (const raw of state.misCommands) {
    const command = raw as unknown as Record<string, unknown>;
    if (!object(command) || !keys(command, ["integrationId", "organizationId", "key", "payload", "eventId", "response", "recordedAt"])
      || !text(command.integrationId, 200) || !text(command.organizationId, 200) || !text(command.key, 128)
      || !text(command.payload, 10000) || !text(command.eventId, 200) || !text(command.response, 10000) || !timestamp(command.recordedAt)) throw new Error("Invalid MIS snapshot");
    const key = `${command.organizationId}\0${command.integrationId}\0${command.key}`;
    const event = state.misOutbox.find((candidate) => candidate.eventId === command.eventId);
    if (commandKeys.has(key) || !event || event.organizationId !== command.organizationId || event.status !== "acked"
      || event.ackedByIntegrationId !== command.integrationId || event.ackedDeliveryId === null || event.ackedAt === null
      || command.payload !== canonical({ eventId: event.eventId, deliveryId: event.ackedDeliveryId })
      || Number(command.recordedAt) < event.ackedAt) throw new Error("Invalid MIS snapshot");
    try {
      const response: unknown = JSON.parse(String(command.response));
      if (!object(response) || !keys(response, ["eventId", "acked", "ackedAt"]) || response.eventId !== event.eventId
        || response.acked !== true || response.ackedAt !== event.ackedAt) throw new Error("Invalid MIS snapshot");
    } catch { throw new Error("Invalid MIS snapshot"); }
    commandKeys.add(key);
  }
  return { outbox: structuredClone(state.misOutbox), commands: structuredClone(state.misCommands) };
}
