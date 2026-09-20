import catalogueData from "../../data/examination_requirements.json";
import type { Completeness, ExaminationStatus, Referral, RequirementCatalogue } from "./types";

export function validateRequirementCatalogue(value: unknown): RequirementCatalogue {
  const object = (entry: unknown): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  const text = (entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 1000;
  const keys = (entry: Record<string, unknown>, allowed: string[]) => Object.keys(entry).every((key) => allowed.includes(key));
  const invalid = (): never => { throw new Error("Invalid examination requirement catalogue"); };
  if (!object(value) || !keys(value, ["schemaVersion", "version", "status", "source", "validated", "profiles"])
    || value.schemaVersion !== 1 || !text(value.version) || !["available", "unavailable"].includes(String(value.status))
    || !(value.source === null || text(value.source)) || typeof value.validated !== "boolean" || !Array.isArray(value.profiles)) return invalid();
  const profiles = new Set<string>();
  for (const profile of value.profiles) {
    if (!object(profile) || !keys(profile, ["profile", "requirements"]) || !text(profile.profile) || profiles.has(profile.profile) || !Array.isArray(profile.requirements)) return invalid();
    const ids = new Set<string>();
    for (const requirement of profile.requirements) {
      if (!object(requirement) || !keys(requirement, ["id", "label", "required", "conditional", "validForDays"])
        || !text(requirement.id) || ids.has(requirement.id) || !text(requirement.label)
        || !(requirement.required === null || typeof requirement.required === "boolean") || typeof requirement.conditional !== "boolean"
        || !(requirement.validForDays === null || (typeof requirement.validForDays === "number" && Number.isSafeInteger(requirement.validForDays) && requirement.validForDays >= 0 && requirement.validForDays <= 36500))) return invalid();
      ids.add(requirement.id);
    }
    profiles.add(profile.profile);
  }
  return structuredClone(value as unknown as RequirementCatalogue);
}

export const DEFAULT_REQUIREMENTS = validateRequirementCatalogue(catalogueData);

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function localDate(now: number): string {
  // Операционная календарная дата Казахстана; не дата UTC около полуночи.
  return new Date(now + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function evaluateCompleteness(
  referral: Pick<Referral, "profile" | "scheduledDate" | "examinations">,
  catalogue: RequirementCatalogue = DEFAULT_REQUIREMENTS,
  now = Date.now(),
): Completeness {
  validateRequirementCatalogue(catalogue);
  const evaluatedOn = referral.scheduledDate ?? localDate(now);
  const profile = catalogue.profiles.find((entry) => entry.profile === referral.profile);
  const catalogueAvailable = catalogue.status === "available" && catalogue.validated && Boolean(catalogue.source) && Boolean(profile?.requirements.length);
  const recordedExpiryStatus = (expiresOn: string | null): ExaminationStatus =>
    referral.scheduledDate && expiresOn && isCalendarDate(expiresOn) && expiresOn < evaluatedOn ? "expired" : "unknown";
  const entries: Completeness["entries"] = (profile?.requirements ?? []).map((requirement) => {
    const record = referral.examinations.find((entry) => entry.requirementId === requirement.id);
    let expiresOn = record?.expiresOn ?? null;
    let status: ExaminationStatus = recordedExpiryStatus(expiresOn);
    if (catalogueAvailable && requirement.required !== null) {
      if (requirement.conditional && record?.applicability === "no") status = "not_applicable";
      else if (requirement.conditional && (!record || record.applicability === "unknown")) status = "unknown";
      else if (!record || record.resultAvailable === false) status = "missing";
      else if (record.resultAvailable === null) status = "unknown";
      else if (!record.performedOn || !isCalendarDate(record.performedOn)) status = "unknown";
      else {
        if (requirement.validForDays !== null) {
          const catalogueExpiry = new Date(Date.parse(`${record.performedOn}T00:00:00.000Z`) + requirement.validForDays * 86400000).toISOString().slice(0, 10);
          if (!expiresOn || catalogueExpiry < expiresOn) expiresOn = catalogueExpiry;
        }
        status = !expiresOn || !isCalendarDate(expiresOn) || record.performedOn > evaluatedOn
          ? "unknown" : expiresOn < evaluatedOn ? referral.scheduledDate ? "expired" : "unknown" : "present";
      }
    }
    return { requirementId: requirement.id, label: requirement.label, required: requirement.required, status, expiresOn };
  });
  const listedIds = new Set(entries.map((entry) => entry.requirementId));
  for (const record of referral.examinations) {
    if (listedIds.has(record.requirementId)) continue;
    entries.push({ requirementId: record.requirementId, label: record.label, required: null,
      status: recordedExpiryStatus(record.expiresOn), expiresOn: record.expiresOn });
  }
  const mandatory = entries.filter((entry) => entry.required !== false && entry.required !== null);
  const status: Completeness["status"] = entries.some((entry) => entry.status === "expired")
    ? "expired" : !catalogueAvailable || !referral.scheduledDate || mandatory.some((entry) => entry.status === "unknown")
      ? "unknown" : mandatory.some((entry) => entry.status === "missing") ? "incomplete" : "complete";
  return { status, evaluatedOn, basis: referral.scheduledDate ? "scheduled_date" : "today", catalogueVersion: catalogue.version,
    catalogueAvailable, catalogueValidated: catalogue.validated, catalogueStatus: catalogue.status, entries };
}
