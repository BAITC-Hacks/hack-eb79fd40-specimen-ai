import type { TriageResult } from "../types";

export interface ReferralActor {
  id: string;
  displayName: string;
  role: "owner" | "doctor" | "analyst";
  organizationId: string;
  telegramChatId?: string;
}
export type TriageSnapshot = Pick<TriageResult,
  "anamnesis" | "red_flags" | "urgency" | "urgency_reasons" | "routing" | "hypothesis" | "source">;
export interface ReferralFacts {
  profile: string;
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
  createdAt: number;
  updatedAt: number;
  revision: number;
  events: ReferralEvent[];
  examinations: ExaminationRecord[];
}
export interface CreateReferralInput {
  patientLabel: string;
  profile: string;
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
  entries: { requirementId: string; label: string; required: boolean | null; status: ExaminationStatus; expiresOn: string | null }[];
}
export type ReferralFlow = "interviewed" | "specialist_referred" | "preparing" | "ready" | "sent" | "waiting" | "scheduled" | "attended" | "not_attended" | "cancelled";
export interface ReferralDetail extends Referral {
  completeness: Completeness;
  flow: ReferralFlow;
  observedStageDays: number | null;
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
  groups: { flow: ReferralFlow; count: number; meanObservedDays: number | null; observedTimeCount: number }[];
  scope: "organization" | "own";
  dataSource: "doctor_confirmed_local_records";
  forecast: null;
  perProfile: { profile: string; count: number }[];
  period: { from: string; to: string };
  timeline: { date: string; createdCount: number; totalCount: number; waitingCount: number }[];
  timelineSource: "observed_snapshot";
  timelineUnavailableReason: "not_available_for_analyst" | null;
}
export interface ReferralDatabase {
  schemaVersion: 1;
  referrals: Referral[];
  links: { token: string; owner: ReferralActor }[];
  commands: { actorId: string; organizationId: string; key: string; payload: string; referralId: string }[];
}
export interface ReferralRepository {
  read<R>(fn: (state: Readonly<ReferralDatabase>) => R): Promise<R>;
  transaction<R>(fn: (draft: ReferralDatabase) => R | Promise<R>): Promise<R>;
}
