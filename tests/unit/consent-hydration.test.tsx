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
});
