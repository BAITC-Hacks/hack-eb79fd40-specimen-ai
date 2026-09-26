// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATIENT } from "../../lib/i18n";

const httpMocks = vi.hoisted(() => ({
  startChat: vi.fn(async () => ({
    ok: true as const,
    data: { sessionId: "session-from-first-click", reply: "Начинаем опрос", turnsLeft: 20 },
  })),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ token: "doctor-token" }) }));
vi.mock("@/lib/http", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/http")>(),
  startChat: httpMocks.startChat,
}));

import PatientChat from "../../app/c/[token]/page";

describe("patient consent hydration", () => {
  let root: Root | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    httpMocks.startChat.mockResolvedValue({
      ok: true as const,
      data: { sessionId: "session-from-first-click", reply: "Начинаем опрос", turnsLeft: 20 },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/c/doctor-token");
    document.body.innerHTML = "";
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
  });

  it("hydrates five fresh bootstraps and starts once from every first visible consent click", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const container = document.createElement("div");
      container.innerHTML = renderToString(<PatientChat />);
      document.body.append(container);

      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(container.textContent).not.toContain(PATIENT.ru.consentAction);

      await act(async () => {
        root = hydrateRoot(container, <PatientChat />);
      });

      const button = [...container.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.includes(PATIENT.ru.consentAction));
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect((button as HTMLButtonElement).disabled).toBe(false);

      await act(async () => {
        (button as HTMLButtonElement).click();
      });

      expect(httpMocks.startChat).toHaveBeenCalledTimes(attempt);
      expect(httpMocks.startChat).toHaveBeenLastCalledWith("doctor-token", "ru");
      expect(container.textContent).toContain("Начинаем опрос");

      await act(async () => root?.unmount());
      root = undefined;
      container.remove();
      window.sessionStorage.clear();
    }
  });

  it("deduplicates rapid consent clicks before the first start request settles", async () => {
    let release: (() => void) | undefined;
    httpMocks.startChat.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({
        ok: true as const,
        data: { sessionId: "session-from-first-click", reply: "Начинаем опрос", turnsLeft: 20 },
      });
    }));
    const container = document.createElement("div");
    container.innerHTML = renderToString(<PatientChat />);
    document.body.append(container);
    await act(async () => { root = hydrateRoot(container, <PatientChat />); });
    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes(PATIENT.ru.consentAction)) as HTMLButtonElement;

    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(httpMocks.startChat).toHaveBeenCalledOnce();

    await act(async () => { release?.(); });
    expect(container.textContent).toContain("Начинаем опрос");
  });

  it("shows a retryable safe state when the first start request fails", async () => {
    httpMocks.startChat.mockResolvedValueOnce({
      ok: false,
      failure: { kind: "network" },
    } as never);
    const container = document.createElement("div");
    container.innerHTML = renderToString(<PatientChat />);
    document.body.append(container);
    await act(async () => { root = hydrateRoot(container, <PatientChat />); });
    const consent = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes(PATIENT.ru.consentAction)) as HTMLButtonElement;

    await act(async () => { consent.click(); });

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain(PATIENT.ru.startErrorTitle);
    const retry = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes(PATIENT.ru.retry));
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });
});
