import { describe, expect, it } from "vitest";
import { isOperationallyDelayed } from "../../app/workspace/operational-delay";

describe("operational delay", () => {
  const active = { cancelled: false, attendance: null, observedStageDays: 4.5 };

  it("flags active referrals only after the chosen threshold", () => {
    expect(isOperationallyDelayed(active, "4")).toBe(true);
    expect(isOperationallyDelayed(active, "4.5")).toBe(false);
    expect(isOperationallyDelayed(active, "")).toBe(false);
  });

  it("keeps unknown times and closed referrals out of the delayed list", () => {
    expect(isOperationallyDelayed({ ...active, observedStageDays: null }, "0")).toBe(false);
    expect(isOperationallyDelayed({ ...active, cancelled: true }, "0")).toBe(false);
    expect(isOperationallyDelayed({ ...active, attendance: "attended" }, "0")).toBe(false);
  });
});
