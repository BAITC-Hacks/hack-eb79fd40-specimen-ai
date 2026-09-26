import { randomUUID } from "node:crypto";
import { FileState } from "../storage/file-state";
import { hasMandatoryDisclaimer } from "../http";
import { DEFAULT_REQUIREMENTS, evaluateCompleteness, isCalendarDate, localDate, validateRequirementCatalogue } from "./requirements";
import { canonicalProfile, isSelectableProfile, normalizeIcd10Code, profileDisplayName, validIcd10Code } from "./profiles";
import type {
  CreateReferralInput, ExaminationRecord, PatientMemo, RecordExaminationInput, Referral,
  ReferralActor, ReferralAggregates, ReferralDatabase, ReferralDetail, ReferralEvent,
  ReferralFacts, ReferralFlow, ReferralJourneyFlow, ReferralListFilters, ReferralRepository,
  ReferralSourceSession, ReferralTransition, RequirementCatalogue,
  UpdateReferralInput,
} from "./types";
import { REFERRAL_JOURNEY_FLOWS } from "./types";

const UNKNOWN_CREATION_REQUIREMENTS: RequirementCatalogue = {
  schemaVersion: 1,
  version: "unknown-at-creation",
  status: "unavailable",
  source: null,
  scope: null,
  validated: false,
  profiles: [],
};

