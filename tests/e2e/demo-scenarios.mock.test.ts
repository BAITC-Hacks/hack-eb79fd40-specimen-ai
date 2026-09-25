import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTriageInvariants } from "../contract/invariants";
import { normalizeAnamnesis, type ChatMessage, type TriageResult } from "../../lib/types";
import { ABSTAIN_HYPOTHESIS } from "../../lib/triage";

interface MockFixture {
  schema_version: number;
  provenance: string;
  live_verified: boolean;
  scenario: { id: string; title: string };
  completed_via: string;
  http: { path: string; status: number }[];
  messages: ChatMessage[];
  result: TriageResult;
}

const CASES = [
  "scenario-1-chest-pain",
  "scenario-2-back-pain",
  "scenario-3-rhinitis",
] as const;

function fixture(id: typeof CASES[number]): MockFixture {
  const path = resolve(`tests/fixtures/transcripts/${id}.mock.json`);
  return JSON.parse(readFileSync(path, "utf8")) as MockFixture;
}

describe("offline HTTP demo scenarios", () => {
  it.each(CASES)("stores an honest and contract-valid mock transcript: %s", (id) => {
    const current = fixture(id);

    expect(current.schema_version).toBe(1);
    expect(current.provenance).toBe("mock");
    expect(current.live_verified).toBe(false);
    expect(current.completed_via).toBe("chat");
    expect(current.http.length).toBeGreaterThanOrEqual(4);
    expect(current.http.every(({ status }) => status === 200)).toBe(true);
    expect(current.http.some(({ status }) => [400, 429, 500].includes(status))).toBe(false);
    expect(current.messages[0]?.role).toBe("assistant");
    assertTriageInvariants(current.result, current.messages);
  });

  it("meets the emergency chest-pain scenario contract", () => {
    const { result } = fixture("scenario-1-chest-pain");

    expect(result.red_flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "chest_pain",
          emergency: true,
          evidence_kind: "quote",
        }),
      ]),
    );
    expect(result.urgency).toBe("emergency");
    expect(result.routing).toEqual([
      { specialty: "скорая/приёмный покой", confidence: 0 },
    ]);
  });

  it("completes the back-pain scenario without an emergency", () => {
    const { result } = fixture("scenario-2-back-pain");
    const anamnesis = normalizeAnamnesis(result.anamnesis);

    expect(result.urgency).not.toBe("emergency");
    expect(result.red_flags.every((flag) => !flag.emergency)).toBe(true);
    expect(anamnesis.history_status).toMatchObject({
      chronic: "denied",
      allergies: "denied",
      medications: "denied",
    });
    expect(anamnesis.negative_findings).toEqual([
      "температуры нет",
      "ноги не немеют",
      "мочеиспускание не нарушено",
    ]);
  });

  it("keeps the one-day rhinitis scenario low-priority and flag-free", () => {
    const { result } = fixture("scenario-3-rhinitis");

    expect(["routine", "planned"]).toContain(result.urgency);
    expect(result.red_flags).toEqual([]);
  });

  it.each(CASES)("does not turn an abstain into a complaint paraphrase: %s", (id) => {
    const { result } = fixture(id);

    expect(result.model?.abstained).toBe(true);
    expect(result.hypothesis).toMatchObject({
      text: ABSTAIN_HYPOTHESIS,
      confidence: 0,
    });
    expect(result.hypothesis.text).not.toContain(result.anamnesis.chief_complaint);
  });

  it.each(CASES)("keeps patient-facing replies neutral in scenario %s", (id) => {
    const { messages } = fixture(id);
    const assistantReplies = messages
      .filter(({ role }) => role === "assistant")
      .map(({ content }) => content)
      .join(" ");

    expect(assistantReplies).not.toMatch(/похоже\s+на|обычн\p{L}*\s+простуд/iu);
  });
});
