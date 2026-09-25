import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DoctorPanel from "../../app/c/[token]/DoctorPanel";
import { ABSTAIN_HYPOTHESIS } from "../../lib/triage";
import {
  normalizeAnamnesis,
  type LegacyAnamnesis,
  type TriageResult,
} from "../../lib/types";

function legacyAnamnesis(): LegacyAnamnesis {
  return {
    chief_complaint: "жалоба из старой сводки",
    symptom: {
      onset: "",
      location: "",
      quality: "",
      severity: null,
      modifiers: "",
      associated: [],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: {
      age: null,
      sex: "unknown",
      pregnancy: "na",
      risk_factors: [],
    },
  };
}

function scenarioTwo(): TriageResult {
  const fixture = JSON.parse(
    readFileSync(
      resolve("tests/fixtures/transcripts/scenario-2-back-pain.mock.json"),
      "utf8",
    ),
  ) as { result: TriageResult };
  return fixture.result;
}

describe("ClickUp A clinical-safety contract", () => {
  it("normalizes old empty arrays as not stated rather than denied", () => {
    const normalized = normalizeAnamnesis(legacyAnamnesis());

    expect(normalized.history_status).toEqual({
      past_history: "not_stated",
      chronic: "not_stated",
      allergies: "not_stated",
      medications: "not_stated",
    });
    expect(normalized.negative_findings).toEqual([]);
  });

  it("renders explicit denials separately from absent answers", () => {
    const html = renderToStaticMarkup(<DoctorPanel result={scenarioTwo()} />);

    expect(html).toContain("Хроника</dt><dd>отрицает");
    expect(html).toContain("Аллергии</dt><dd>отрицает");
    expect(html).toContain("Препараты</dt><dd>отрицает");
    expect(html).toContain("Явно отрицает");
    expect(html).toContain("температуры нет");
    expect(html).toContain("ноги не немеют");
    expect(html).toContain("мочеиспускание не нарушено");
  });

  it("renders an abstain as no hypothesis and without a confidence claim", () => {
    const result = scenarioTwo();
    const html = renderToStaticMarkup(<DoctorPanel result={result} />);

    expect(result.hypothesis).toMatchObject({
      text: ABSTAIN_HYPOTHESIS,
      confidence: 0,
    });
    expect(html).toContain(ABSTAIN_HYPOTHESIS);
    expect(html).toContain("гипотеза не сформирована");
    expect(html).not.toContain("Уверенность ограничена");
    const hypothesisBlock = html.slice(
      html.indexOf("<h2>Предварительная гипотеза</h2>"),
      html.indexOf('<div class="abstain">'),
    );
    expect(hypothesisBlock).not.toContain(result.anamnesis.chief_complaint);
  });
});
