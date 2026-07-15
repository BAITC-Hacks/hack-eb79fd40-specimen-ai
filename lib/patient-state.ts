import type { ApiFailure, Language } from "@/lib/http";
import { PATIENT } from "@/lib/i18n";

export const PATIENT_STATES = [
  "starting",
  "invalid",
  "start_error",
  "ready",
  "typing",
  "turn_failed",
  "expired",
  "already_completed",
  "rate_wait",
  "nearing_cap",
  "auto_finalized",
  "finalizing",
  "done",
  "emergency",
  "confirming",
] as const;

export function isStartInvalid(failure: ApiFailure): boolean {
  return (
    failure.kind === "http" &&
    ((failure.status === 404 && failure.code === "TOKEN_NOT_FOUND") ||
      (failure.status === 400 && failure.code === "TOKEN_REQUIRED"))
  );
}

export function isSessionCompleted(failure: ApiFailure): boolean {
  return (
    failure.kind === "http" &&
    failure.status === 409 &&
    failure.code === "SESSION_COMPLETED"
  );
}

export function isSessionMissing(failure: ApiFailure): boolean {
  return (
    failure.kind === "http" &&
    failure.status === 404 &&
    failure.code === "SESSION_NOT_FOUND"
  );
}

export function patientFailureText(failure: ApiFailure, language: Language): string {
  const text = PATIENT[language];
  if (failure.kind === "network") return text.networkError;
  if (failure.kind === "timeout") return text.timeoutError;
  if (failure.kind === "bad_json") return text.serviceError;
  if (failure.status === 429) return text.rateLimited;
  if (failure.status >= 500) return text.serviceError;
  return text.badRequest;
}
