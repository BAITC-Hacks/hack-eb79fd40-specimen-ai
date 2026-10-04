import { randomUUID } from "node:crypto";
import conservativeCatalogueData from "../../data/examination_requirements_conservative.json";
import { FileState } from "../storage/file-state";
import { hasMandatoryDisclaimer } from "../http";
import { DEFAULT_REQUIREMENTS, evaluateCompleteness, isCalendarDate, localDate, validateRequirementCatalogue } from "./requirements";
import { canonicalProfile, isSelectableProfile, normalizeIcd10Code, profileDisplayName, validIcd10Code } from "./profiles";
import type {
  CreateReferralInput, DoctorAssessment, DoctorAssessmentEventState, ExaminationRecord, PatientMemo, RecordDoctorAssessmentInput, RecordExaminationInput, Referral,
  ReferralActor, ReferralAggregates, ReferralDatabase, ReferralDetail, ReferralEvent,
  ReferralFacts, ReferralFlow, ReferralJourneyFlow, ReferralListFilters, ReferralRepository,
  ReferralSourceSession, ReferralTransition, RequirementCatalogue,
  RegistrationFeatures, RecordRegistrationSnapshotInput, UpdateReferralInput,
} from "./types";
import { REFERRAL_JOURNEY_FLOWS } from "./types";
import { activePatientAccess, latestPatientReports, newPatientAccess, packageProjection, preparationHash, preparationCookieName, sourceLinkHash, validPreparationToken, PREPARATION_TTL_MS } from "./patient";
import type { PatientReportInput } from "./types";
import { validateMisStorage } from "../mis/state";
import { reconcileReadiness, reconcileResearchRisk } from "../mis/projection";
import type { MisRiskEvaluation, MisRiskPort } from "../mis/types";

const UNKNOWN_CREATION_REQUIREMENTS: RequirementCatalogue = {
  schemaVersion: 1,
  version: "unknown-at-creation",
  status: "unavailable",
  source: null,
  scope: null,
  validated: false,
  profiles: [],
};
const DEFAULT_CONSERVATIVE_REQUIREMENTS = validateRequirementCatalogue(conservativeCatalogueData);

const REFERRAL_ERROR_BRAND = Symbol.for("demeu.ReferralError");
const ANALYST_RELEASE_MIN_CHANGED_REFERRALS = 5;
export const REFERRAL_DATABASE_SCHEMA_VERSION = 6 as const;
export class ReferralError extends Error {
  readonly [REFERRAL_ERROR_BRAND] = true;
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ReferralError";
  }
}
export function isReferralError(value: unknown): value is ReferralError {
  if (typeof value !== "object" || value === null) return false;
  const error = value as Record<PropertyKey, unknown>;
  return error[REFERRAL_ERROR_BRAND] === true && Number.isInteger(error.status)
    && Number(error.status) >= 400 && Number(error.status) <= 599
    && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code);
}
export { ReferralError as DomainError };
const fail = (code = "BAD_REQUEST", message = "Некорректные данные", status = 400): never => { throw new ReferralError(status, code, message); };
const clone = <T>(value: T): T => structuredClone(value);
const initial = (): ReferralDatabase => ({ schemaVersion: REFERRAL_DATABASE_SCHEMA_VERSION, referrals: [], links: [], commands: [], patientAccess: [], patientReports: [], misOutbox: [], misCommands: [] });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const boolOrNull = (value: unknown): boolean => value === null || typeof value === "boolean";
const dateOrNull = (value: unknown): boolean => value === null || isCalendarDate(value);
const keysOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const stringArray = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const probability = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const FACT_KEYS = ["profile", "icd10Code", "specialistReferred", "preparationStarted", "destinationOrganization", "sent", "queue", "scheduledDate", "attendance", "cancelled"] as const;

function validDoctorAssessment(value: unknown): value is DoctorAssessment {
  return object(value) && keysOnly(value, ["hypothesis", "profile", "icd10Code", "careContext", "authorId", "authorName", "recordedAt", "revision"])
    && (value.hypothesis === null || text(value.hypothesis, 4000)) && text(value.profile) && isSelectableProfile(value.profile) && validIcd10Code(value.icd10Code)
    && ["operative", "conservative", "unknown"].includes(String(value.careContext))
    && text(value.authorId) && text(value.authorName) && timestamp(value.recordedAt)
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1;
}
function validAssessmentState(value: unknown): value is DoctorAssessmentEventState {
  if (!object(value) || !keysOnly(value, ["assessment", "requirementSnapshot", "requirementSnapshotId"])
    || !(value.assessment === null || validDoctorAssessment(value.assessment))
    || !(value.requirementSnapshotId === null || text(value.requirementSnapshotId))) return false;
  if (value.requirementSnapshot === null) return value.requirementSnapshotId === null;
  try { validateRequirementCatalogue(value.requirementSnapshot); } catch { return false; }
  return value.requirementSnapshotId !== null;
}

