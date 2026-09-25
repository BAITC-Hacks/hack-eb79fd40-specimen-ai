import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLink,
  finalizeChat,
  isTriageResult,
  sendChat,
  startChat,
} from "../../lib/http";
import { FRONTEND_RESULT } from "../fixtures/frontend-result";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("frontend API adapter", () => {
  it("creates a link with the optional doctor header and accepts an opaque token", async () => {
    const fetchMock = vi.fn(async () => json({ token: "opaque-token/value" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createLink("doctor-code")).resolves.toEqual({
      ok: true,
      data: { token: "opaque-token/value" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/link",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-doctor-code": "doctor-code" }),
      }),
    );
  });

  it("sends canonical language and requires a non-empty session and integer turnsLeft", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: "session-any-shape", reply: "Сәлем", turnsLeft: 20 }))
      .mockResolvedValueOnce(json({ sessionId: "", reply: "Сәлем", turnsLeft: 20 }))
      .mockResolvedValueOnce(json({ sessionId: "ok", reply: "Сәлем", turnsLeft: 19.5 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startChat("token", "kk")).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      token: "token",
      language: "kk",
    });
    await expect(startChat("token", "kk")).resolves.toEqual({
      ok: false,
      failure: { kind: "bad_json" },
    });
    await expect(startChat("token", "kk")).resolves.toEqual({
      ok: false,
      failure: { kind: "bad_json" },
    });
  });

  it("enforces done/closing coherence and rejects clinical result leakage", async () => {
    const closing = { emergency: false, text: "Спасибо. Ответы переданы врачу." };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ reply: "ещё", done: false, turnsLeft: 19 }))
        .mockResolvedValueOnce(json({ reply: "готово", done: true, turnsLeft: 0 }))
        .mockResolvedValueOnce(json({ reply: "ещё", done: false, turnsLeft: 18, closing }))
        .mockResolvedValueOnce(json({ reply: "готово", done: true, turnsLeft: 0, closing }))
        .mockResolvedValueOnce(json({ reply: "готово", done: true, turnsLeft: 0, closing, result: FRONTEND_RESULT })),
    );

    await expect(sendChat("session", "text")).resolves.toMatchObject({ ok: true });
    await expect(sendChat("session", "text")).resolves.toEqual({ ok: false, failure: { kind: "bad_json" } });
    await expect(sendChat("session", "text")).resolves.toEqual({ ok: false, failure: { kind: "bad_json" } });
    await expect(sendChat("session", "text")).resolves.toMatchObject({
      ok: true,
      data: { done: true, closing },
    });
    await expect(sendChat("session", "text")).resolves.toEqual({ ok: false, failure: { kind: "bad_json" } });
  });

  it("accepts only the patient-safe finalize response", async () => {
    const closing = { emergency: true, text: "Немедленно обратитесь за экстренной помощью." };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ closing, replayed: true }))
        .mockResolvedValueOnce(json({ closing, replayed: true, result: FRONTEND_RESULT }))
        .mockResolvedValueOnce(json({ closing, replayed: true, source: "rules_only" })),
    );
    await expect(finalizeChat("session")).resolves.toMatchObject({ ok: true });
    await expect(finalizeChat("session")).resolves.toEqual({ ok: false, failure: { kind: "bad_json" } });
    await expect(finalizeChat("session")).resolves.toEqual({ ok: false, failure: { kind: "bad_json" } });
  });

  it("keeps strict TriageResult validation for authenticated doctor surfaces", () => {
    const model = {
      pathologies: [],
      top_contributions: [],
      abstained: false,
      model_version: "lr-v1",
    };
    expect(isTriageResult({ ...FRONTEND_RESULT, model })).toBe(false);
    expect(isTriageResult({ ...FRONTEND_RESULT, source: "model" })).toBe(false);
  });

  it("rejects a doctor result that violates emergency dominance", () => {
    expect(isTriageResult({ ...FRONTEND_RESULT, urgency: "planned" })).toBe(false);
  });

  it.each([
    ["unknown intensity", null, true],
    ["explicit zero", 0, true],
    ["maximum ten", 10, true],
    ["fraction", 7.5, false],
    ["below range", -1, false],
    ["above range", 11, false],
    ["string", "7", false],
    ["missing field", undefined, false],
  ])(
    "validates anamnesis severity at the frontend boundary: %s",
    (_label, severity, accepted) => {
      const result = {
        ...FRONTEND_RESULT,
        anamnesis: {
          ...FRONTEND_RESULT.anamnesis,
          symptom: { ...FRONTEND_RESULT.anamnesis.symptom, severity },
        },
      };
      expect(isTriageResult(result)).toBe(accepted);
    },
  );

  it("rejects a non-finite severity", () => {
    const result = structuredClone(FRONTEND_RESULT);
    result.anamnesis.symptom.severity = Number.NaN;
    expect(isTriageResult(result)).toBe(false);
  });

  it.each([
    [
      "rules_only confidence is non-zero",
      {
        ...FRONTEND_RESULT,
        hypothesis: { ...FRONTEND_RESULT.hypothesis, confidence: 0.2 },
      },
    ],
    [
      "llm_fallback confidence exceeds 0.5",
      {
        ...FRONTEND_RESULT,
        source: "llm_fallback" as const,
        hypothesis: { ...FRONTEND_RESULT.hypothesis, confidence: 0.8 },
      },
    ],
    [
      "model confidence differs from top-1 probability",
      {
        ...FRONTEND_RESULT,
        source: "model" as const,
        hypothesis: { ...FRONTEND_RESULT.hypothesis, confidence: 0.3 },
        model: {
          pathologies: [{ code: "p", label_ru: "Состояние", prob: 0.8 }],
          top_contributions: [],
          abstained: false,
          model_version: "lr-v1",
        },
      },
    ],
    [
      "disclaimer omits the mandatory warning",
      {
        ...FRONTEND_RESULT,
        hypothesis: { ...FRONTEND_RESULT.hypothesis, disclaimer: "Решение принимает врач." },
      },
    ],
  ])("rejects a malformed triage result: %s", (_name, result) => {
    expect(isTriageResult(result)).toBe(false);
  });

  it("preserves public error metadata but not server text or PII", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            code: "RATE_LIMITED",
            request_id: "req-public",
            retry_after_ms: 1250,
            error: "upstream secret detail",
            patient: "private",
          },
          { status: 429, headers: { "retry-after": "9" } },
        ),
      ),
    );
    const response = await sendChat("session", "text");
    expect(response).toEqual({
      ok: false,
      failure: {
        kind: "http",
        status: 429,
        code: "RATE_LIMITED",
        requestId: "req-public",
        retryAfterMs: 1250,
      },
    });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(JSON.stringify(response)).not.toContain("private");
  });

  it("uses Retry-After when the body has no delay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": "2" } })));
    await expect(createLink()).resolves.toEqual({
      ok: false,
      failure: { kind: "http", status: 429, code: "RATE_LIMITED", requestId: undefined, retryAfterMs: 2000 },
    });
  });

  it("distinguishes network, timeout and malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    await expect(createLink()).resolves.toEqual({ ok: false, failure: { kind: "network" } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    await expect(createLink()).resolves.toEqual({ ok: false, failure: { kind: "bad_json" } });

    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
      ),
    );
    const pending = createLink();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ ok: false, failure: { kind: "timeout" } });
  });
});
