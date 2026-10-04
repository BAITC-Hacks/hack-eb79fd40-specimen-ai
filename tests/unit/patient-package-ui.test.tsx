// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Preparation from "../../app/p/Preparation";
import type { PatientPackage } from "../../lib/referrals/types";
const navigation = vi.hoisted(() => ({ token: "abcdef0123456789" }));
const http = vi.hoisted(() => ({ startChat: vi.fn(), resumeChat: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ token: navigation.token }) }));
vi.mock("@/lib/http", async (original) => ({ ...await original<typeof import("../../lib/http")>(), ...http }));
import PatientChat from "../../app/c/[token]/page";
import PreparationLink from "../../app/p/[token]/page";

const accessId = "40a9e02e-5d33-404a-91fc-6fa5b168a1e9";
const payload = (): PatientPackage => ({ accessId, expiresAt: Date.parse("2026-11-03T08:00:00Z"), state: "preparing", patientLabel: "Тестовый эпизод", scheduledDate: "2026-10-20", destinationOrganization: "Тестовая больница", catalogueVersion: "fixture-v1", catalogueSource: "test-only", catalogueValidated: false, catalogueAvailable: false, careContext: "operative", evaluatedOn: "2026-10-20", confirmedCompleteness: "unknown",
  items: [{ requirementId: "r1", label: "Общий анализ крови", required: true, conditional: false, applicability: "yes", validForDays: 7, confirmedStatus: "unknown", preparationStatus: "missing", expiresOn: null, expiringBeforeAdmission: false, selfReport: null },
    { requirementId: "r2", label: "По показаниям", required: false, conditional: true, applicability: "unknown", validForDays: 10, confirmedStatus: "unknown", preparationStatus: "unknown", expiresOn: null, expiringBeforeAdmission: false, selfReport: null },
    { requirementId: "r3", label: "Требует уточнения", required: null, conditional: false, applicability: "unknown", validForDays: null, confirmedStatus: "unknown", preparationStatus: "unknown", expiresOn: null, expiringBeforeAdmission: false, selfReport: null }] });
