import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DesignSystemPage from "../../app/ds/page";
import DoctorPanel from "../../app/c/[token]/DoctorPanel";
import PatientErrorBoundary from "../../app/c/[token]/error";
import {
  ConsentScreen,
  InputWidgetChoices,
  PatientFinale,
  PatientMasthead,
  TerminalState,
} from "../../app/c/[token]/patient-components";
import { PATIENT } from "../../lib/i18n";
import { PATIENT_STATES } from "../../lib/patient-state";
import { FRONTEND_RESULT } from "../fixtures/frontend-result";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("Ardan frontend states", () => {
  it("enumerates the 15 patient states and keeps consent before them", () => {
    expect(PATIENT_STATES).toEqual([
      "starting", "invalid", "start_error", "ready", "typing",
      "turn_failed", "expired", "already_completed", "rate_wait",
      "nearing_cap", "auto_finalized", "finalizing", "done",
      "emergency", "confirming",
    ]);
    const html = render(
      createElement(ConsentScreen, {
        language: "ru",
        onConsent: () => undefined,
      }),
    );
    expect(html).toContain(PATIENT.ru.consentTitle);
    expect(html).toContain(PATIENT.ru.consentAction);
    expect(html).not.toContain("/api/");
  });

  it("renders full Kazakh consent and a language switch", () => {
    const consent = render(
      createElement(ConsentScreen, { language: "kk", onConsent: () => undefined }),
    );
    const masthead = render(
      createElement(PatientMasthead, {
        language: "kk",
        canChangeLanguage: true,
        onLanguage: () => undefined,
      }),
    );
    expect(consent).toContain("Келісемін");
    expect(consent).toContain("Бұл диагноз емес");
    expect(masthead).toContain("ҚАЗ");
    expect(masthead).toContain('aria-pressed="true"');
  });

  it("renders invalid and render-failure states instead of an empty screen", () => {
    const terminal = render(
      createElement(TerminalState, {
        title: PATIENT.ru.invalidTitle,
        body: PATIENT.ru.invalidBody,
      }),
    );
    const boundary = render(createElement(PatientErrorBoundary, { reset: () => undefined }));
    expect(terminal).toContain(PATIENT.ru.invalidTitle);
    expect(terminal).not.toContain("textarea");
    expect(boundary).toContain(PATIENT.ru.startErrorTitle);
    expect(boundary).toContain(PATIENT.ru.retry);
  });

  it("offers heuristic widgets while retaining free-text copy", () => {
    const scale = render(
      createElement(InputWidgetChoices, {
        reply: "Оцените силу боли от 0 до 10",
        language: "ru",
        disabled: false,
        onChoose: () => undefined,
      }),
    );
    const chips = render(
      createElement(InputWidgetChoices, {
        reply: "Одышка появляется даже в покое?",
        language: "ru",
        disabled: false,
        onChoose: () => undefined,
      }),
    );
    expect(scale).toContain("0–10");
    expect(scale).toContain(">10<");
    expect(chips).toContain(">Да<");
    expect(chips).toContain(">Нет<");
    expect(chips).toContain(PATIENT.ru.freeText);
  });

  it("shows one 103 action to the patient and no clinical summary", () => {
    const html = render(createElement(PatientFinale, { language: "ru", emergency: true }));
    expect(html).toContain('href="tel:103"');
    expect(html.match(/tel:103/g)).toHaveLength(1);
    expect(html).toContain(PATIENT.ru.emTitle);
    expect(html).not.toContain("Маршрутизация");
    expect(html).not.toContain("Предварительная гипотеза");
  });

  it("renders a doctor panel only from the supplied factual result", () => {
    const html = render(createElement(DoctorPanel, { result: FRONTEND_RESULT }));
    expect(html).toContain("Сводка для врача");
    expect(html).toContain("Маршрут не определён");
    expect(html).toContain(FRONTEND_RESULT.hypothesis.disclaimer);
    expect(html).toContain("только правила");
  });

  it("shows numeric routing only for the model source", () => {
    const model = structuredClone(FRONTEND_RESULT);
    model.source = "model";
    model.hypothesis.confidence = 0.72;
    model.model = {
      pathologies: [
        { code: "p1", label_ru: "Кардиологическое состояние", prob: 0.72 },
      ],
      top_contributions: [
        { feature: "E_14", label_ru: "боль в груди", contribution: 1.2 },
      ],
      abstained: false,
      model_version: "test-lr-v1",
    };
    const fallback = structuredClone(FRONTEND_RESULT);
    fallback.source = "llm_fallback";
    fallback.routing = [{ specialty: "скорая/приёмный покой", confidence: 0 }];
    fallback.hypothesis.confidence = 0.35;
    fallback.model = {
      pathologies: [],
      top_contributions: [],
      abstained: true,
      abstain_reason: "low_confidence",
      model_version: "test-lr-v1",
    };

    const modelHtml = render(createElement(DoctorPanel, { result: model }));
    const fallbackHtml = render(createElement(DoctorPanel, { result: fallback }));

    expect(modelHtml).toContain("72%");
    expect(modelHtml).toContain('class="bar"');
    expect(fallbackHtml).toContain("скорая/приёмный покой");
    expect(fallbackHtml).toContain(
      "Ориентировочный маршрут, без числовой оценки",
    );
    expect(fallbackHtml).not.toContain('class="bar"');
    expect(fallbackHtml).not.toContain('class="pct"');
    expect(fallbackHtml).not.toContain("0%");
  });

  it("shows an em dash for unknown intensity and preserves an explicit zero", () => {
    const unknown = structuredClone(FRONTEND_RESULT);
    unknown.anamnesis.symptom.severity = null;
    const zero = structuredClone(FRONTEND_RESULT);
    zero.anamnesis.symptom.severity = 0;

    expect(render(createElement(DoctorPanel, { result: unknown }))).toContain(
      "<dt>Сила</dt><dd>—</dd>",
    );
    expect(render(createElement(DoctorPanel, { result: zero }))).toContain(
      "<dt>Сила</dt><dd>0/10</dd>",
    );
  });

  it("exposes a network-free design-system surface", () => {
    const html = render(createElement(DesignSystemPage));
    expect(html).toContain("#16604a");
    expect(html).toContain("#a83326");
    expect(html).toContain("15 состояниями");
    expect(html).not.toContain("fetch(");
  });
});
