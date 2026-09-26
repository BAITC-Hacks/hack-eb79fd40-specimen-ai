import type { TriageResult } from "../types";

export interface ReferralActor {
  id: string;
  displayName: string;
  role: "owner" | "doctor" | "analyst";
  organizationId: string;
  telegramChatId?: string;
}
export type TriageSnapshot = Pick<TriageResult,
  "anamnesis" | "red_flags" | "urgency" | "urgency_reasons" | "routing" | "hypothesis" | "source" | "processing_mode">;
export interface ReferralFacts {
  profile: string;
  icd10Code?: string | null;
  specialistReferred: boolean | null;
  preparationStarted: boolean;
  destinationOrganization: string | null;
  sent: boolean | null;
  queue: boolean | null;
  scheduledDate: string | null;
  attendance: "attended" | "not_attended" | null;
  cancelled: boolean;
}
export interface ExaminationRecord {
  id: string;
  requirementId: string;
  label: string;
  resultAvailable: boolean | null;
  performedOn: string | null;
  expiresOn: string | null;
  applicability: "yes" | "no" | "unknown";
}
export interface ReferralEvent {
  id: string;
  type: "created" | "facts_changed" | "examination_recorded";
  actorId: string;
  actorName: string;
  source: "doctor_confirmation";
  occurredAt: number | null;
  recordedAt: number;
  reason: string | null;
  before: ReferralFacts | ExaminationRecord | null;
  after: ReferralFacts | ExaminationRecord;
  revision: number;
}
export interface Referral extends ReferralFacts {
  id: string;
  organizationId: string;
  doctorId: string;
  patientLabel: string;
  sourceSessionId: string | null;
  triageSnapshot: TriageSnapshot | null;
  requirementSnapshot?: RequirementCatalogue;
  createdAt: number;
  updatedAt: number;
  revision: number;
  events: ReferralEvent[];
  examinations: ExaminationRecord[];
}
export interface CreateReferralInput {
  patientLabel: string;
  profile: string;
  icd10Code?: string | null;
  destinationOrganization?: string | null;
  sourceSessionId?: string | null;
  idempotencyKey: string;
}
export interface UpdateReferralInput {
  expectedRevision: number;
  idempotencyKey: string;
  patch: Partial<ReferralFacts>;
  reason?: string | null;
  occurredAt?: number | null;
}
export interface RecordExaminationInput {
  expectedRevision: number;
  idempotencyKey: string;
  record: Omit<ExaminationRecord, "id"> & { id?: string };
  reason?: string | null;
  occurredAt?: number | null;
}
// Только серверный адаптер получает этот объект из проверенной completed-сессии.
export interface ReferralSourceSession {
  sessionId: string;
  doctorToken: string;
  result: TriageResult;
}
export interface ExaminationRequirement {
  id: string;
  label: string;
  required: boolean | null;
  conditional: boolean;
  validForDays: number | null;
}
export interface RequirementCatalogue {
  schemaVersion: 1;
  version: string;
  status: "available" | "unavailable";
  source: string | null;
  scope?: {
    population: "adult";
    careSetting: "inpatient";
    treatment: "operative";
  } | null;
  validated: boolean;
  profiles: { profile: string; requirements: ExaminationRequirement[] }[];
}
export type ExaminationStatus = "present" | "missing" | "expired" | "unknown" | "not_applicable";
export interface Completeness {
  status: "complete" | "incomplete" | "expired" | "unknown";
  evaluatedOn: string;
  basis: "scheduled_date" | "today";
  catalogueVersion: string;
  catalogueAvailable: boolean;
  catalogueValidated?: boolean;
  catalogueStatus?: "available" | "unavailable";
  entries: { requirementId: string; label: string; required: boolean | null; status: ExaminationStatus; expiresOn: string | null }[];
}
/**
 * Seven product phases are represented by eight values because the seventh
 * (arrival outcome) has two independently filterable outcomes.
 */
export const REFERRAL_JOURNEY_FLOWS = [
  "interviewed",
  "specialist_referred",
  "preparing",
  "sent",
  "waiting",
  "scheduled",
  "attended",
  "not_attended",
] as const;
export type ReferralJourneyFlow = typeof REFERRAL_JOURNEY_FLOWS[number];
export interface ReferralTransition {
  from: ReferralJourneyFlow | null;
  to: ReferralJourneyFlow;
  enteredAt: number;
  recordedAt: number;
  revision: number;
}
export interface ReferralEventDetail extends ReferralEvent {
  /** Derived from the immutable v2 event journal; never serialized. */
  transition?: ReferralTransition | null;
}
// ready/cancelled are retained in the public union for older serialized/UI
// consumers. New service records use only REFERRAL_JOURNEY_FLOWS: package
// readiness is completeness, while cancellation remains an independent fact.
export type ReferralFlow = "interviewed" | "specialist_referred" | "preparing" | "ready" | "sent" | "waiting" | "scheduled" | "attended" | "not_attended" | "cancelled";
export interface ReferralIntakeSummary {
  sessionId: string;
  createdAt: number;
  status: "collecting" | "completed" | "aborted";
  deliveryStatus: "pending" | "sent" | "failed";
}
export interface ReferralDetail extends Referral {
  events: ReferralEventDetail[];
  completeness: Completeness;
  flow: ReferralFlow;
  observedStageDays: number | null;
  intake?: ReferralIntakeSummary | null;
}
export interface ReferralListFilters {
  state?: ReferralJourneyFlow;
  profile?: string;
}
export interface PatientMemo {
  patientLabel: string;
  scheduledDate: string | null;
  destinationOrganization: string | null;
  catalogueAvailable: boolean;
  items: { label: string; status: ExaminationStatus; expiresOn: string | null }[];
}
export interface ReferralAggregates {
  suppressed: boolean;
  total: number | null;
  groups: { flow: ReferralFlow; count: number; meanObservedDays: number | null; observedTimeCount: number | null }[];
  scope: "organization" | "own";
  dataSource: "doctor_confirmed_local_records";
  forecast: null;
  perProfile: {
    profile: string;
    count: number;
    waitingCount: number;
    meanObservedWaitingDays: number | null;
    observedWaitingTimeCount: number;
  }[];
  period: { from: string; to: string };
  timeline: { date: string; createdCount: number; totalCount: number; waitingCount: number }[];
  timelineSource: "observed_snapshot";
  timelineUnavailableReason: "not_available_for_analyst" | null;
}
export interface ReferralDatabase {
  schemaVersion: 2;
  referrals: Referral[];
  links: { token: string; owner: ReferralActor }[];
  commands: { actorId: string; organizationId: string; key: string; payload: string; referralId: string }[];
}
export interface ReferralRepository {
  read<R>(fn: (state: Readonly<ReferralDatabase>) => R): Promise<R>;
  transaction<R>(fn: (draft: ReferralDatabase) => R | Promise<R>): Promise<R>;
}