const REFERRAL_ERROR_BRAND = Symbol.for("demeu.ReferralError");
const ANALYST_RELEASE_MIN_CHANGED_REFERRALS = 5;
export const REFERRAL_DATABASE_SCHEMA_VERSION = 2 as const;
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
const initial = (): ReferralDatabase => ({ schemaVersion: REFERRAL_DATABASE_SCHEMA_VERSION, referrals: [], links: [], commands: [] });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const boolOrNull = (value: unknown): boolean => value === null || typeof value === "boolean";
const dateOrNull = (value: unknown): boolean => value === null || isCalendarDate(value);
const keysOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const stringArray = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const probability = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const FACT_KEYS = ["profile", "icd10Code", "specialistReferred", "preparationStarted", "destinationOrganization", "sent", "queue", "scheduledDate", "attendance", "cancelled"] as const;

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
  return object(value) && keysOnly(value, ["id", "requirementId", "label", "resultAvailable", "performedOn", "expiresOn", "applicability"])
    && text(value.id) && text(value.requirementId) && text(value.label)
    && boolOrNull(value.resultAvailable) && dateOrNull(value.performedOn) && dateOrNull(value.expiresOn)
    && ["yes", "no", "unknown"].includes(String(value.applicability))
    && !(typeof value.performedOn === "string" && typeof value.expiresOn === "string" && value.expiresOn < value.performedOn);
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
  referral: Pick<Referral, "profile" | "scheduledDate" | "examinations">,
  catalogue: RequirementCatalogue,
): Pick<Referral, "profile" | "scheduledDate" | "examinations"> {
  const profile = catalogue.profiles.find((entry) => entry.profile === referral.profile);
  if (!profile) return referral;
  const currentIds = new Set(profile.requirements.map((entry) => entry.id));
  return { ...referral, examinations: referral.examinations.filter((entry) => currentIds.has(entry.requirementId)) };
}
function eventTransitions(referral: Referral): (ReferralTransition | null)[] {
  let previousFlow: ReferralJourneyFlow | null = null;
  let currentFacts: ReferralFacts | null = null;
  return referral.events.map((event) => {
    if (event.type !== "examination_recorded") currentFacts = event.after as ReferralFacts;
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
interface AnalystContribution { flow: ReferralJourneyFlow; timeObserved: boolean }
function analystContribution(referral: Referral, at: number): AnalystContribution {
  return { flow: currentStage(referral).flow, timeObserved: Number.isFinite(observedStageDays(referral, at)) };
}
function sameContribution(left: AnalystContribution | undefined, right: AnalystContribution | undefined): boolean {
  return left?.flow === right?.flow && left?.timeObserved === right?.timeObserved;
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
  if (!object(value) || !keysOnly(value, ["schemaVersion", "referrals", "links", "commands"])
    || ![1, REFERRAL_DATABASE_SCHEMA_VERSION].includes(Number(value.schemaVersion))
    || !Array.isArray(value.referrals) || !Array.isArray(value.links) || !Array.isArray(value.commands)) return invalid();
  const ids = new Set<string>();
  for (const record of value.referrals) {
    if (!object(record) || !keysOnly(record, [...FACT_KEYS, "id", "organizationId", "doctorId", "patientLabel", "sourceSessionId", "triageSnapshot", "requirementSnapshot", "createdAt", "updatedAt", "revision", "events", "examinations"])
      || !validFacts(record) || !text(record.id) || ids.has(record.id)
      || !text(record.organizationId) || !text(record.doctorId) || !text(record.patientLabel)
      || !(record.sourceSessionId === null || text(record.sourceSessionId))
      || !timestamp(record.createdAt) || !timestamp(record.updatedAt) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1
      || !Array.isArray(record.examinations) || !record.examinations.every(validExamination) || !Array.isArray(record.events)
      || record.events.length !== record.revision) return invalid();
    if (new Set(record.examinations.map((entry) => entry.requirementId)).size !== record.examinations.length) return invalid();
    if (record.triageSnapshot !== null && !validSnapshot(record.triageSnapshot)) return invalid();
    if (record.requirementSnapshot !== undefined) {
      try {
        const snapshot = validateRequirementCatalogue(record.requirementSnapshot);
        if (snapshot.profiles.length > 1 || (snapshot.profiles.length === 1 && snapshot.profiles[0].profile !== record.profile)) return invalid();
      } catch { return invalid(); }
    }
    if ((record.sourceSessionId === null) !== (record.triageSnapshot === null)) return invalid();
    let previousFacts: ReferralFacts | null = null;
    const examinations = new Map<string, ExaminationRecord>();
    const eventIds = new Set<string>();
    let lastTime = record.createdAt;
    for (const [index, event] of record.events.entries()) {
      if (!object(event) || !keysOnly(event, ["id", "type", "actorId", "actorName", "source", "occurredAt", "recordedAt", "reason", "before", "after", "revision"])
        || !text(event.id) || eventIds.has(event.id) || !text(event.actorId) || !text(event.actorName)
        || !["created", "facts_changed", "examination_recorded"].includes(String(event.type)) || event.source !== "doctor_confirmation"
        || !timestamp(event.recordedAt) || !(event.occurredAt === null || timestamp(event.occurredAt))
        || event.revision !== index + 1 || !(event.reason === null || text(event.reason, 1000))
        || !(event.before === null || validFacts(event.before) || validExamination(event.before))
        || !(validFacts(event.after) || validExamination(event.after)) || event.recordedAt < lastTime
        || (event.occurredAt !== null && Number(event.occurredAt) > event.recordedAt)) return invalid();
      if (index === 0 && (event.type !== "created" || event.recordedAt !== record.createdAt)) return invalid();
      if (index > 0 && event.type === "created") return invalid();
      if (event.type === "examination_recorded") {
        if (!validExamination(event.after) || canonical(examinations.get(event.after.id) ?? null) !== canonical(event.before)) return invalid();
        examinations.set(event.after.id, event.after);
      } else {
        if (!validFacts(event.after) || !keysOnly(event.after as unknown as Record<string, unknown>, FACT_KEYS) || canonical(event.before) !== canonical(previousFacts)) return invalid();
        previousFacts = event.after;
      }
      lastTime = event.recordedAt;
      eventIds.add(event.id);
    }
    if (record.updatedAt !== lastTime || canonical(previousFacts) !== canonical(facts(record as unknown as Referral))
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
  return clone({ ...value, schemaVersion: REFERRAL_DATABASE_SCHEMA_VERSION } as unknown as ReferralDatabase);
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
  constructor(private readonly repository: ReferralRepository, options: { now?: () => number; id?: () => string; catalogue?: RequirementCatalogue } = {}) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.catalogue = options.catalogue ?? DEFAULT_REQUIREMENTS;
  }
  private writer(actor: ReferralActor): void {
    if (!validActor(actor) || actor.role === "analyst") fail("FORBIDDEN", "Нет доступа", 403);
  }
  private visible(actor: ReferralActor, referral: Referral): boolean {
    return actor.role !== "analyst" && referral.organizationId === actor.organizationId && (actor.role === "owner" || referral.doctorId === actor.id);
  }
  private find(state: Readonly<ReferralDatabase>, actor: ReferralActor, id: string): Referral {
    const referral = state.referrals.find((entry) => entry.id === id && this.visible(actor, entry));
    if (!referral) return fail("NOT_FOUND", "Направление не найдено", 404);
    return referral;
  }
  private decorate(referral: Referral, at = this.now(), catalogue = referral.requirementSnapshot ?? UNKNOWN_CREATION_REQUIREMENTS): ReferralDetail {
    // Старое направление без снимка нельзя пересчитывать по текущему справочнику:
    // его версия и область действия на момент создания неизвестны.
    const completeness = evaluateCompleteness(currentPackageSubject(referral, catalogue), catalogue, at);
    const flow = currentStage(referral).flow;
    const transitions = eventTransitions(referral);
    const events = referral.events.map((event, index) => ({ ...clone(event), transition: clone(transitions[index] ?? null) }));
    return { ...clone(referral), events, completeness, flow, observedStageDays: observedStageDays(referral, at) };
  }
  private requirementSnapshot(profile: string): RequirementCatalogue {
    return { ...clone(this.catalogue), profiles: this.catalogue.profiles.filter((entry) => entry.profile === profile).map(clone) };
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
    return this.repository.read((state) => this.decorate(this.find(state, actor, id)));
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
      return referral ? this.decorate(referral) : null;
    });
  }
  async create(actor: ReferralActor, input: CreateReferralInput, source?: ReferralSourceSession): Promise<ReferralDetail> {
    this.validateCreate(actor, input);
    const payload = canonical({ action: "create", input });
    return this.repository.transaction((state) => {
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) return this.decorate(replay);
      let doctorId = actor.id;
      let triageSnapshot: Referral["triageSnapshot"] = null;
      if (input.sourceSessionId) {
        if (!source || source.sessionId !== input.sourceSessionId) fail("SOURCE_SESSION_REQUIRED", "Нужен проверенный собственный опрос", 400);
        const owner = state.links.find((entry) => entry.token === source!.doctorToken)?.owner;
        if (!owner || owner.organizationId !== actor.organizationId || (actor.role !== "owner" && owner.id !== actor.id)) fail("NOT_FOUND", "Опрос не найден", 404);
        const linked = state.referrals.find((entry) => entry.organizationId === actor.organizationId && entry.sourceSessionId === input.sourceSessionId);
        if (linked) return this.decorate(linked);
        doctorId = owner!.id;
        const { anamnesis, red_flags, urgency, urgency_reasons, routing, hypothesis, source: resultSource, processing_mode } = source!.result;
        triageSnapshot = clone({ anamnesis, red_flags, urgency, urgency_reasons, routing, hypothesis, source: resultSource, ...(processing_mode ? { processing_mode } : {}) });
      }
      const recordedAt = this.now();
      const referral: Referral = {
        id: this.id(), organizationId: actor.organizationId, doctorId, patientLabel: input.patientLabel.trim(),
        sourceSessionId: input.sourceSessionId ?? null, triageSnapshot, profile: canonicalProfile(input.profile), icd10Code: normalizeIcd10Code(input.icd10Code), destinationOrganization: input.destinationOrganization?.trim() || null,
        requirementSnapshot: this.requirementSnapshot(canonicalProfile(input.profile)),
        specialistReferred: null, preparationStarted: !input.sourceSessionId,
        sent: null, queue: null, scheduledDate: null, attendance: null, cancelled: false,
        createdAt: recordedAt, updatedAt: recordedAt, revision: 1, events: [], examinations: [],
      };
      referral.events.push(this.event(actor, 1, "created", null, facts(referral), null, null, recordedAt));
      state.referrals.push(referral);
      this.remember(state, actor, input.idempotencyKey, payload, referral.id);
      return this.decorate(referral);
    });
  }
  async update(actor: ReferralActor, id: string, input: UpdateReferralInput): Promise<ReferralDetail> {
    this.writer(actor);
    if (!object(input) || !keysOnly(input, ["expectedRevision", "idempotencyKey", "patch", "reason", "occurredAt"]) || !object(input.patch) || Object.keys(input.patch).length === 0 || Object.keys(input.patch).some((key) => !FACT_KEYS.includes(key as typeof FACT_KEYS[number]))) fail();
    if (!(input.reason === undefined || input.reason === null || text(input.reason, 1000))) fail();
    const payload = canonical({ action: "update", id, input });
    return this.repository.transaction((state) => {
      const replay = this.command(state, actor, input.idempotencyKey, payload);
      if (replay) return this.decorate(replay);
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
      const correction = FACT_KEYS.some((key) => key in input.patch && before[key] !== after[key] && before[key] !== null && before[key] !== undefined
        && !(key === "preparationStarted" && before[key] === false && after[key] === true));
      if ((correction || input.patch.cancelled !== undefined) && !input.reason?.trim()) fail("REASON_REQUIRED", "Укажите причину исправления", 400);
      const recordedAt = this.now();
      Object.assign(referral, after);
      if (before.profile !== after.profile) referral.requirementSnapshot = this.requirementSnapshot(after.profile);
      referral.revision += 1;
      const event = this.event(actor, referral.revision, "facts_changed", before, after, input.reason ?? null, input.occurredAt ?? null, recordedAt);
      referral.updatedAt = event.recordedAt;
      referral.events.push(event);
      this.remember(state, actor, input.idempotencyKey, payload, referral.id);
      return this.decorate(referral);
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
      if (replay) return this.decorate(replay);
      const referral = this.find(state, actor, id);
      if (referral.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "Направление изменилось, обновите карточку", 409);
      const previous = referral.examinations.find((entry) => entry.id === record.id);
      if (input.record.id && !previous) fail("NOT_FOUND", "Запись обследования не найдена", 404);
      if (previous && !input.reason?.trim()) fail("REASON_REQUIRED", "Укажите причину исправления", 400);
      if (referral.examinations.some((entry) => entry.requirementId === record.requirementId && entry.id !== record.id)) fail("DUPLICATE_EXAMINATION", "Исправьте существующую запись", 409);
      const recordedAt = this.now();
      referral.examinations = [...referral.examinations.filter((entry) => entry.id !== record.id), clone(record)];
      referral.revision += 1;
      const event = this.event(actor, referral.revision, "examination_recorded", previous ?? null, record, input.reason ?? null, input.occurredAt ?? null, recordedAt);
      referral.updatedAt = event.recordedAt;
      referral.events.push(event);
      this.remember(state, actor, input.idempotencyKey, payload, referral.id);
      return this.decorate(referral);
    });
  }
  async memo(actor: ReferralActor, id: string): Promise<PatientMemo> {
    const referral = await this.detail(actor, id);
    const profileCorrected = referral.events.some((event) => event.type === "facts_changed"
      && (event.before as ReferralFacts).profile !== (event.after as ReferralFacts).profile);
    const items = referral.completeness.catalogueAvailable || profileCorrected
      ? referral.completeness.entries.filter((entry) => entry.status !== "not_applicable").map(({ label, status, expiresOn }) => ({ label, status, expiresOn }))
      : referral.examinations.map((record) => {
        const entry = referral.completeness.entries.find((item) => item.requirementId === record.requirementId);
        return { label: record.label, status: entry?.status ?? "unknown" as const, expiresOn: record.expiresOn };
      });
    return { patientLabel: referral.patientLabel, scheduledDate: referral.scheduledDate, destinationOrganization: referral.destinationOrganization, catalogueAvailable: referral.completeness.catalogueAvailable, items };
  }
  async aggregates(actor: ReferralActor): Promise<ReferralAggregates> {
    if (!validActor(actor)) fail("FORBIDDEN", "Нет доступа", 403);
    return this.repository.read((state) => {
      const currentReferrals = state.referrals.filter((entry) => entry.organizationId === actor.organizationId && (actor.role !== "doctor" || entry.doctorId === actor.id));
      const analyst = actor.role === "analyst";
      let publicationAt = this.now();
      let unpublishedChanges = false;
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
          const next = previous ? clone(previous) : { ...clone(referral), events: [], examinations: [] };
          if (event.type === "examination_recorded") {
            const examination = clone(event.after as ExaminationRecord);
            next.examinations = [...next.examinations.filter((entry) => entry.id !== examination.id), examination];
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
        unpublishedChanges = changedReferrals.size > 0;
      }
      const groups = new Map<ReferralFlow, { count: number; days: number; observedTimeCount: number }>();
      const profiles = new Map<string, { count: number; waitingCount: number; waitingDays: number; observedWaitingTimeCount: number }>();
      for (const referral of referrals) {
        const { flow, observedStageDays: stageDays } = analyst
          ? this.decorate(referral, publicationAt, this.requirementSnapshot(referral.profile))
          : this.decorate(referral);
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
      const from = localDate(periodEnd - 29 * 86400000);
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
            const lastFacts = referral.events.filter((event) => event.type !== "examination_recorded" && event.recordedAt <= boundary).at(-1)?.after;
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
      const suppressed = analyst && (unpublishedChanges || referrals.length < 5 || hiddenGroups
        || [...groups.values()].some(smallTimeCell));
      return { suppressed, total: analyst && (unpublishedChanges || hiddenGroups || referrals.length < 5) ? null : referrals.length,
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
