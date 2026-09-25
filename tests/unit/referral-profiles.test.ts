import { describe, expect, it } from "vitest";
import { canonicalProfile, profileDisplayName } from "../../lib/referrals/profiles";

describe("legacy referral profile labels", () => {
  it("normalizes case-only legacy variants without inventing a catalogue mapping", () => {
    expect(canonicalProfile(" кардиология ")).toBe("Кардиология");
    expect(profileDisplayName("кардиология")).toBe("Кардиология · профиль до справочника");
    expect(profileDisplayName("Хирургия")).toBe("Хирургия · профиль до справочника");
  });

  it("keeps current catalogue profiles unchanged", () => {
    expect(profileDisplayName("Хирургический")).toBe("Хирургический");
  });
});
