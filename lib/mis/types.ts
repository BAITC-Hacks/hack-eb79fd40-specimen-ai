import type { ReferralRepository, RegistrationFeatures } from "../referrals/types";

export const MIS_PULL_SCOPE = "events:pull" as const;
export const MIS_ACK_SCOPE = "events:ack" as const;
export const MIS_RESEARCH_SCOPE = "events:research" as const;
export type MisScope = typeof MIS_PULL_SCOPE | typeof MIS_ACK_SCOPE | typeof MIS_RESEARCH_SCOPE;

export interface MisPrincipal {
  integrationId: string;
  credentialId: string;
  organizationId: string;
  scopes: readonly MisScope[];
}

export interface MisReadyRequirement {
  requirementId: string;
  label: string;
  required: boolean | null;
  status: "present" | "missing" | "expired" | "unknown" | "not_applicable";
  expiresOn: string | null;
}

export type MisReadinessData =
  | {
      state: "ready";
      hypothesis: string;
      icd10Code: string;
      profile: string;
      careContext: "operative" | "conservative";
      destinationOrganization: string;
      urgency: "routine" | "planned" | "urgent" | "emergency" | null;
      redFlags: { code: string; label: string; emergency: boolean }[];
      catalogue: { version: string; validated: true };
      evaluatedOn: string;
      validUntil: string | null;
      requirements: MisReadyRequirement[];
    }
  | {
      state: "not_ready";
      reasonCodes: string[];
      evaluatedOn: string;
    };

export type MisResearchRiskData =
  | {
      state: "high";
      researchOnly: true;
      modelVersion: string;
      inputRevision: number;
      refusalProbabilityAmongMatureOutcomes: number;
      workingThreshold: number;
      riskBand: "at_or_above_working_threshold";
      evaluatedAt: number;
      limitations: string[];
    }
  | {
      state: "below_threshold";
      researchOnly: true;
      modelVersion: string;
      inputRevision: number;
      evaluatedAt: number;
      reasonCode: "BELOW_WORKING_THRESHOLD";
    }
  | {
      state: "unavailable";
      researchOnly: true;
      modelVersion: null;
      inputRevision: number | null;
      evaluatedAt: number;
      reasonCode: "RESEARCH_EXPORT_DISABLED" | "REGISTRATION_SNAPSHOT_MISSING" | "INPUTS_INCOMPLETE" | "ARTIFACT_UNAVAILABLE" | "ARTIFACT_INVALID";
    };

export type MisEventData = MisReadinessData | MisResearchRiskData;
export type MisEventType = "referral.readiness.changed" | "referral.research_risk.changed";

export interface MisOutboxEvent {
  eventId: string;
  organizationId: string;
  referralId: string;
  referralRevision: number;
  sequence: number;
  type: MisEventType;
  schemaVersion: 1;
  occurredAt: number;
  payloadHash: string;
  data: MisEventData;
  status: "pending" | "leased" | "acked" | "superseded";
  deliveryAttempt: number;
  deliveryId: string | null;
  leasedByIntegrationId: string | null;
  leasedAt: number | null;
  leaseUntil: number | null;
  ackedAt: number | null;
  ackedDeliveryId: string | null;
  ackedByIntegrationId: string | null;
  supersededAt: number | null;
}

export interface MisCommand {
  integrationId: string;
  organizationId: string;
  key: string;
  payload: string;
  eventId: string;
  response: string;
  recordedAt: number;
}

export interface MisRiskAvailable {
  status: "available";
  researchOnly: true;
  modelVersion: string;
  refusalProbabilityAmongMatureOutcomes: number;
  workingThreshold: number;
  riskBand: "below_working_threshold" | "at_or_above_working_threshold";
  limitations: string[];
}
export interface MisRiskUnavailable {
  status: "unavailable";
  researchOnly: true;
  reason: "INPUTS_INCOMPLETE" | "ARTIFACT_UNAVAILABLE" | "ARTIFACT_INVALID";
}
export type MisRiskEvaluation = MisRiskAvailable | MisRiskUnavailable;

export interface MisRiskPort {
  evaluate(features: Readonly<RegistrationFeatures>): Promise<MisRiskEvaluation>;
}

export interface MisRuntime {
  repository: ReferralRepository;
  risk: MisRiskPort;
  researchEventsEnabled: boolean;
}

export interface MisDeliveryEnvelope {
  eventId: string;
  sequence: number;
  deliveryId: string;
  deliveryAttempt: number;
  type: MisEventType;
  schemaVersion: 1;
  occurredAt: number;
  subject: { referralId: string; revision: number };
  data: MisEventData;
}
