import catalogue from "../../data/examination_requirements.json";

// Закрытый продуктовый срез Приложения 5 в редакции приказа от 17.02.2025 № 9.
// Справочник остаётся validated=false до фактической проверки врачом больницы.
export const GENERAL_REQUIREMENT_IDS = [
  "cbc", "urinalysis", "biochem", "biochem_extra", "coagulogram", "ecg", "hiv",
  "hepatitis", "fluorography", "microreaction", "therapist", "specialists", "fgds",
] as const;

export const CLOSED_REFERRAL_PROFILES = [
  "Хирургический",
  "Урологический",
  "Гинекологический",
  "Кардиохирургический",
  "Травматологический и ортопедический",
  "Офтальмологический",
  "Сосудистая хирургия",
  "Онкологический и радиологический",
] as const;

const catalogueProfiles = catalogue.profiles.map((entry) => entry.profile);
if (JSON.stringify(catalogueProfiles) !== JSON.stringify(CLOSED_REFERRAL_PROFILES)
  || catalogue.profiles.some((profile) => JSON.stringify(profile.requirements.slice(0, GENERAL_REQUIREMENT_IDS.length).map((item) => item.id)) !== JSON.stringify(GENERAL_REQUIREMENT_IDS))) {
  throw new Error("Examination catalogue must contain the closed profile set with the common 13-item package");
}

export const REFERRAL_PROFILES: readonly string[] = CLOSED_REFERRAL_PROFILES;
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
