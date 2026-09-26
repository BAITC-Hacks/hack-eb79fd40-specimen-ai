import { describe, expect, it } from "vitest";
import { DEFAULT_REQUIREMENTS } from "../../lib/referrals/requirements";
import {
  canonicalProfile,
  CLOSED_REFERRAL_PROFILES,
  GENERAL_REQUIREMENT_IDS,
  profileDisplayName,
  REFERRAL_PROFILES,
} from "../../lib/referrals/profiles";

describe("legacy referral profile labels", () => {
  it("normalizes case-only legacy variants without inventing a catalogue mapping", () => {
    expect(canonicalProfile(" кардиология ")).toBe("Кардиология");
    expect(profileDisplayName("кардиология")).toBe("Кардиология · профиль до справочника");
    expect(profileDisplayName("Хирургия")).toBe("Хирургия · профиль до справочника");
  });

  it("keeps current catalogue profiles unchanged", () => {
    expect(profileDisplayName("Хирургический")).toBe("Хирургический");
  });

  it("pins Appendix 5 revision 17.02.2025 No. 9 to eight closed profiles", () => {
    expect(DEFAULT_REQUIREMENTS.version).toBe("2025-02-17-order-9-appendix-5");
    expect(DEFAULT_REQUIREMENTS.source).toMatch(/Приложение 5/u);
    expect(DEFAULT_REQUIREMENTS.source).toMatch(/17\.02\.2025 № 9/u);
    expect(DEFAULT_REQUIREMENTS.validated).toBe(false);
    expect(REFERRAL_PROFILES).toEqual(CLOSED_REFERRAL_PROFILES);
    expect(REFERRAL_PROFILES).toHaveLength(8);
  });

  it("keeps the common 13-item package and item-level freshness in every profile", () => {
    for (const profile of DEFAULT_REQUIREMENTS.profiles) {
      expect(profile.requirements.slice(0, 13).map((item) => item.id)).toEqual(GENERAL_REQUIREMENT_IDS);
      expect(profile.requirements.every((item) => Object.hasOwn(item, "validForDays"))).toBe(true);
    }
  });

  it("does not map examination packages from ICD codes", () => {
    expect(JSON.stringify(DEFAULT_REQUIREMENTS)).not.toMatch(/(?:icd|мкб)/iu);
  });
});
