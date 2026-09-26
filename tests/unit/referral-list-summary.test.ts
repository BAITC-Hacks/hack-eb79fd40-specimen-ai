import { describe, expect, it } from "vitest";

import { packageGapLines } from "../../app/workspace/referrals/list-summary";
import type { Completeness } from "../../lib/referrals/types";

const completeness = (patch: Partial<Completeness> = {}): Completeness => ({
  status: "incomplete",
  evaluatedOn: "2026-09-26",
  basis: "scheduled_date",
  catalogueVersion: "test",
  catalogueAvailable: true,
  catalogueValidated: true,
  catalogueStatus: "available",
  entries: [],
  ...patch,
});

describe("referral list package gaps", () => {
  it("names missing and expired positions without dumping a long checklist", () => {
    expect(packageGapLines(completeness({ entries: [
      { requirementId: "a", label: "Общий анализ крови", required: true, status: "missing", expiresOn: null },
      { requirementId: "b", label: "ЭКГ", required: true, status: "missing", expiresOn: null },
      { requirementId: "c", label: "Флюорография", required: true, status: "missing", expiresOn: null },
      { requirementId: "d", label: "Консультация", required: false, status: "expired", expiresOn: "2026-09-20" },
    ] }))).toEqual([
      "Нет: Общий анализ крови, ЭКГ +1",
      "Просрочено: Консультация",
    ]);
  });

  it("keeps an unvalidated catalogue fail-closed", () => {
    expect(packageGapLines(completeness({
      status: "unknown",
      catalogueAvailable: false,
      catalogueValidated: false,
      entries: [{ requirementId: "a", label: "Общий анализ крови", required: true, status: "unknown", expiresOn: null }],
    }))).toEqual(["Перечень ожидает проверки врачом"]);
  });
});
