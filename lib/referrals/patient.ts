import { createHash, randomBytes, randomUUID } from "node:crypto";
import { localDate } from "./requirements";
import type { PatientAccess, PatientPackage, PatientReport, Referral, ReferralDatabase } from "./types";

export const PREPARATION_TTL_MS = 30 * 86400000;
export const validPreparationToken = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/u.test(token);
export const preparationHash = (token: string): string => createHash("sha256").update("demeu:preparation:v1\0").update(token).digest("hex");
export const sourceLinkHash = (token: string): string => createHash("sha256").update("demeu:source-link:v1\0").update(token).digest("hex");
export function preparationCookieName(id: string) {
  return `${process.env.NODE_ENV === "production" ? "__Secure-" : ""}demeu_preparation_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

export function newPatientAccess(owner: { id: string; organizationId: string }, at: number, sourceSessionId: string | null, referralId: string | null) {
  const token = randomBytes(32).toString("base64url");
  const access: PatientAccess = { id: randomUUID(), sourceSessionId, referralId,
    sourceLinkHash: null,
    organizationId: owner.organizationId, doctorId: owner.id, capabilityHash: preparationHash(token),
    issuedAt: at, expiresAt: at + PREPARATION_TTL_MS, revokedAt: null, issuedBy: owner.id, revokedBy: null };
  return { access, token };
}

export function activePatientAccess(state: Readonly<ReferralDatabase>, token: string, at: number, accessId?: string): PatientAccess | undefined {
  if (!validPreparationToken(token)) return undefined;
  const hash = preparationHash(token);
  return state.patientAccess?.find((entry) => entry.capabilityHash === hash && (accessId === undefined || entry.id === accessId)
    && entry.revokedAt === null && entry.expiresAt > at);
}

export function latestPatientReports(state: Readonly<ReferralDatabase>, referral: Referral): PatientReport[] {
  if (!referral.doctorAssessment || referral.doctorAssessment.careContext === "unknown" || !referral.requirementSnapshotId) return [];
  const latest = new Map<string, PatientReport>();
  for (const report of state.patientReports ?? []) {
    if (report.referralId === referral.id && report.requirementSnapshotId === referral.requirementSnapshotId) latest.set(report.requirementId, report);
  }
  return [...latest.values()];
}

export function packageProjection(access: PatientAccess, referral: Referral | undefined, at: number,
  completeness?: import("./types").Completeness, reports: PatientReport[] = []): PatientPackage {
  const evaluatedOn = referral?.scheduledDate ?? localDate(at);
  const careContext = referral?.doctorAssessment?.careContext ?? "unknown";
  const activeCatalogue = careContext === "unknown" ? undefined : referral?.requirementSnapshot;
  const base = { accessId: access.id, expiresAt: access.expiresAt, patientLabel: referral?.patientLabel ?? null,
    scheduledDate: referral?.scheduledDate ?? null, destinationOrganization: referral?.destinationOrganization ?? null,
    catalogueVersion: activeCatalogue?.version ?? null, catalogueSource: activeCatalogue?.source ?? null,
    catalogueValidated: Boolean(activeCatalogue?.validated), catalogueAvailable: Boolean(completeness?.catalogueAvailable), careContext, evaluatedOn,
    confirmedCompleteness: completeness?.status ?? "unknown" as const };
  if (!referral) return { ...base, state: "awaiting_referral", items: [] };
  const definitions = activeCatalogue?.profiles.find((entry) => entry.profile === referral.profile)?.requirements ?? [];
  return { ...base, state: referral.cancelled ? "cancelled" : "preparing", items: definitions.map((definition) => {
    const verified = referral.examinations.find((entry) => entry.requirementSnapshotId === referral.requirementSnapshotId
      && entry.requirementId === definition.id);
    const report = reports.find((entry) => entry.requirementId === definition.id);
    const confirmed = completeness?.entries.find((entry) => entry.requirementId === definition.id);
    const applicability = definition.conditional ? verified?.applicability ?? "unknown" : "yes" as const;
    const performedOn = report?.performedOn ?? verified?.performedOn ?? null;
    const resultAvailable = report?.resultAvailable ?? verified?.resultAvailable ?? null;
    const calculatedExpiry = performedOn && definition.validForDays !== null
      ? new Date(Date.parse(`${performedOn}T00:00:00Z`) + definition.validForDays * 86400000).toISOString().slice(0, 10) : null;
    // A self-report never inherits the expiration of a different verified result.
    const recordedExpiry = report ? null : verified?.expiresOn ?? null;
    const expiresOn = calculatedExpiry && recordedExpiry ? (calculatedExpiry < recordedExpiry ? calculatedExpiry : recordedExpiry) : calculatedExpiry ?? recordedExpiry;
    const preparationStatus = applicability === "no" ? "not_applicable" : applicability === "unknown" ? "unknown"
      : !performedOn || resultAvailable === false ? "missing" : performedOn > evaluatedOn || resultAvailable === null || !expiresOn ? "unknown"
        : expiresOn < evaluatedOn ? "expired" : "present";
    return { requirementId: definition.id, label: definition.label, required: definition.required, conditional: definition.conditional,
      applicability, validForDays: definition.validForDays, ...(definition.provenance ? { provenance: definition.provenance } : {}),
      confirmedStatus: confirmed?.status ?? "unknown", preparationStatus,
      expiresOn, expiringBeforeAdmission: Boolean(expiresOn && referral.scheduledDate && expiresOn < referral.scheduledDate),
      selfReport: report ? { performedOn: report.performedOn, resultAvailable: report.resultAvailable, recordedAt: report.recordedAt, revision: report.revision, confirmed: verified?.patientReportId === report.id } : null };
  }) };
}