const response = (data: PatientPackage) => Response.json({ package: data });
let root: Root;
let container: HTMLDivElement;
async function render(element: React.ReactNode) { await act(async () => { root.render(element); }); }
const buttons = () => [...container.querySelectorAll("button")];
const button = (text: string) => buttons().find((entry) => entry.textContent?.includes(text))!;
async function submit() {
  const form = container.querySelector<HTMLFormElement>("form")!;
  const input = form.querySelector<HTMLInputElement>('input[name="performedOn"]')!;
  input.value = "2026-10-01";
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  navigation.token = "abcdef0123456789";
  vi.stubGlobal("fetch", vi.fn(async () => response(payload())));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("patient package usable states", () => {
  it("renders RU/KK checklist, honest validation, conditional lock and locale PDF without clinical data", async () => {
    await render(<Preparation accessId={accessId} initialPackage={payload()} />);
    expect(container.textContent).toContain("Перечень ещё не проверен врачом");
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.textContent).not.toContain("Необязательное"); // null is unknown, conditional is explicitly conditional
    expect(container.querySelector('a[href*="format=pdf"]')?.getAttribute("href")).toContain("lang=ru");
    await act(async () => button("Қаз").click());
    expect(container.textContent).toContain("Тексерулерге дайындық");
    expect(container.querySelector('a[href*="format=pdf"]')?.getAttribute("href")).toContain("lang=kk");
    for (const hidden of ["гипотеза", "риск отказа", "anamnesis", "triageSnapshot", "capabilityHash"]) expect(container.textContent).not.toContain(hidden);
  });
  it("shows pending direction without PDF/form, cancellation disables claims", async () => {
    const awaiting = { ...payload(), state: "awaiting_referral" as const, items: [] };
    await render(<Preparation accessId={accessId} initialPackage={awaiting} />);
    expect(container.textContent).toContain("Повторно проходить опрос не нужно");
    expect(container.querySelector("form")).toBeNull(); expect(container.querySelector('a[href*="pdf"]')).toBeNull();
    await render(<Preparation key="cancelled" accessId={accessId} initialPackage={{ ...payload(), state: "cancelled" }} />);
    expect(container.textContent).toContain("Направление отменено"); expect(container.querySelector("form")).toBeNull();
  });
  it("recovers from network failure with retry and preserves accessible status/alert", async () => {
    const fetchMock = vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await render(<Preparation accessId={accessId} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось открыть пакет");
    await act(async () => button("Обновить список").click());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Общий анализ крови");
  });
  it("keeps idempotency key on lost-save retry, confirms successful self-report is not verified", async () => {
    const updated = payload(); updated.items[0].selfReport = { performedOn: "2026-10-01", resultAvailable: true, recordedAt: Date.now(), revision: 1, confirmed: false };
    updated.items[0].preparationStatus = "present";
    const fetchMock = vi.mocked(fetch).mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce(response(updated));
    await render(<Preparation accessId={accessId} initialPackage={payload()} />);
    await submit(); expect(container.textContent).toContain("Не удалось сохранить");
    await submit(); expect(container.textContent).toContain("Отметка сохранена");
    expect(container.textContent).toContain("Со слов пациента — ожидает проверки врача");
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const retry = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(first.idempotencyKey).toBe(retry.idempotencyKey); expect(first.expectedRevision).toBe(0);
    expect(retry).not.toHaveProperty("expiresOn");
  });
  it("deduplicates rapid submits and ignores response after episode unmount", async () => {
    let resolve: (value: Response) => void = () => undefined;
    const fetchMock = vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render(<Preparation key="first" accessId={accessId} initialPackage={payload()} />);
    const form = container.querySelector<HTMLFormElement>("form")!;
    form.querySelector<HTMLInputElement>("input")!.value = "2026-10-01";
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const other = { ...payload(), accessId: "other-id", patientLabel: "Другой пациент" };
    await render(<Preparation key="second" accessId="other-id" initialPackage={other} />);
    await act(async () => resolve(response(payload())));
    expect(container.textContent).toContain("Другой пациент"); expect(container.textContent).not.toContain("Тестовый эпизод");
  });
  it("refreshes actual revision conflicts and preserves unsaved form; business409 isn't described as another tab", async () => {
    const fresh = payload(); fresh.items[0].selfReport = { performedOn: "2026-09-30", resultAvailable: true, recordedAt: Date.now(), revision: 1, confirmed: false };
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "REVISION_CONFLICT" }, { status: 409 })).mockResolvedValueOnce(response(fresh));
    await render(<Preparation accessId={accessId} initialPackage={payload()} />);
    await submit(); expect(container.textContent).toContain("в другой вкладке");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("2026-10-01");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(Response.json({ code: "APPLICABILITY_UNCONFIRMED" }, { status: 409 }));
    await submit(); expect(container.textContent).not.toContain("в другой вкладке"); expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("renders confirmed report honestly", async () => {
    const confirmed = payload(); confirmed.items[0].selfReport = { performedOn: "2026-10-01", resultAvailable: true, recordedAt: Date.now(), revision: 1, confirmed: true };
    await render(<Preparation accessId={accessId} initialPackage={confirmed} />);
    expect(container.textContent).toContain("Врач подтвердил эту отметку"); expect(container.textContent).not.toContain("ожидает проверки врача");
  });
});

describe("patient preparation access continuity", () => {
  it("original chat URL opens package after chat cleanup and browser storage loss via capability-bound discovery", async () => {
    await render(<PatientChat />);
    expect(container.textContent).toContain("Общий анализ крови");
    expect(http.startChat).not.toHaveBeenCalled(); expect(http.resumeChat).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/patient/discover");
    expect(window.localStorage.getItem(`demeu:preparation:${navigation.token}`)).toBe(accessId);
  });
  it("exchanges unique link on another browser and scrubs bearer from address; reload uses access ID", async () => {
    navigation.token = "x".repeat(43);
    window.history.replaceState({}, "", `/p/${navigation.token}`);
    await render(<PreparationLink />);
    expect(window.location.pathname).toBe(`/p/${accessId}`);
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/patient/access");
    expect(fetchMock.mock.calls[0][1]?.referrerPolicy).toBe("no-referrer");
    navigation.token = accessId;
    await render(<PreparationLink key="reload" />);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`/api/patient/${accessId}/package`);
  });
});
