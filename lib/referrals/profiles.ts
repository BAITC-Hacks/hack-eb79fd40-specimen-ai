import catalogue from "../../data/examination_requirements.json";

// Перечень передан Арданом 18.09; validated=false до проверки врачом больницы.
export const REFERRAL_PROFILES: readonly string[] = catalogue.profiles.map((entry) => entry.profile);
const LEGACY_PROFILE_NAMES = ["Кардиология", "Терапия"] as const;

export function canonicalProfile(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLocaleLowerCase("ru");
  return [...REFERRAL_PROFILES, ...LEGACY_PROFILE_NAMES]
    .find((profile) => profile.toLocaleLowerCase("ru") === lower) ?? trimmed;
}

export function isSelectableProfile(value: string): boolean {
  return REFERRAL_PROFILES.some((profile) => profile === canonicalProfile(value));
}

export function profileDisplayName(value: string): string {
  const canonical = canonicalProfile(value);
  return isSelectableProfile(canonical) ? canonical : `${canonical} · профиль до справочника`;
}

export function normalizeIcd10Code(value: string | null | undefined): string | null {
  return value?.trim().toUpperCase() || null;
}

export function validIcd10Code(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || (typeof value === "string" && /^[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?$/u.test(value));
}
