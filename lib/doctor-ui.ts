import type { ApiFailure } from "@/lib/http";

export function isDoctorUnauthorized(failure: ApiFailure): boolean {
  return (
    failure.kind === "http" &&
    failure.status === 401 &&
    failure.code === "UNAUTHORIZED"
  );
}

export function buildPatientLink(origin: string, token: string): string {
  return `${origin}/c/${encodeURIComponent(token)}`;
}

export function decodePatientToken(decodeSegment: () => string): string | null {
  try {
    return decodeSegment();
  } catch {
    return null;
  }
}