function validActor(value: unknown): value is ReferralActor {
  return object(value) && keysOnly(value, ["id", "displayName", "role", "organizationId", "telegramChatId"])
    && text(value.id) && text(value.displayName) && text(value.organizationId)
    && ["owner", "doctor", "analyst"].includes(String(value.role))
    && (value.telegramChatId === undefined || text(value.telegramChatId));
}
function validFacts(value: unknown): value is ReferralFacts {
  return object(value) && text(value.profile) && validIcd10Code(value.icd10Code) && (value.destinationOrganization === null || text(value.destinationOrganization))
    && boolOrNull(value.specialistReferred) && typeof value.preparationStarted === "boolean"
    && boolOrNull(value.sent) && boolOrNull(value.queue) && dateOrNull(value.scheduledDate)
    && [null, "attended", "not_attended"].includes(value.attendance as null | string) && typeof value.cancelled === "boolean";
}
function validExamination(value: unknown): value is ExaminationRecord {
  return object(value) && keysOnly(value, ["id", "requirementSnapshotId", "requirementId", "label", "resultAvailable", "performedOn", "expiresOn", "applicability", "patientReportId"])
    && text(value.id) && text(value.requirementId) && text(value.label)
    && (value.requirementSnapshotId === undefined || text(value.requirementSnapshotId))
    && boolOrNull(value.resultAvailable) && dateOrNull(value.performedOn) && dateOrNull(value.expiresOn)
    && ["yes", "no", "unknown"].includes(String(value.applicability)) && (value.patientReportId === undefined || text(value.patientReportId))
    && !(typeof value.performedOn === "string" && typeof value.expiresOn === "string" && value.expiresOn < value.performedOn);
}
const REGISTRATION_FEATURE_KEYS = ["bed_profile", "icd10_ref_diag_code", "referring_mo", "hospital_mo", "territorial_type", "finance_source", "referral_purpose"] as const;
function validRegistrationFeatures(value: unknown): value is RegistrationFeatures {
  return object(value) && keysOnly(value, REGISTRATION_FEATURE_KEYS) && REGISTRATION_FEATURE_KEYS.every((key) => {
    const entry = value[key];
    if (entry === null) return key === "bed_profile";
    return typeof entry === "string" && entry !== "__MISSING__" && entry.trim().length > 0 && entry.length <= 500 && !entry.includes("\0");
  });
}
function validSnapshot(value: unknown): boolean {
  if (!object(value) || !keysOnly(value, ["anamnesis", "red_flags", "urgency", "urgency_reasons", "routing", "hypothesis", "source", "processing_mode"])) return false;
  const a = value.anamnesis;
  if (!object(a) || !keysOnly(a, ["chief_complaint", "symptom", "past_history", "chronic", "allergies", "medications", "context", "history_status", "negative_findings"])
    || typeof a.chief_complaint !== "string" || ![a.past_history, a.chronic, a.allergies, a.medications].every(stringArray)) return false;
  if (a.negative_findings !== undefined && !stringArray(a.negative_findings)) return false;
  if (a.history_status !== undefined && (!object(a.history_status)
    || !keysOnly(a.history_status, ["past_history", "chronic", "allergies", "medications"])
    || ![a.history_status.past_history, a.history_status.chronic, a.history_status.allergies, a.history_status.medications]
      .every((entry) => ["reported", "denied", "not_stated"].includes(String(entry))))) return false;
  const symptom = a.symptom;
  const context = a.context;
  if (!object(symptom) || !keysOnly(symptom, ["onset", "location", "quality", "severity", "modifiers", "associated"])
    || ![symptom.onset, symptom.location, symptom.quality, symptom.modifiers].every((entry) => typeof entry === "string")
    || !stringArray(symptom.associated) || !(symptom.severity === null || (typeof symptom.severity === "number" && Number.isFinite(symptom.severity) && symptom.severity >= 0 && symptom.severity <= 10))) return false;
  if (!object(context) || !keysOnly(context, ["age", "sex", "pregnancy", "risk_factors"])
    || !(context.age === null || (typeof context.age === "number" && Number.isFinite(context.age) && context.age >= 0 && context.age <= 150))
    || !["m", "f", "unknown"].includes(String(context.sex)) || !["yes", "no", "na"].includes(String(context.pregnancy)) || !stringArray(context.risk_factors)) return false;
  const h = value.hypothesis;
  if (!object(h) || typeof h.disclaimer !== "string" || !hasMandatoryDisclaimer(h.disclaimer)
    || (value.source === "rules_only" && h.confidence !== 0)
    || (value.source === "llm_fallback" && (typeof h.confidence !== "number" || h.confidence > 0.5))
    || (Array.isArray(value.red_flags) && value.red_flags.some((entry) => object(entry) && entry.emergency === true) && value.urgency !== "emergency")) return false;
  return object(h) && keysOnly(h, ["text", "confidence", "disclaimer"]) && typeof h.text === "string" && probability(h.confidence) && text(h.disclaimer, 10000)
    && ["routine", "planned", "urgent", "emergency"].includes(String(value.urgency)) && stringArray(value.urgency_reasons)
    && ["model", "llm_fallback", "rules_only"].includes(String(value.source))
    && (value.processing_mode === undefined || ["external_llm", "deterministic"].includes(String(value.processing_mode)))
    && Array.isArray(value.routing) && value.routing.length <= 3 && value.routing.every((entry) => object(entry) && keysOnly(entry, ["specialty", "confidence"]) && text(entry.specialty) && probability(entry.confidence))
    && Array.isArray(value.red_flags) && value.red_flags.every((entry) => object(entry) && keysOnly(entry, ["code", "label", "evidence", "evidence_kind", "emergency", "source_message_index", "elicited_by"])
      && text(entry.code) && text(entry.label, 1000) && text(entry.evidence, 10000) && ["quote", "derived"].includes(String(entry.evidence_kind))
      && typeof entry.emergency === "boolean" && Number.isSafeInteger(entry.source_message_index)
      && (entry.evidence_kind === "derived" ? entry.source_message_index === -1 : Number(entry.source_message_index) >= 0)
      && (entry.elicited_by === undefined || typeof entry.elicited_by === "string"));
}
function facts(referral: Referral): ReferralFacts {
  return Object.fromEntries(FACT_KEYS.map((key) => [key, referral[key]])) as unknown as ReferralFacts;
}
function assessmentState(referral: Referral): DoctorAssessmentEventState {
  return {
    assessment: clone(referral.doctorAssessment ?? null),
    requirementSnapshot: clone(referral.requirementSnapshot ?? null),
    requirementSnapshotId: referral.requirementSnapshotId ?? null,
  };
}
function flowFromFacts(value: ReferralFacts): ReferralJourneyFlow {
  // Later doctor-confirmed facts may be recorded without inventing earlier
  // facts. Cancellation remains an independent fact, not a journey phase.
  // Package completeness is an independent projection: a doctor-confirmed
  // send cannot disappear merely because the catalogue is not yet validated.
  return value.attendance ?? (value.scheduledDate ? "scheduled"
    : value.queue === true ? "waiting"
      : value.sent === true ? "sent"
        : value.preparationStarted ? "preparing"
          : value.specialistReferred === true ? "specialist_referred" : "interviewed");
}
function currentPackageSubject(
  referral: Pick<Referral, "profile" | "scheduledDate" | "examinations" | "requirementSnapshotId">,
  catalogue: RequirementCatalogue,
): Pick<Referral, "profile" | "scheduledDate" | "examinations"> {
  const profile = catalogue.profiles.find((entry) => entry.profile === referral.profile);
  if (!profile) return { ...referral, examinations: [] };
  const currentIds = new Set(profile.requirements.map((entry) => entry.id));
  return { ...referral, examinations: referral.examinations.filter((entry) => entry.requirementSnapshotId === referral.requirementSnapshotId
    && currentIds.has(entry.requirementId)) };
}
function eventTransitions(referral: Referral): (ReferralTransition | null)[] {
  let previousFlow: ReferralJourneyFlow | null = null;
  let currentFacts: ReferralFacts | null = null;
  return referral.events.map((event) => {
    if (event.type === "created" || event.type === "facts_changed") currentFacts = event.after as ReferralFacts;
    if (event.type === "doctor_assessment_changed" && currentFacts) {
      const assessment = (event.after as DoctorAssessmentEventState).assessment;
      if (assessment) currentFacts = { ...currentFacts, profile: assessment.profile, icd10Code: assessment.icd10Code };
    }
    if (!currentFacts) return null;
    const eventFlow = flowFromFacts(currentFacts);
    const transition = stageTransition(previousFlow, eventFlow, event.occurredAt, event.recordedAt, event.revision);
    previousFlow = eventFlow;
    return transition;
  });
}
function currentStage(referral: Referral): { flow: ReferralJourneyFlow; enteredAt: number } {
  const transition = eventTransitions(referral).filter((value): value is ReferralTransition => Boolean(value)).at(-1);
  return transition
    ? { flow: transition.to, enteredAt: transition.enteredAt }
    : { flow: flowFromFacts(referral), enteredAt: referral.createdAt };
}
function observedStageDays(referral: Referral, now: number): number {
  return Math.max(0, now - currentStage(referral).enteredAt) / 86400000;
}
function stageTransition(from: ReferralJourneyFlow | null, to: ReferralJourneyFlow, occurredAt: number | null, recordedAt: number, revision: number): ReferralTransition | null {
  return from === to ? null : { from, to, enteredAt: occurredAt ?? recordedAt, recordedAt, revision };
}
interface AnalystContribution { flow: ReferralJourneyFlow; timeObserved: boolean; enteredAt: number }
function analystContribution(referral: Referral, at: number): AnalystContribution {
  return { flow: currentStage(referral).flow, timeObserved: Number.isFinite(observedStageDays(referral, at)), enteredAt: currentStage(referral).enteredAt };
}
function sameContribution(left: AnalystContribution | undefined, right: AnalystContribution | undefined): boolean {
  return left?.flow === right?.flow && left?.timeObserved === right?.timeObserved && left?.enteredAt === right?.enteredAt;
}
function analystReleaseIsSafe(
  released: ReadonlyMap<string, AnalystContribution>,
  candidate: ReadonlyMap<string, Referral>,
  at: number,
): boolean {
  const affectedCells = new Map<ReferralJourneyFlow, Set<string>>();
  const markAffected = (flow: ReferralJourneyFlow, id: string): void => {
    const contributors = affectedCells.get(flow) ?? new Set<string>();
    contributors.add(id);
    affectedCells.set(flow, contributors);
  };
  let membershipChanges = 0;
  const ids = new Set([...released.keys(), ...candidate.keys()]);
  for (const id of ids) {
    const before = released.get(id);
    const record = candidate.get(id);
    const after = record ? analystContribution(record, at) : undefined;
    if (sameContribution(before, after)) continue;
    if (!before || !after) membershipChanges += 1;
    if (before) markAffected(before.flow, id);
    if (after) markAffected(after.flow, id);
  }
  if (membershipChanges > 0 && membershipChanges < ANALYST_RELEASE_MIN_CHANGED_REFERRALS) return false;
  return affectedCells.size > 0
    && [...affectedCells.values()].every((contributors) => contributors.size >= ANALYST_RELEASE_MIN_CHANGED_REFERRALS);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function validateReferralDatabase(value: unknown): ReferralDatabase {
  const invalid = (): never => { throw new Error("Invalid referral snapshot"); };
  if (!object(value) || !keysOnly(value, ["schemaVersion", "referrals", "links", "commands", "patientAccess", "patientReports", "misOutbox", "misCommands"])
    || ![1, 2, 3, 4, 5, REFERRAL_DATABASE_SCHEMA_VERSION].includes(value.schemaVersion as number)
    || !Array.isArray(value.referrals) || !Array.isArray(value.links) || !Array.isArray(value.commands)) return invalid();
  const originalVersion = Number(value.schemaVersion);
  if (originalVersion >= 3 && (!Array.isArray(value.patientAccess) || !Array.isArray(value.patientReports))) return invalid();
  if (originalVersion < 3 && ((Array.isArray(value.patientAccess) && value.patientAccess.length)
    || (Array.isArray(value.patientReports) && value.patientReports.length))) return invalid();
  const normalized = clone(value) as Record<string, unknown>;
  normalized.patientAccess ??= [];
  normalized.patientReports ??= [];
  if (originalVersion >= 6 && (!Array.isArray(value.misOutbox) || !Array.isArray(value.misCommands))) return invalid();
  if (originalVersion < 6 && ((Array.isArray(value.misOutbox) && value.misOutbox.length)
    || (Array.isArray(value.misCommands) && value.misCommands.length))) return invalid();
  normalized.misOutbox ??= [];
  normalized.misCommands ??= [];
  if (originalVersion < 4) {
    normalized.patientAccess = (normalized.patientAccess as unknown[]).map((entry) => object(entry) && !("sourceLinkHash" in entry)
      ? { ...entry, sourceLinkHash: null } : entry);
    for (const report of normalized.patientReports as unknown[]) {
      if (!object(report)) return invalid();
      // Legacy reports did not identify the package epoch. Keep them in audit
      // storage under a deliberately non-active identity instead of guessing
      // that they belong to the last profile snapshot.
      report.requirementSnapshotId = `legacy-report:${String(report.referralId)}:${String(report.catalogueVersion)}:${String(report.requirementId)}`;
    }
    const legacyReports = normalized.patientReports as Record<string, unknown>[];
    for (const record of normalized.referrals as unknown[]) {
      if (!object(record)) return invalid();
      record.doctorAssessment = null;
      record.requirementSnapshotId = record.requirementSnapshot === undefined ? null : `legacy:${String(record.id)}:v${originalVersion}`;
      const examinationIdentities = new Map<string, string>();
      if (Array.isArray(record.examinations)) {
        for (const examination of record.examinations) {
          if (!object(examination)) continue;
          const report = typeof examination.patientReportId === "string"
            ? legacyReports.find((entry) => entry.id === examination.patientReportId) : undefined;
          const identity = typeof report?.requirementSnapshotId === "string" ? report.requirementSnapshotId
            : `legacy-exam:${String(record.id)}:${String(examination.id)}`;
          examination.requirementSnapshotId = identity;
          examinationIdentities.set(String(examination.id), identity);
        }
      }
      if (Array.isArray(record.events)) {
        for (const event of record.events) {
          if (!object(event) || event.type !== "examination_recorded") continue;
          for (const side of ["before", "after"] as const) {
            const examination = event[side];
            if (object(examination)) examination.requirementSnapshotId = examinationIdentities.get(String(examination.id))
              ?? `legacy-exam:${String(record.id)}:${String(examination.id)}`;
          }
        }
      }
    }
  }
  if (originalVersion < 5) {
    for (const record of normalized.referrals as unknown[]) {
      if (!object(record)) return invalid();
      record.registrationSnapshot = null;
    }
  }
  normalized.schemaVersion = REFERRAL_DATABASE_SCHEMA_VERSION;
  value = normalized;
  if (!object(value) || !keysOnly(value, ["schemaVersion", "referrals", "links", "commands", "patientAccess", "patientReports", "misOutbox", "misCommands"])
    || value.schemaVersion !== REFERRAL_DATABASE_SCHEMA_VERSION
    || !Array.isArray(value.referrals) || !Array.isArray(value.links) || !Array.isArray(value.commands)) return invalid();
  const ids = new Set<string>();
  for (const record of value.referrals) {
    if (!object(record) || !keysOnly(record, [...FACT_KEYS, "id", "organizationId", "doctorId", "patientLabel", "sourceSessionId", "triageSnapshot", "doctorAssessment", "registrationSnapshot", "requirementSnapshot", "requirementSnapshotId", "createdAt", "updatedAt", "revision", "events", "examinations"])
      || !validFacts(record) || !text(record.id) || ids.has(record.id)
      || !text(record.organizationId) || !text(record.doctorId) || !text(record.patientLabel)
      || !(record.sourceSessionId === null || text(record.sourceSessionId))
      || !timestamp(record.createdAt) || !timestamp(record.updatedAt) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1
      || !Array.isArray(record.examinations) || !record.examinations.every(validExamination) || !Array.isArray(record.events)
      || record.events.length !== record.revision) return invalid();
    if (new Set(record.examinations.map((entry) => canonical([entry.requirementSnapshotId ?? null, entry.requirementId]))).size !== record.examinations.length) return invalid();
    if (record.triageSnapshot !== null && !validSnapshot(record.triageSnapshot)) return invalid();
    if (!(record.doctorAssessment === null || validDoctorAssessment(record.doctorAssessment))
      || !(record.registrationSnapshot === null || validRegistrationFeatures(record.registrationSnapshot))
      || !(record.requirementSnapshotId === null || text(record.requirementSnapshotId))) return invalid();
    if (record.requirementSnapshot !== undefined) {
      try {
        const snapshot = validateRequirementCatalogue(record.requirementSnapshot);
        if (snapshot.profiles.length > 1 || (snapshot.profiles.length === 1 && snapshot.profiles[0].profile !== record.profile)) return invalid();
      } catch { return invalid(); }
    }
    if ((record.requirementSnapshot === undefined) !== (record.requirementSnapshotId === null)) return invalid();
    if (record.doctorAssessment !== null) {
      if (record.doctorAssessment.profile !== record.profile || record.doctorAssessment.icd10Code !== record.icd10Code
        || record.requirementSnapshot === undefined) return invalid();
      const treatment = (record.requirementSnapshot as RequirementCatalogue).scope?.treatment;
      if (record.doctorAssessment.careContext === "unknown") {
        if ((record.requirementSnapshot as RequirementCatalogue).status !== "unavailable" || treatment !== undefined) return invalid();
      } else if (treatment !== record.doctorAssessment.careContext) return invalid();
    }
    if ((record.sourceSessionId === null) !== (record.triageSnapshot === null)) return invalid();
    let previousFacts: ReferralFacts | null = null;
    let previousAssessment: DoctorAssessmentEventState | null = null;
    let sawAssessmentEvent = false;
    let recordedRegistrationSnapshot: RegistrationFeatures | null = null;
    const examinations = new Map<string, ExaminationRecord>();
    const eventIds = new Set<string>();
    let lastTime = record.createdAt;
    for (const [index, event] of record.events.entries()) {
      if (!object(event) || !keysOnly(event, ["id", "type", "actorId", "actorName", "source", "occurredAt", "recordedAt", "reason", "before", "after", "revision"])
        || !text(event.id) || eventIds.has(event.id) || !text(event.actorId) || !text(event.actorName)
        || !["created", "facts_changed", "examination_recorded", "doctor_assessment_changed", "registration_snapshot_recorded"].includes(String(event.type)) || event.source !== "doctor_confirmation"
        || !timestamp(event.recordedAt) || !(event.occurredAt === null || timestamp(event.occurredAt))
        || event.revision !== index + 1 || !(event.reason === null || text(event.reason, 1000))
        || event.recordedAt < lastTime
        || (event.occurredAt !== null && Number(event.occurredAt) > event.recordedAt)) return invalid();
      if (index === 0 && (event.type !== "created" || event.recordedAt !== record.createdAt)) return invalid();
      if (index > 0 && event.type === "created") return invalid();
      if (event.type === "examination_recorded") {
        if (!(event.before === null || validExamination(event.before)) || !validExamination(event.after)
          || canonical(examinations.get(event.after.id) ?? null) !== canonical(event.before)) return invalid();
        examinations.set(event.after.id, event.after);
      } else if (event.type === "doctor_assessment_changed") {
        if (!validAssessmentState(event.before) || !validAssessmentState(event.after) || !text(event.reason, 1000)
          || event.occurredAt !== null || (sawAssessmentEvent && canonical(previousAssessment) !== canonical(event.before))) return invalid();
        if (!sawAssessmentEvent && event.before.assessment !== null) return invalid();
        const afterAssessment = event.after.assessment;
        const beforeRevision = event.before.assessment?.revision ?? 0;
        if (!afterAssessment || afterAssessment.revision !== beforeRevision + 1
          || afterAssessment.authorId !== event.actorId || afterAssessment.authorName !== event.actorName
          || afterAssessment.recordedAt !== event.recordedAt) return invalid();
        const afterCatalogue = event.after.requirementSnapshot;
        if (!afterCatalogue || event.after.requirementSnapshotId === null) return invalid();
        if (afterAssessment.careContext === "unknown") {
          if (afterCatalogue.status !== "unavailable" || afterCatalogue.scope !== null || afterCatalogue.profiles.length !== 0) return invalid();
        } else if (afterCatalogue.scope?.treatment !== afterAssessment.careContext
          || afterCatalogue.profiles.length !== 1 || afterCatalogue.profiles[0].profile !== afterAssessment.profile) return invalid();
        const packageSemanticsChanged = event.before.assessment === null
          || event.before.assessment.profile !== afterAssessment.profile
          || event.before.assessment.careContext !== afterAssessment.careContext
          || canonical(event.before.requirementSnapshot) !== canonical(afterCatalogue);
        if (packageSemanticsChanged === (event.before.requirementSnapshotId === event.after.requirementSnapshotId)) return invalid();
        previousAssessment = event.after;
        sawAssessmentEvent = true;
        if (event.after.assessment) {
          if (!previousFacts) return invalid();
          previousFacts = { ...(previousFacts as ReferralFacts), profile: event.after.assessment.profile, icd10Code: event.after.assessment.icd10Code };
        }
      } else if (event.type === "registration_snapshot_recorded") {
        if (event.before !== null || !validRegistrationFeatures(event.after) || recordedRegistrationSnapshot !== null
          || event.actorId !== record.doctorId || event.reason !== null || event.occurredAt !== null) return invalid();
        recordedRegistrationSnapshot = event.after;
      } else {
        if (!(event.before === null || validFacts(event.before)) || !validFacts(event.after)
          || !keysOnly(event.after as unknown as Record<string, unknown>, FACT_KEYS) || canonical(event.before) !== canonical(previousFacts)) return invalid();
        previousFacts = event.after;
      }
      lastTime = event.recordedAt;
      eventIds.add(event.id);
    }
    if (record.updatedAt !== lastTime || canonical(previousFacts) !== canonical(facts(record as unknown as Referral))
      || (sawAssessmentEvent && canonical(previousAssessment) !== canonical(assessmentState(record as unknown as Referral)))
      || (!sawAssessmentEvent && record.doctorAssessment !== null)
      || canonical(recordedRegistrationSnapshot) !== canonical(record.registrationSnapshot)
      || canonical([...examinations.values()].sort((a, b) => a.id.localeCompare(b.id))) !== canonical([...record.examinations].sort((a, b) => a.id.localeCompare(b.id)))) return invalid();
    ids.add(record.id);
  }
  const tokens = new Set<string>();
  for (const link of value.links) {
    if (!object(link) || !keysOnly(link, ["token", "owner"]) || !text(link.token) || tokens.has(link.token) || !validActor(link.owner) || link.owner.role === "analyst") return invalid();
    tokens.add(link.token);
  }
  const commandKeys = new Set<string>();
  for (const command of value.commands) {
    if (!object(command) || !keysOnly(command, ["actorId", "organizationId", "key", "payload", "referralId"]) || !text(command.actorId) || !text(command.organizationId) || !text(command.key, 128)
      || !text(command.payload, 100000) || !text(command.referralId) || !ids.has(command.referralId)) return invalid();
    const commandKey = canonical([command.actorId, command.organizationId, command.key]);
    if (commandKeys.has(commandKey) || value.referrals.find((referral) => referral.id === command.referralId)?.organizationId !== command.organizationId) return invalid();
    commandKeys.add(commandKey);
  }
  const access = value.patientAccess;
  const reports = value.patientReports;
  if (!Array.isArray(access) || !Array.isArray(reports)) return invalid();
  const accessIds = new Set<string>();
  const accessHashes = new Set<string>();
  for (const entry of access) {
    if (!object(entry) || !keysOnly(entry, ["id", "sourceSessionId", "referralId", "sourceLinkHash", "organizationId", "doctorId", "capabilityHash", "issuedAt", "expiresAt", "revokedAt", "issuedBy", "revokedBy"])
      || !text(entry.id) || accessIds.has(entry.id) || !text(entry.organizationId) || !text(entry.doctorId) || !text(entry.issuedBy)
      || !(entry.sourceSessionId === null || text(entry.sourceSessionId)) || !(entry.referralId === null || text(entry.referralId))
      || !(entry.sourceLinkHash === null || typeof entry.sourceLinkHash === "string" && /^[a-f0-9]{64}$/u.test(entry.sourceLinkHash))
      || !/^[a-f0-9]{64}$/u.test(String(entry.capabilityHash)) || accessHashes.has(String(entry.capabilityHash))
      || !timestamp(entry.issuedAt) || !timestamp(entry.expiresAt) || entry.expiresAt <= entry.issuedAt || entry.expiresAt - entry.issuedAt > PREPARATION_TTL_MS
      || !(entry.revokedAt === null || timestamp(entry.revokedAt) && entry.revokedAt >= entry.issuedAt)
      || !(entry.revokedBy === null || text(entry.revokedBy)) || ((entry.revokedAt === null) !== (entry.revokedBy === null))
      || (entry.sourceSessionId === null && entry.referralId === null)) return invalid();
    if (entry.referralId !== null) {
      const referral = value.referrals.find((item) => item.id === entry.referralId);
      if (!referral || referral.organizationId !== entry.organizationId || referral.doctorId !== entry.doctorId
        || (entry.sourceSessionId !== null && referral.sourceSessionId !== entry.sourceSessionId)) return invalid();
    }
    if (entry.sourceLinkHash !== null && !value.links.some((link) => sourceLinkHash(link.token) === entry.sourceLinkHash
      && link.owner.id === entry.doctorId && link.owner.organizationId === entry.organizationId)) return invalid();
    accessIds.add(entry.id); accessHashes.add(String(entry.capabilityHash));
  }
  const reportRevisions = new Map<string, number>();
  const reportIds = new Set<string>();
  const reportCommands = new Set<string>();
  for (const entry of reports) {
    if (!object(entry) || !keysOnly(entry, ["id", "referralId", "requirementId", "catalogueVersion", "requirementSnapshotId", "source", "actorAccessId", "performedOn", "resultAvailable", "recordedAt", "revision", "idempotencyKey", "payload"])
      || !text(entry.id) || reportIds.has(entry.id) || !text(entry.referralId) || !text(entry.requirementId) || !text(entry.catalogueVersion) || !text(entry.requirementSnapshotId)
      || entry.source !== "patient_self_report" || !text(entry.actorAccessId) || !isCalendarDate(entry.performedOn)
      || typeof entry.resultAvailable !== "boolean" || !timestamp(entry.recordedAt) || !text(entry.idempotencyKey, 128) || !text(entry.payload, 10000)
      || !Number.isSafeInteger(entry.revision)) return invalid();
    if (entry.payload !== canonical({ requirementId: entry.requirementId, performedOn: entry.performedOn, resultAvailable: entry.resultAvailable,
      expectedRevision: Number(entry.revision) - 1, idempotencyKey: entry.idempotencyKey })) return invalid();
    const grant = access.find((item) => item.id === entry.actorAccessId);
    if (!grant || grant.referralId !== entry.referralId || entry.recordedAt < grant.issuedAt || entry.recordedAt >= grant.expiresAt
      || (grant.revokedAt !== null && entry.recordedAt > grant.revokedAt) || entry.performedOn > localDate(entry.recordedAt)) return invalid();
    const key = canonical([entry.referralId, entry.requirementSnapshotId, entry.requirementId]);
    const command = canonical([entry.actorAccessId, entry.idempotencyKey]);
    if (reportCommands.has(command) || entry.revision !== (reportRevisions.get(key) ?? 0) + 1) return invalid();
    reportRevisions.set(key, Number(entry.revision)); reportIds.add(entry.id); reportCommands.add(command);
  }
  for (const referral of value.referrals) {
    for (const event of referral.events) {
      if (event.type !== "examination_recorded" || !event.after.patientReportId) continue;
      const report = reports.find((entry) => entry.id === event.after.patientReportId);
      if (!report || report.referralId !== referral.id || report.requirementId !== event.after.requirementId
        || report.requirementSnapshotId !== event.after.requirementSnapshotId
        || report.performedOn !== event.after.performedOn || report.resultAvailable !== event.after.resultAvailable
        || report.recordedAt > event.recordedAt) return invalid();
    }
  }
  const mis = validateMisStorage(value as unknown as ReferralDatabase);
  return clone({ ...value, schemaVersion: REFERRAL_DATABASE_SCHEMA_VERSION, patientAccess: access, patientReports: reports,
    misOutbox: mis.outbox, misCommands: mis.commands } as unknown as ReferralDatabase);
}

export class MemoryReferralRepository implements ReferralRepository {
  private state = initial();
  private queue: Promise<unknown> = Promise.resolve();
  async read<R>(fn: (state: Readonly<ReferralDatabase>) => R): Promise<R> {
    await this.queue;
    return clone(fn(clone(this.state)));
  }
  transaction<R>(fn: (draft: ReferralDatabase) => R | Promise<R>): Promise<R> {
    const operation = this.queue.then(async () => {
      const draft = clone(this.state);
      const result = await fn(draft);
      this.state = validateReferralDatabase(draft);
      return clone(result);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
export class FileReferralRepository implements ReferralRepository {
  private readonly state: FileState<ReferralDatabase>;
  constructor(path: string) { this.state = new FileState({ path, initial, validate: validateReferralDatabase }); }
  read<R>(fn: (state: Readonly<ReferralDatabase>) => R): Promise<R> { return this.state.read(fn); }
  transaction<R>(fn: (draft: ReferralDatabase) => R | Promise<R>): Promise<R> { return this.state.transaction(fn); }
  close(): Promise<void> { return this.state.close(); }
}

export class ReferralService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly catalogue: RequirementCatalogue;
  private readonly conservativeCatalogue: RequirementCatalogue;
  private readonly resolveDoctor?: (id: string) => Promise<ReferralActor | null>;
  private readonly risk?: MisRiskPort;
  private readonly researchEventsEnabled: boolean;
  constructor(private readonly repository: ReferralRepository, options: { now?: () => number; id?: () => string; catalogue?: RequirementCatalogue; conservativeCatalogue?: RequirementCatalogue; resolveDoctor?: (id: string) => Promise<ReferralActor | null>; risk?: MisRiskPort; researchEventsEnabled?: boolean } = {}) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.catalogue = options.catalogue ?? DEFAULT_REQUIREMENTS;
    this.conservativeCatalogue = options.conservativeCatalogue ?? DEFAULT_CONSERVATIVE_REQUIREMENTS;
    this.resolveDoctor = options.resolveDoctor;
    this.risk = options.risk;
    this.researchEventsEnabled = options.researchEventsEnabled === true;
  }
  private async assignedDoctor(state: Readonly<ReferralDatabase>, actor: ReferralActor, doctorId: string, organizationId: string) {
    const candidate = this.resolveDoctor ? await this.resolveDoctor(doctorId)
      : actor.id === doctorId ? actor : state.links.find((entry) => entry.owner.id === doctorId && entry.owner.organizationId === organizationId)?.owner;
    if (!candidate || candidate.role !== "doctor" || candidate.organizationId !== organizationId) fail("DOCTOR_ASSIGNMENT_REQUIRED", "Направлению нужен назначенный врач", 409);
  }
  private writer(actor: ReferralActor): void {
    if (!validActor(actor) || actor.role === "analyst") fail("FORBIDDEN", "Нет доступа", 403);
  }
  private physician(actor: ReferralActor, referral: Referral): void {
    if (actor.role !== "doctor" || actor.id !== referral.doctorId) fail("FORBIDDEN", "Заключение изменяет назначенный врач", 403);
  }
  private visible(actor: ReferralActor, referral: Referral): boolean {
    return actor.role !== "analyst" && referral.organizationId === actor.organizationId && (actor.role === "owner" || referral.doctorId === actor.id);
  }
  private find(state: Readonly<ReferralDatabase>, actor: ReferralActor, id: string): Referral {
    const referral = state.referrals.find((entry) => entry.id === id && this.visible(actor, entry));
    if (!referral) return fail("NOT_FOUND", "Направление не найдено", 404);
    return referral;
  }
  private decorate(referral: Referral, at = this.now()): ReferralDetail {
    // Старое направление без снимка нельзя пересчитывать по текущему справочнику:
    // его версия и область действия на момент создания неизвестны.
    const catalogue = referral.doctorAssessment?.careContext === "operative" || referral.doctorAssessment?.careContext === "conservative"
      ? referral.requirementSnapshot ?? UNKNOWN_CREATION_REQUIREMENTS
      : UNKNOWN_CREATION_REQUIREMENTS;
    const completeness = evaluateCompleteness(currentPackageSubject(referral, catalogue), catalogue, at);
    const flow = currentStage(referral).flow;
    const transitions = eventTransitions(referral);
    const events = referral.events.map((event, index) => ({ ...clone(event), transition: clone(transitions[index] ?? null) }));
    return { ...clone(referral), events, completeness, flow, observedStageDays: observedStageDays(referral, at) };
  }
  private detailResponse(state: Readonly<ReferralDatabase>, referral: Referral, at = this.now()): ReferralDetail {
    return { ...this.decorate(referral, at), patientReports: latestPatientReports(state, referral) };
  }
  private reconcileReadiness(state: ReferralDatabase, referral: Referral, at: number): void {
    reconcileReadiness(state, referral, at, this.id);
  }
  private requirementSnapshot(profile: string, careContext: DoctorAssessment["careContext"]): RequirementCatalogue {
    if (careContext === "unknown") return clone(UNKNOWN_CREATION_REQUIREMENTS);
    const catalogue = careContext === "conservative" ? this.conservativeCatalogue : this.catalogue;
    return { ...clone(catalogue), profiles: catalogue.profiles.filter((entry) => entry.profile === profile).map(clone) };
  }
  private event(actor: ReferralActor, revision: number, type: ReferralEvent["type"], before: ReferralEvent["before"], after: ReferralEvent["after"], reason: string | null, occurredAt: number | null, recordedAt = this.now()): ReferralEvent {
    if (occurredAt !== null && (!timestamp(occurredAt) || occurredAt > recordedAt)) fail();
    return { id: this.id(), type, actorId: actor.id, actorName: actor.displayName, source: "doctor_confirmation", occurredAt, recordedAt, before: clone(before), after: clone(after), reason, revision };
  }
  private command(state: Readonly<ReferralDatabase>, actor: ReferralActor, key: string, payload: string): Referral | undefined {
    if (!text(key, 128)) fail();
    const command = state.commands.find((entry) => entry.actorId === actor.id && entry.organizationId === actor.organizationId && entry.key === key);
    if (!command) return undefined;
    if (command.payload !== payload) fail("IDEMPOTENCY_CONFLICT", "Ключ уже использован для другого изменения", 409);
    return this.find(state, actor, command.referralId);
  }
  private remember(state: ReferralDatabase, actor: ReferralActor, key: string, payload: string, referralId: string): void {
    state.commands.push({ actorId: actor.id, organizationId: actor.organizationId, key, payload, referralId });
  }
  async bindLink(token: string, actor: ReferralActor): Promise<void> {
    this.writer(actor);
    if (!text(token)) fail();
    return this.repository.transaction((state) => {
      const existing = state.links.find((entry) => entry.token === token);
      if (existing && (existing.owner.id !== actor.id || existing.owner.organizationId !== actor.organizationId)) fail("OWNER_CONFLICT", "Ссылка уже принадлежит другому врачу", 409);
      if (!existing) state.links.push({ token, owner: clone(actor) });
    });
  }
  ownerForToken(token: string): Promise<ReferralActor | null> {
    return this.repository.read((state) => clone(state.links.find((entry) => entry.token === token)?.owner ?? null));
  }
  async list(actor: ReferralActor, filters: ReferralListFilters = {}): Promise<ReferralDetail[]> {
    this.writer(actor);
    const raw = filters as unknown;
    if (!object(raw)) fail();
    const normalized = raw as Record<string, unknown>;
    if (!keysOnly(normalized, ["state", "profile"])
      || !(normalized.state === undefined || REFERRAL_JOURNEY_FLOWS.includes(normalized.state as ReferralJourneyFlow))
      || !(normalized.profile === undefined || text(normalized.profile))) fail();
    const selectedState = normalized.state as ReferralJourneyFlow | undefined;
    const profile = normalized.profile === undefined ? undefined : canonicalProfile(normalized.profile as string);
    return this.repository.read((state) => state.referrals.filter((entry) => this.visible(actor, entry)).map((entry) => this.decorate(entry))
      .filter((entry) => (!selectedState || entry.flow === selectedState) && (!profile || entry.profile === profile)));
  }
  async detail(actor: ReferralActor, id: string): Promise<ReferralDetail> {
    this.writer(actor);
    return this.repository.read((state) => {
      const referral = this.find(state, actor, id);
      return this.detailResponse(state, referral);
    });
  }
  async issuePreparation(sourceSessionId: string, actor: ReferralActor, doctorToken: string, retryToken?: string) {
    this.writer(actor);
    if (!text(sourceSessionId)) fail();
    return this.repository.transaction(async (state) => {
      const owner = state.links.find((entry) => entry.token === doctorToken)?.owner;
      if (!owner || owner.id !== actor.id || owner.organizationId !== actor.organizationId) fail("NOT_FOUND", "Опрос недоступен", 404);
      await this.assignedDoctor(state, actor, actor.id, actor.organizationId);
      const existing = state.patientAccess?.find((entry) => entry.sourceSessionId === sourceSessionId);
      if (existing) {
        if (retryToken && validPreparationToken(retryToken) && existing.capabilityHash === preparationHash(retryToken)
          && existing.doctorId === actor.id && existing.organizationId === actor.organizationId && existing.revokedAt === null && existing.expiresAt > this.now()) {
          if (existing.sourceLinkHash === null) {
            existing.sourceLinkHash = sourceLinkHash(doctorToken);
          }
          return { token: retryToken, accessId: existing.id, expiresAt: existing.expiresAt };
        }
        fail("ACCESS_ALREADY_ISSUED", "Доступ уже создан", 409);
      }
      const linked = state.referrals.find((entry) => entry.sourceSessionId === sourceSessionId && this.visible(actor, entry));
      const issued = newPatientAccess(actor, this.now(), sourceSessionId, linked?.id ?? null);
      issued.access.sourceLinkHash = sourceLinkHash(doctorToken);
      if (retryToken) {
        if (!validPreparationToken(retryToken)) fail();
        issued.token = retryToken; issued.access.capabilityHash = preparationHash(retryToken);
      }
      (state.patientAccess ??= []).push(issued.access);
      return { token: issued.token, accessId: issued.access.id, expiresAt: issued.access.expiresAt };
    });
  }
  async preparationStatus(actor: ReferralActor, id: string) {
    this.writer(actor);
    return this.repository.read((state) => {
      this.find(state, actor, id);
      const grants = (state.patientAccess ?? []).filter((entry) => entry.referralId === id);
      const active = grants.find((entry) => entry.revokedAt === null && entry.expiresAt > this.now());
      return { accessRevision: grants.length + grants.filter((entry) => entry.revokedAt !== null).length, expiresAt: active?.expiresAt ?? null, active: Boolean(active) };
    });
  }
  async managePreparation(actor: ReferralActor, id: string, action: "reissue" | "revoke", input: { expectedAccessRevision: number; idempotencyKey: string }, retryToken?: string) {
    this.writer(actor);
    if (!["reissue", "revoke"].includes(action) || !object(input) || !keysOnly(input, ["expectedAccessRevision", "idempotencyKey"])
      || !Number.isSafeInteger(input.expectedAccessRevision) || input.expectedAccessRevision < 0) fail();
    const payload = canonical({ action: `preparation_${action}`, id, input });
    return this.repository.transaction(async (state) => {
      const referral = this.find(state, actor, id);
      if (action === "reissue") await this.assignedDoctor(state, actor, referral.doctorId, referral.organizationId);
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) {
        if (action === "revoke") return null;
        const issued = retryToken && activePatientAccess(state, retryToken, this.now());
        if (!issued || issued.referralId !== id) return fail("ACCESS_CHANGED", "Ссылка изменилась. Обновите карточку", 409);
        return { token: retryToken!, accessId: issued.id, expiresAt: issued.expiresAt };
      }
      const grants = (state.patientAccess ?? []).filter((entry) => entry.referralId === id);
      const revision = grants.length + grants.filter((entry) => entry.revokedAt !== null).length;
      if (revision !== input.expectedAccessRevision) fail("REVISION_CONFLICT", "Доступ изменился. Обновите карточку", 409);
      if (action === "reissue" && !validPreparationToken(retryToken)) fail();
      const at = this.now();
      for (const entry of state.patientAccess ?? []) {
        if (entry.referralId === id && entry.revokedAt === null) { entry.revokedAt = at; entry.revokedBy = actor.id; }
      }
      this.remember(state, actor, input.idempotencyKey, payload, id);
      if (action === "revoke") return null;
      const issued = newPatientAccess({ id: referral.doctorId, organizationId: referral.organizationId }, at, referral.sourceSessionId, id);
      issued.token = retryToken!; issued.access.capabilityHash = preparationHash(retryToken!);
      issued.access.issuedBy = actor.id;
      issued.access.sourceLinkHash = grants.find((entry) => entry.sourceLinkHash !== null)?.sourceLinkHash ?? null;
      (state.patientAccess ??= []).push(issued.access);
      return { token: issued.token, accessId: issued.access.id, expiresAt: issued.access.expiresAt };
    });
  }
  async preparation(token: string, accessId?: string) {
    return this.repository.read((state) => {
      const at = this.now();
      const access = activePatientAccess(state, token, at, accessId);
      if (!access) return fail("UNAUTHORIZED", "Ссылка недействительна или устарела", 401);
      const referral = state.referrals.find((entry) => entry.id === access.referralId);
      return packageProjection(access, referral, at, referral ? this.decorate(referral, at).completeness : undefined,
        referral ? latestPatientReports(state, referral) : []);
    });
  }
  async discoverPreparation(doctorToken: string, cookies: string) {
    if (!/^[a-f0-9]{16}$/u.test(doctorToken) || cookies.length > 20000) fail("UNAUTHORIZED", "Доступ недоступен", 401);
    return this.repository.read((state) => {
      const at = this.now();
      const hash = sourceLinkHash(doctorToken);
      for (const access of state.patientAccess ?? []) {
        if (access.sourceLinkHash !== hash || access.revokedAt !== null || access.expiresAt <= at) continue;
        const prefix = `${preparationCookieName(access.id)}=`;
        const values = cookies.split(";").map((entry) => entry.trim()).filter((entry) => entry.startsWith(prefix));
        const token = values.length === 1 ? values[0].slice(prefix.length) : "";
        if (activePatientAccess(state, token, at, access.id)) {
          const referral = state.referrals.find((entry) => entry.id === access.referralId);
          return packageProjection(access, referral, at, referral ? this.decorate(referral, at).completeness : undefined,
            referral ? latestPatientReports(state, referral) : []);
        }
      }
      return fail("UNAUTHORIZED", "Доступ недоступен", 401);
    });
  }
  async reportPreparation(token: string, accessId: string, input: PatientReportInput) {
    if (!object(input) || !keysOnly(input, ["requirementId", "performedOn", "resultAvailable", "expectedRevision", "idempotencyKey"])
      || !text(input.requirementId) || !isCalendarDate(input.performedOn) || typeof input.resultAvailable !== "boolean"
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !text(input.idempotencyKey, 128)) fail();
    return this.repository.transaction((state) => {
      const at = this.now();
      const access = activePatientAccess(state, token, at, accessId);
      if (!access) return fail("UNAUTHORIZED", "Доступ недоступен", 401);
      const referral = state.referrals.find((entry) => entry.id === access.referralId);
      if (!referral || referral.cancelled) return fail("PACKAGE_UNAVAILABLE", "Пакет недоступен", 409);
      if (!referral.doctorAssessment || referral.doctorAssessment.careContext === "unknown" || !referral.requirementSnapshotId) {
        return fail("PACKAGE_UNAVAILABLE", "Пакет недоступен", 409);
      }
      const payload = canonical(input);
      const replay = state.patientReports?.find((entry) => entry.actorAccessId === accessId && entry.idempotencyKey === input.idempotencyKey);
      if (replay && replay.payload !== payload) fail("IDEMPOTENCY_CONFLICT", "Повторный запрос отличается", 409);
      const requirement = referral.requirementSnapshot?.profiles.find((entry) => entry.profile === referral.profile)?.requirements.find((entry) => entry.id === input.requirementId);
      if (!requirement) return fail("NOT_FOUND", "Пункт не найден", 404);
      const verified = referral.examinations.find((entry) => entry.requirementSnapshotId === referral.requirementSnapshotId
        && entry.requirementId === requirement.id);
      if (requirement.conditional && verified?.applicability !== "yes") fail("APPLICABILITY_UNCONFIRMED", "Применимость подтверждает врач", 409);
      if (input.performedOn > localDate(at)) fail();
      const reports = latestPatientReports(state, referral);
      const previous = reports.find((entry) => entry.requirementId === requirement.id);
      if (!replay) {
        if ((previous?.revision ?? 0) !== input.expectedRevision) fail("REVISION_CONFLICT", "Отметка изменилась. Обновите список", 409);
        if (previous?.performedOn === input.performedOn && previous.resultAvailable === input.resultAvailable) fail("NO_CHANGES", "Отметка уже сохранена", 409);
        const history = (state.patientReports ?? []).filter((entry) => entry.referralId === referral.id);
        if (history.length >= 200 || history.filter((entry) => entry.requirementId === requirement.id).length >= 20) fail("REPORT_LIMIT", "Предел изменений достигнут. Обратитесь к врачу", 429);
        if (history.filter((entry) => entry.actorAccessId === access.id && entry.recordedAt > at - 60000).length >= 10) fail("RATE_LIMIT", "Подождите минуту перед следующим изменением", 429);
        (state.patientReports ??= []).push({ id: this.id(), referralId: referral.id, requirementId: requirement.id,
          catalogueVersion: referral.requirementSnapshot!.version, requirementSnapshotId: referral.requirementSnapshotId,
          source: "patient_self_report", actorAccessId: accessId,
          performedOn: input.performedOn, resultAvailable: input.resultAvailable, recordedAt: at,
          revision: (previous?.revision ?? 0) + 1, idempotencyKey: input.idempotencyKey, payload });
      }
      return packageProjection(access, referral, at, this.decorate(referral, at).completeness, latestPatientReports(state, referral));
    });
  }
  async confirmPatientReport(actor: ReferralActor, id: string, input: { reportId: string; expectedRevision: number; expectedReportRevision: number; idempotencyKey: string }) {
    this.writer(actor);
    if (actor.role !== "doctor") fail("FORBIDDEN", "Результат подтверждает назначенный врач", 403);
    if (!object(input) || !keysOnly(input, ["reportId", "expectedRevision", "expectedReportRevision", "idempotencyKey"])
      || !text(input.reportId) || !Number.isSafeInteger(input.expectedRevision) || !Number.isSafeInteger(input.expectedReportRevision)) fail();
    const payload = canonical({ action: "confirmPatientReport", id, input });
    return this.repository.transaction((state) => {
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) return this.detailResponse(state, replay);
      const referral = this.find(state, actor, id);
      if (referral.cancelled) fail("REFERRAL_CANCELLED", "Направление отменено", 409);
      if (referral.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "Карточка изменилась", 409);
      const report = latestPatientReports(state, referral).find((entry) => entry.id === input.reportId);
      if (!report || report.revision !== input.expectedReportRevision) return fail("REVISION_CONFLICT", "Отметка пациента изменилась", 409);
      const requirement = referral.requirementSnapshot?.profiles.find((entry) => entry.profile === referral.profile)?.requirements.find((entry) => entry.id === report.requirementId);
      if (!requirement || report.requirementSnapshotId !== referral.requirementSnapshotId) return fail("NOT_FOUND", "Обследование не найдено", 404);
      const previous = referral.examinations.find((entry) => entry.requirementSnapshotId === referral.requirementSnapshotId
        && entry.requirementId === report.requirementId);
      if (requirement.conditional && previous?.applicability !== "yes") fail("APPLICABILITY_UNCONFIRMED", "Сначала подтвердите применимость", 409);
      const expiresOn = requirement.validForDays === null ? null : new Date(Date.parse(`${report.performedOn}T00:00:00Z`) + requirement.validForDays * 86400000).toISOString().slice(0, 10);
      const record: ExaminationRecord = { id: previous?.id ?? this.id(), requirementSnapshotId: referral.requirementSnapshotId ?? undefined,
        requirementId: requirement.id, label: requirement.label,
        performedOn: report.performedOn, resultAvailable: report.resultAvailable, expiresOn, applicability: "yes", patientReportId: report.id };
      const at = this.now();
      referral.examinations = [...referral.examinations.filter((entry) => entry.id !== record.id), record];
      referral.revision += 1;
      referral.updatedAt = at;
      referral.events.push(this.event(actor, referral.revision, "examination_recorded", previous ?? null, record,
        `Проверена отметка пациента ${report.id}, версия ${report.revision}`, null, at));
      this.remember(state, actor, input.idempotencyKey, payload, id);
      this.reconcileReadiness(state, referral, at);
      return this.detailResponse(state, referral);
    });
  }
  private validateCreate(actor: ReferralActor, input: CreateReferralInput): void {
    this.writer(actor);
    if (!object(input) || !keysOnly(input, ["patientLabel", "profile", "icd10Code", "destinationOrganization", "sourceSessionId", "idempotencyKey"]) || !text(input.patientLabel) || !text(input.profile) || !isSelectableProfile(input.profile)
      || !(input.icd10Code === undefined || input.icd10Code === null || typeof input.icd10Code === "string")
      || !validIcd10Code(normalizeIcd10Code(input.icd10Code)) || !(input.destinationOrganization === undefined || input.destinationOrganization === null || text(input.destinationOrganization))
      || !(input.sourceSessionId === undefined || input.sourceSessionId === null || text(input.sourceSessionId))) fail();
  }
  async replayCreate(actor: ReferralActor, input: CreateReferralInput): Promise<ReferralDetail | null> {
    this.validateCreate(actor, input);
    return this.repository.read((state) => {
      const referral = this.command(state, actor, input.idempotencyKey, canonical({ action: "create", input }));
      return referral ? this.detailResponse(state, referral) : null;
    });
  }
  async create(actor: ReferralActor, input: CreateReferralInput, source?: ReferralSourceSession): Promise<ReferralDetail> {
    this.validateCreate(actor, input);
    const payload = canonical({ action: "create", input });
    return this.repository.transaction((state) => {
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) return this.detailResponse(state, replay);
      let doctorId = actor.id;
      let triageSnapshot: Referral["triageSnapshot"] = null;
      if (input.sourceSessionId) {
        if (!source || source.sessionId !== input.sourceSessionId) fail("SOURCE_SESSION_REQUIRED", "Нужен проверенный собственный опрос", 400);
        const owner = state.links.find((entry) => entry.token === source!.doctorToken)?.owner;
        if (!owner || owner.organizationId !== actor.organizationId || (actor.role !== "owner" && owner.id !== actor.id)) fail("NOT_FOUND", "Опрос не найден", 404);
        const linked = state.referrals.find((entry) => entry.organizationId === actor.organizationId && entry.sourceSessionId === input.sourceSessionId);
        if (linked) return this.detailResponse(state, linked);
        doctorId = owner!.id;
        const { anamnesis, red_flags, urgency, urgency_reasons, routing, hypothesis, source: resultSource, processing_mode } = source!.result;
        triageSnapshot = clone({ anamnesis, red_flags, urgency, urgency_reasons, routing, hypothesis, source: resultSource, ...(processing_mode ? { processing_mode } : {}) });
      }
      const recordedAt = this.now();
      const referralId = this.id();
      const referral: Referral = {
        id: referralId, organizationId: actor.organizationId, doctorId, patientLabel: input.patientLabel.trim(),
        sourceSessionId: input.sourceSessionId ?? null, triageSnapshot, profile: canonicalProfile(input.profile), icd10Code: normalizeIcd10Code(input.icd10Code), destinationOrganization: input.destinationOrganization?.trim() || null,
        doctorAssessment: null, registrationSnapshot: null,
        requirementSnapshot: this.requirementSnapshot(canonicalProfile(input.profile), "unknown"),
        requirementSnapshotId: `${referralId}:package:0`,
        specialistReferred: null, preparationStarted: !input.sourceSessionId,
        sent: null, queue: null, scheduledDate: null, attendance: null, cancelled: false,
        createdAt: recordedAt, updatedAt: recordedAt, revision: 1, events: [], examinations: [],
      };
      referral.events.push(this.event(actor, 1, "created", null, facts(referral), null, null, recordedAt));
      state.referrals.push(referral);
      for (const access of state.patientAccess ?? []) {
        if (referral.sourceSessionId && access.sourceSessionId === referral.sourceSessionId && access.organizationId === referral.organizationId && access.doctorId === referral.doctorId) access.referralId = referral.id;
      }
      this.remember(state, actor, input.idempotencyKey, payload, referral.id);
      this.reconcileReadiness(state, referral, recordedAt);
      return this.detailResponse(state, referral);
    });
  }
  async assess(actor: ReferralActor, id: string, input: RecordDoctorAssessmentInput): Promise<ReferralDetail> {
    this.writer(actor);
    if (!object(input) || !keysOnly(input, ["expectedRevision", "expectedAssessmentRevision", "idempotencyKey", "reason", "assessment"])
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !Number.isSafeInteger(input.expectedAssessmentRevision) || input.expectedAssessmentRevision < 0
      || !text(input.idempotencyKey, 128) || !text(input.reason, 1000) || !object(input.assessment)
      || !keysOnly(input.assessment, ["hypothesis", "profile", "icd10Code", "careContext"])
      || !(input.assessment.hypothesis === null || text(input.assessment.hypothesis, 4000))
      || !text(input.assessment.profile) || !isSelectableProfile(input.assessment.profile)
      || !(input.assessment.icd10Code === null || typeof input.assessment.icd10Code === "string")
      || !["operative", "conservative", "unknown"].includes(String(input.assessment.careContext))) fail();
    const normalized = {
      hypothesis: input.assessment.hypothesis?.trim() || null,
      profile: canonicalProfile(input.assessment.profile),
      icd10Code: normalizeIcd10Code(input.assessment.icd10Code),
      careContext: input.assessment.careContext,
    };
    if (!validIcd10Code(normalized.icd10Code)) fail();
    const payload = canonical({ action: "doctor_assessment", id, input: { ...input, reason: input.reason.trim(), assessment: normalized } });
    return this.repository.transaction((state) => {
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) {
        this.physician(actor, replay);
        return this.detailResponse(state, replay);
      }
      const referral = this.find(state, actor, id);
      this.physician(actor, referral);
      if (referral.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "Направление изменилось, обновите карточку", 409);
      const assessmentRevision = referral.doctorAssessment?.revision ?? 0;
      if (assessmentRevision !== input.expectedAssessmentRevision) fail("ASSESSMENT_REVISION_CONFLICT", "Заключение врача изменилось, обновите карточку", 409);
      const previousComparable = referral.doctorAssessment && {
        hypothesis: referral.doctorAssessment.hypothesis,
        profile: referral.doctorAssessment.profile,
        icd10Code: referral.doctorAssessment.icd10Code,
        careContext: referral.doctorAssessment.careContext,
      };
      if (canonical(previousComparable) === canonical(normalized)) fail("NO_CHANGES", "Заключение уже сохранено", 409);
      const before = assessmentState(referral);
      const at = this.now();
      const assessment: DoctorAssessment = {
        ...normalized,
        authorId: actor.id,
        authorName: actor.displayName,
        recordedAt: at,
        revision: assessmentRevision + 1,
      };
      const storedTreatment = referral.requirementSnapshot?.scope?.treatment;
      const storedProfile = referral.requirementSnapshot?.profiles[0]?.profile;
      const storedCoherent = normalized.careContext === "unknown"
        ? referral.requirementSnapshot?.status === "unavailable" && referral.requirementSnapshot.scope === null
        : storedTreatment === normalized.careContext && storedProfile === normalized.profile;
      const packageChanged = !referral.doctorAssessment
        || referral.doctorAssessment.profile !== normalized.profile
        || referral.doctorAssessment.careContext !== normalized.careContext
        || !storedCoherent;
      referral.doctorAssessment = assessment;
      referral.profile = assessment.profile;
      referral.icd10Code = assessment.icd10Code;
      if (packageChanged) {
        referral.requirementSnapshot = this.requirementSnapshot(assessment.profile, assessment.careContext);
        referral.requirementSnapshotId = `${referral.id}:package:${assessment.revision}`;
      }
      referral.revision += 1;
      const event = this.event(actor, referral.revision, "doctor_assessment_changed", before, assessmentState(referral), input.reason.trim(), null, at);
      referral.updatedAt = at;
      referral.events.push(event);
      this.remember(state, actor, input.idempotencyKey, payload, referral.id);
      this.reconcileReadiness(state, referral, at);
      return this.detailResponse(state, referral);
    });
  }
  async recordRegistrationSnapshot(actor: ReferralActor, id: string, input: RecordRegistrationSnapshotInput): Promise<ReferralDetail> {
    this.writer(actor);
    if (!object(input) || !keysOnly(input, ["expectedRevision", "idempotencyKey", "attestedAtRegistration", "features"])
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !text(input.idempotencyKey, 128)
      || input.attestedAtRegistration !== true || !validRegistrationFeatures(input.features)) fail();
    const payload = canonical({ action: "registration_snapshot", id, input });
    const replay = await this.repository.read((state) => {
      const existing = this.command(state, actor, input.idempotencyKey, payload);
      if (existing) {
        this.physician(actor, existing);
        return this.detailResponse(state, existing);
      }
      const referral = this.find(state, actor, id);
      this.physician(actor, referral);
      if (referral.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "Направление изменилось, обновите карточку", 409);
      if (referral.registrationSnapshot !== null) fail("REGISTRATION_SNAPSHOT_IMMUTABLE", "Снимок при регистрации уже сохранён", 409);
      return null;
    });
    if (replay) return replay;
    let risk: MisRiskEvaluation | null = null;
    if (this.researchEventsEnabled && this.risk) {
      try { risk = await this.risk.evaluate(input.features); }
      catch { risk = { status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }; }
    }
    return this.repository.transaction((state) => {
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) {
        this.physician(actor, replay);
        return this.detailResponse(state, replay);
      }
      const referral = this.find(state, actor, id);
      this.physician(actor, referral);
      if (referral.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "Направление изменилось, обновите карточку", 409);
      if (referral.registrationSnapshot !== null) fail("REGISTRATION_SNAPSHOT_IMMUTABLE", "Снимок при регистрации уже сохранён", 409);
      const at = this.now();
      referral.registrationSnapshot = clone(input.features);
      referral.revision += 1;
      referral.updatedAt = at;
      referral.events.push(this.event(actor, referral.revision, "registration_snapshot_recorded", null,
        clone(input.features), null, null, at));
      this.remember(state, actor, input.idempotencyKey, payload, referral.id);
      reconcileResearchRisk(state, referral, risk, this.researchEventsEnabled, at, this.id, this.researchEventsEnabled);
      return this.detailResponse(state, referral);
    });
  }
  async update(actor: ReferralActor, id: string, input: UpdateReferralInput): Promise<ReferralDetail> {
    this.writer(actor);
    if (!object(input) || !keysOnly(input, ["expectedRevision", "idempotencyKey", "patch", "reason", "occurredAt"]) || !object(input.patch) || Object.keys(input.patch).length === 0 || Object.keys(input.patch).some((key) => !FACT_KEYS.includes(key as typeof FACT_KEYS[number]))) fail();
    if (!(input.reason === undefined || input.reason === null || text(input.reason, 1000))) fail();
    const payload = canonical({ action: "update", id, input });
    return this.repository.transaction((state) => {
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) return this.detailResponse(state, replay);
      const referral = this.find(state, actor, id);
      if (referral.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "Направление изменилось, обновите карточку", 409);
      const before = facts(referral);
      const after = { ...before, ...input.patch };
      if (typeof after.profile === "string") after.profile = canonicalProfile(after.profile);
      if ("profile" in input.patch && before.profile !== after.profile && !isSelectableProfile(after.profile)) fail("BAD_REQUEST", "Выберите профиль из списка");
      if (!(after.icd10Code === undefined || after.icd10Code === null || typeof after.icd10Code === "string")) fail();
      if (after.icd10Code !== undefined) after.icd10Code = normalizeIcd10Code(after.icd10Code);
      if (!validFacts(after)) fail();
      if (after.attendance !== null && (!after.scheduledDate || after.scheduledDate > localDate(this.now()))) {
        fail("ATTENDANCE_DATE_INVALID", "Явку можно подтвердить только на наступившую назначенную дату", 400);
      }
      if (before.cancelled && after.cancelled && flowFromFacts(before) !== flowFromFacts(after)) {
        fail("REFERRAL_CANCELLED", "Сначала явно возобновите отменённое направление", 409);
      }
      if (referral.sourceSessionId === null && flowFromFacts(after) === "interviewed") {
        fail("SOURCE_SESSION_REQUIRED", "Без связанного опроса нельзя подтвердить этап опроса", 400);
      }
      const clinicalChange = before.profile !== after.profile || before.icd10Code !== after.icd10Code;
      if (clinicalChange) {
        this.physician(actor, referral);
        if (!input.reason?.trim()) fail("REASON_REQUIRED", "Укажите причину исправления", 400);
      }
      const operationalKeys = FACT_KEYS.filter((key) => key !== "profile" && key !== "icd10Code");
      const operationalChange = operationalKeys.some((key) => key in input.patch && before[key] !== after[key]);
      const correction = operationalKeys.some((key) => key in input.patch && before[key] !== after[key] && before[key] !== null && before[key] !== undefined
        && !(key === "preparationStarted" && before[key] === false && after[key] === true));
      if ((correction || input.patch.cancelled !== undefined) && !input.reason?.trim()) fail("REASON_REQUIRED", "Укажите причину исправления", 400);
      const recordedAt = this.now();
      if (clinicalChange) {
        const beforeAssessment = assessmentState(referral);
        const assessmentRevision = (referral.doctorAssessment?.revision ?? 0) + 1;
        const careContext = referral.doctorAssessment?.careContext ?? "unknown";
        referral.doctorAssessment = {
          hypothesis: referral.doctorAssessment?.hypothesis ?? null,
          profile: after.profile,
          icd10Code: after.icd10Code ?? null,
          careContext,
          authorId: actor.id,
          authorName: actor.displayName,
          recordedAt,
          revision: assessmentRevision,
        };
        referral.profile = after.profile;
        referral.icd10Code = after.icd10Code;
        const storedTreatment = referral.requirementSnapshot?.scope?.treatment;
        const storedProfile = referral.requirementSnapshot?.profiles[0]?.profile;
        const storedCoherent = careContext === "unknown"
          ? referral.requirementSnapshot?.status === "unavailable" && referral.requirementSnapshot.scope === null
          : storedTreatment === careContext && storedProfile === after.profile;
        if (before.profile !== after.profile || !storedCoherent || beforeAssessment.assessment === null) {
          referral.requirementSnapshot = this.requirementSnapshot(after.profile, careContext);
          referral.requirementSnapshotId = `${referral.id}:package:${assessmentRevision}`;
        }
        referral.revision += 1;
        referral.events.push(this.event(actor, referral.revision, "doctor_assessment_changed", beforeAssessment,
          assessmentState(referral), input.reason!.trim(), null, recordedAt));
      }
      if (operationalChange) {
        const operationalBefore = facts(referral);
        const operationalAfter = { ...operationalBefore, ...Object.fromEntries(operationalKeys
          .filter((key) => key in input.patch).map((key) => [key, after[key]])) } as ReferralFacts;
        Object.assign(referral, operationalAfter);
        referral.revision += 1;
        referral.events.push(this.event(actor, referral.revision, "facts_changed", operationalBefore, operationalAfter,
          input.reason ?? null, input.occurredAt ?? null, recordedAt));
      }
      if (!clinicalChange && !operationalChange) fail("NO_CHANGES", "Изменения уже сохранены", 409);
      referral.updatedAt = recordedAt;
      this.remember(state, actor, input.idempotencyKey, payload, referral.id);
      this.reconcileReadiness(state, referral, recordedAt);
      return this.detailResponse(state, referral);
    });
  }
  async examination(actor: ReferralActor, id: string, input: RecordExaminationInput): Promise<ReferralDetail> {
    this.writer(actor);
    if (!object(input) || !keysOnly(input, ["expectedRevision", "idempotencyKey", "record", "reason", "occurredAt"]) || !object(input.record)
      || !keysOnly(input.record, ["id", "requirementId", "label", "resultAvailable", "performedOn", "expiresOn", "applicability"])
      || !(input.reason === undefined || input.reason === null || text(input.reason, 1000))) fail();
    const record: ExaminationRecord = { id: input.record.id ?? this.id(), requirementId: input.record.requirementId, label: input.record.label,
      resultAvailable: input.record.resultAvailable, performedOn: input.record.performedOn, expiresOn: input.record.expiresOn, applicability: input.record.applicability };
    if (!validExamination(record) || (record.performedOn && record.performedOn > localDate(this.now()))) fail();
    const payload = canonical({ action: "examination", id, input });
    return this.repository.transaction((state) => {
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) return this.detailResponse(state, replay);
      const referral = this.find(state, actor, id);
      if (referral.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "Направление изменилось, обновите карточку", 409);
      const previous = referral.examinations.find((entry) => entry.id === record.id);
      if (input.record.id && !previous) fail("NOT_FOUND", "Запись обследования не найдена", 404);
      if (previous && previous.requirementSnapshotId !== referral.requirementSnapshotId) {
        fail("PACKAGE_CHANGED", "Перечень изменился. Добавьте актуальную запись отдельно", 409);
      }
      if (previous && !input.reason?.trim()) fail("REASON_REQUIRED", "Укажите причину исправления", 400);
      if (referral.examinations.some((entry) => entry.requirementSnapshotId === referral.requirementSnapshotId
        && entry.requirementId === record.requirementId && entry.id !== record.id)) fail("DUPLICATE_EXAMINATION", "Исправьте существующую запись", 409);
      const recordedAt = this.now();
      const scopedRecord = { ...record, ...(referral.requirementSnapshotId ? { requirementSnapshotId: referral.requirementSnapshotId } : {}) };
      referral.examinations = [...referral.examinations.filter((entry) => entry.id !== scopedRecord.id), clone(scopedRecord)];
      referral.revision += 1;
      const event = this.event(actor, referral.revision, "examination_recorded", previous ?? null, scopedRecord, input.reason ?? null, input.occurredAt ?? null, recordedAt);
      referral.updatedAt = event.recordedAt;
      referral.events.push(event);
      this.remember(state, actor, input.idempotencyKey, payload, referral.id);
      this.reconcileReadiness(state, referral, recordedAt);
      return this.detailResponse(state, referral);
    });
  }
  async memo(actor: ReferralActor, id: string): Promise<PatientMemo> {
    const referral = await this.detail(actor, id);
    const items = referral.completeness.entries.filter((entry) => entry.status !== "not_applicable")
      .map(({ label, status, expiresOn, provenance }) => ({ label, status, expiresOn, ...(provenance ? { provenance } : {}) }));
    return { patientLabel: referral.patientLabel, scheduledDate: referral.scheduledDate,
      destinationOrganization: referral.destinationOrganization, catalogueAvailable: referral.completeness.catalogueAvailable,
      careContext: referral.doctorAssessment?.careContext ?? "unknown", items };
  }
  async aggregates(actor: ReferralActor): Promise<ReferralAggregates> {
    if (!validActor(actor)) fail("FORBIDDEN", "Нет доступа", 403);
    return this.repository.read((state) => {
      const currentReferrals = state.referrals.filter((entry) => entry.organizationId === actor.organizationId && (actor.role !== "doctor" || entry.doctorId === actor.id));
      const analyst = actor.role === "analyst";
      // Zero is a public empty-publication sentinel, never a hidden event time.
      let publicationAt = analyst ? 0 : this.now();
      let referrals = currentReferrals;
      if (analyst) {
        const states = new Map<string, Referral>();
        let released: Referral[] = [];
        const releasedContributions = new Map<string, AnalystContribution>();
        const changedReferrals = new Set<string>();
        const events = currentReferrals.flatMap((referral, referralOrder) => referral.events.map((event, eventOrder) => ({ referral, event, referralOrder, eventOrder })))
          .sort((left, right) => left.event.recordedAt - right.event.recordedAt
            || left.referralOrder - right.referralOrder
            || left.eventOrder - right.eventOrder);
        for (const { referral, event } of events) {
          const previous = states.get(referral.id);
          const next = previous ? clone(previous) : { ...clone(referral), doctorAssessment: null, registrationSnapshot: null,
            requirementSnapshot: clone(UNKNOWN_CREATION_REQUIREMENTS), requirementSnapshotId: null, events: [], examinations: [] };
          if (event.type === "examination_recorded") {
            const examination = clone(event.after as ExaminationRecord);
            next.examinations = [...next.examinations.filter((entry) => entry.id !== examination.id), examination];
          } else if (event.type === "doctor_assessment_changed") {
            const after = clone(event.after as DoctorAssessmentEventState);
            next.doctorAssessment = after.assessment;
            next.requirementSnapshot = after.requirementSnapshot ?? undefined;
            next.requirementSnapshotId = after.requirementSnapshotId;
            if (after.assessment) {
              next.profile = after.assessment.profile;
              next.icd10Code = after.assessment.icd10Code;
            }
          } else if (event.type === "registration_snapshot_recorded") {
            next.registrationSnapshot = clone(event.after as RegistrationFeatures);
          } else Object.assign(next, clone(event.after as ReferralFacts));
          next.events = [...next.events, clone(event)];
          next.updatedAt = event.recordedAt;
          next.revision = event.revision;
          states.set(referral.id, next);

          const contribution = analystContribution(next, event.recordedAt);
          if (sameContribution(releasedContributions.get(referral.id), contribution)) changedReferrals.delete(referral.id);
          else changedReferrals.add(referral.id);

          if (changedReferrals.size >= ANALYST_RELEASE_MIN_CHANGED_REFERRALS
            && analystReleaseIsSafe(releasedContributions, states, event.recordedAt)) {
            publicationAt = event.recordedAt;
            released = [...states.values()].map(clone);
            releasedContributions.clear();
            for (const entry of released) {
              releasedContributions.set(entry.id, analystContribution(entry, publicationAt));
            }
            changedReferrals.clear();
          }
        }
        referrals = released;
      }
      const groups = new Map<ReferralFlow, { count: number; days: number; observedTimeCount: number }>();
      const profiles = new Map<string, { count: number; waitingCount: number; waitingDays: number; observedWaitingTimeCount: number }>();
      for (const referral of referrals) {
        const { flow, observedStageDays: stageDays } = analyst ? this.decorate(referral, publicationAt) : this.decorate(referral);
        const previous = groups.get(flow) ?? { count: 0, days: 0, observedTimeCount: 0 };
        groups.set(flow, { count: previous.count + 1,
          days: previous.days + (stageDays ?? 0),
          observedTimeCount: previous.observedTimeCount + (stageDays === null ? 0 : 1) });
        if (actor.role !== "analyst") {
          const profile = profileDisplayName(referral.profile);
          const current = profiles.get(profile) ?? { count: 0, waitingCount: 0, waitingDays: 0, observedWaitingTimeCount: 0 };
          current.count += 1;
          if (flow === "waiting") {
            current.waitingCount += 1;
            if (stageDays !== null) {
              current.waitingDays += stageDays;
              current.observedWaitingTimeCount += 1;
            }
          }
          profiles.set(profile, current);
        }
      }
      const periodEnd = analyst ? publicationAt : this.now();
      const to = localDate(periodEnd);
      const from = analyst && publicationAt === 0 ? to : localDate(periodEnd - 29 * 86400000);
      const timeline: ReferralAggregates["timeline"] = [];
      if (actor.role !== "analyst") {
        for (let day = 29; day >= 0; day--) {
          const date = localDate(this.now() - day * 86400000);
          const boundary = Math.min(this.now(), Date.parse(`${date}T23:59:59.999+05:00`));
          let createdCount = 0;
          let totalCount = 0;
          let waitingCount = 0;
          for (const referral of referrals) {
            if (referral.createdAt > boundary) continue;
            totalCount += 1;
            if (localDate(referral.createdAt) === date) createdCount += 1;
            const lastFacts = referral.events.filter((event) => (event.type === "created" || event.type === "facts_changed") && event.recordedAt <= boundary).at(-1)?.after;
            if (lastFacts && flowFromFacts(lastFacts as ReferralFacts) === "waiting") waitingCount += 1;
          }
          timeline.push({ date, createdCount, totalCount, waitingCount });
        }
      }
      const hiddenGroups = analyst && [...groups.values()].some((group) => group.count < 5);
      // Когда часть ячеек скрыта, общий итог тоже скрывается: иначе их число
      // можно восстановить вычитанием из показанных ячеек.
      const smallTimeCell = (group: { count: number; observedTimeCount: number }) =>
        group.observedTimeCount > 0 && group.observedTimeCount < 5
        || group.count - group.observedTimeCount > 0 && group.count - group.observedTimeCount < 5;
      const suppressed = analyst && (referrals.length < 5 || hiddenGroups
        || [...groups.values()].some(smallTimeCell));
      return { suppressed, total: analyst && (hiddenGroups || referrals.length < 5) ? null : referrals.length,
        groups: [...groups].filter(([, group]) => !analyst || group.count >= 5).map(([flow, group]) => {
          const hideTime = analyst && smallTimeCell(group);
          return { flow, count: group.count,
            meanObservedDays: group.observedTimeCount && !hideTime ? group.days / group.observedTimeCount : null,
            observedTimeCount: hideTime ? null : group.observedTimeCount };
        }),
        scope: actor.role === "doctor" ? "own" : "organization", dataSource: "doctor_confirmed_local_records", forecast: null,
        perProfile: [...profiles].map(([profile, value]) => ({
          profile,
          count: value.count,
          waitingCount: value.waitingCount,
          meanObservedWaitingDays: value.observedWaitingTimeCount ? value.waitingDays / value.observedWaitingTimeCount : null,
          observedWaitingTimeCount: value.observedWaitingTimeCount,
        })),
        period: { from, to }, timeline, timelineSource: "observed_snapshot",
        timelineUnavailableReason: actor.role === "analyst" ? "not_available_for_analyst" : null };
    });
  }
}
