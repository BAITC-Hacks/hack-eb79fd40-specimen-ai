import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ConsentGate,
  TerminalState,
} from "../../app/c/[token]/patient-components";
import { PATIENT } from "../../lib/i18n";

const ROOT = process.cwd();

describe("production-facing cleanup", () => {
  it("does not expose an inert consent action before browser bootstrap is ready", () => {
    const pending = renderToStaticMarkup(
      <ConsentGate ready={false} language="ru" onConsent={vi.fn()} />,
    );
    const ready = renderToStaticMarkup(
      <ConsentGate ready language="ru" onConsent={vi.fn()} />,
    );

    expect(pending).toContain('role="status"');
    expect(pending).not.toContain(PATIENT.ru.consentAction);
    expect(ready).toContain(PATIENT.ru.consentAction);
    expect(ready).not.toContain("disabled");
  });

  it("keeps patient errors actionable without rendering backend details", () => {
    const markup = renderToStaticMarkup(
      <TerminalState
        title="Не удалось открыть опрос"
        body="Безопасное сообщение"
        action="Повторить"
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Безопасное сообщение");
    expect(markup).toContain("Повторить");
  });

  it("retains mobile and IME guards on the patient composer", () => {
    const page = readFileSync(`${ROOT}/app/c/[token]/page.tsx`, "utf8");
    const styles = readFileSync(`${ROOT}/app/globals.css`, "utf8");

    expect(page).toContain("event.nativeEvent.isComposing");
    expect(page).toContain("<textarea");
    expect(page).toContain("maxLength={MAX_MESSAGE_LEN}");
    expect(page).toContain('state: "failed"');
    expect(page).toContain("disabled={sending || retryBlocked}");
    expect(styles).toMatch(/\.composer textarea \{[^}]*font:\s*16px\//u);
    expect(styles).toMatch(/\.send \{[^}]*flex:\s*none/u);
  });

  it("describes Telegram honestly as outbound-only in workspace settings", () => {
    const settings = readFileSync(`${ROOT}/app/workspace/settings/page.tsx`, "utf8");

    expect(settings).toContain("Канал односторонний");
    expect(settings).toContain("ответы боту в кабинет не поступают");
    expect(settings).not.toContain("Бот принимает ответы");
  });

  it("keeps the doctor demo isolated from patient clinical responses", () => {
    const page = readFileSync(`${ROOT}/app/c/[token]/page.tsx`, "utf8");

    expect(page).toContain("localDemo && query.get(\"demo\") === \"1\"");
    expect(page).toContain("<DoctorPanel result={SYNTHETIC_DEMO_RESULT}");
    expect(page).not.toContain("<DoctorPanel result={result}");
  });
});
