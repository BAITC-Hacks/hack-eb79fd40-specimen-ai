import { afterEach, describe, expect, it, vi } from "vitest";

import { finalizeSession } from "../../lib/finalize";
import { MemorySessionStore } from "../../lib/store";
import {
  TelegramClient,
  TelegramDeliveryError,
  TelegramNotifier,
  renderAbortedNotice,
  renderSummary,
  sendDoctorSummary,
  splitForTelegram,
  telegramNotifierFromEnv,
  type TelegramFetch,
} from "../../lib/telegram";
import type {
  ReadonlySession,
  TriageResult,
} from "../../lib/types";

afterEach(() => {
  vi.unstubAllEnvs();
});

function session(result?: TriageResult): ReadonlySession {
  return {
    id: "session-12345678",
    doctorToken: "doctor-token-1234",
    language: "ru",
    messages: [
      { role: "assistant", content: "Болит ли грудь?" },
      { role: "user", content: "Да *_[]<>&" },
    ],
    status: result ? "completed" : "collecting",
    result,
    turnCount: 1,
    deliveryStatus: "pending",
    createdAt: 1_721_000_000_000,
    completedAt: result ? 1_721_000_180_000 : undefined,
  };
}

function result(
  source: TriageResult["source"] = "model",
): TriageResult {
  const model =
    source === "rules_only"
      ? undefined
      : {
          pathologies:
            source === "model"
              ? [
                  {
                    code: "p1",
                    label_ru: "Острое состояние",
                    prob: 0.71,
                  },
                ]
              : [],
          top_contributions:
            source === "model"
              ? [
                  {
                    feature: "f1",
                    label_ru: "боль в груди",
                    contribution: 1.25,
                  },
                ]
              : [],
          abstained: source === "llm_fallback",
          abstain_reason:
            source === "llm_fallback"
              ? ("out_of_label_space" as const)
              : undefined,
          model_version: "lr-v1",
        };

  return {
    anamnesis: {
      chief_complaint: "боль в груди *_[]<>&",
      symptom: {
        onset: "сегодня",
        location: "грудь",
        quality: "давящая",
        severity: 7,
        modifiers: "",
        associated: ["одышка"],
      },
      past_history: [],
      chronic: ["гипертония"],
      allergies: [],
      medications: ["эналаприл"],
      context: {
        age: 58,
        sex: "m",
        pregnancy: "na",
        risk_factors: [],
      },
    },
    red_flags: [
      {
        code: "chest_pain",
        label: "Боль в груди с одышкой",
        evidence: "Да *_[]<>&",
        evidence_kind: "quote",
        emergency: true,
        source_message_index: 1,
        elicited_by: "Болит ли грудь?",
      },
      {
        code: "elderly_severe",
        label: "Возраст 65+ с выраженной болью",
        evidence: "возраст 70, сила 8/10",
        evidence_kind: "derived",
        emergency: false,
        source_message_index: -1,
      },
    ],
    urgency: "emergency",
    urgency_reasons: ["правило emergency имеет приоритет"],
    routing: [{ specialty: "кардиология", confidence: 0.71 }],
    hypothesis: {
      text: "Требуется срочная оценка врача.",
      confidence: source === "model" ? 0.71 : source === "llm_fallback" ? 0.35 : 0,
      disclaimer: "Это предварительная гипотеза, а не диагноз. Решает врач.",
    },
    ...(model ? { model } : {}),
    source,
  };
}

function successfulFetch(
  calls: { input: string | URL | Request; init?: RequestInit }[],
): TelegramFetch {
  return async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("Telegram rendering", () => {
  it.each(["model", "llm_fallback", "rules_only"] as const)(
    "renders required summary sections for source %s",
    (source) => {
      const current = result(source);
      const text = renderSummary(session(current), current);

      expect(text).toContain("НЕОТЛОЖНО");
      expect(text).toContain("КРАСНЫЕ ФЛАГИ");
      expect(text).toContain("сообщение #2");
      expect(text).toContain("«Да *_[]<>&»");
      expect(text).toContain("Вопрос: «Болит ли грудь?»");
      expect(text).toContain("вычислено из анамнеза");
      expect(text).toContain("МАРШРУТИЗАЦИЯ");
      expect(text).toContain("кардиология — 71%");
      expect(text).toContain("ПРЕДВАРИТЕЛЬНАЯ ГИПОТЕЗА");
      expect(text).toContain(current.hypothesis.disclaimer);
      expect(text).toContain("ИСТОЧНИК:");
    },
  );

  it("shows contributions only when the model actually produced them", () => {
    expect(renderSummary(session(result("model")), result("model"))).toContain(
      "ВКЛАД ПРИЗНАКОВ",
    );
    const fallback = renderSummary(
      session(result("llm_fallback")),
      result("llm_fallback"),
    );
    expect(fallback).toContain("МОДЕЛЬ ВОЗДЕРЖАЛАСЬ");
    expect(fallback).not.toContain("ВКЛАД ПРИЗНАКОВ");
    expect(
      renderSummary(session(result("rules_only")), result("rules_only")),
    ).not.toContain("ВКЛАД ПРИЗНАКОВ");
  });

  it("does not claim model uncertainty when no model was run", () => {
    const current = result("llm_fallback");
    delete current.model;

    const text = renderSummary(session(current), current);

    expect(text).toContain("ИСТОЧНИК:");
    expect(text).not.toContain("модель не уверена");
  });

  it("never presents an unverifiable quote as words of the patient", () => {
    const current = result("rules_only");
    current.red_flags = [
      {
        code: "invalid_quote",
        label: "Непроверяемый флаг",
        evidence: "этого пациент не говорил",
        evidence_kind: "quote",
        emergency: true,
        source_message_index: 1,
      },
      {
        code: "empty_quote",
        label: "Пустая цитата",
        evidence: "",
        evidence_kind: "quote",
        emergency: true,
        source_message_index: 1,
      },
    ];

    const text = renderSummary(session(current), current);

    expect(text).not.toContain("«этого пациент не говорил»");
    expect(text).not.toContain("Пустая цитата");
    expect(text).not.toContain("«»");
  });

  it("splits without loss, oversized chunks, or broken surrogate pairs", () => {
    const text = `${"раздел с текстом\n".repeat(30)}${"🚑".repeat(30)}`;
    const chunks = splitForTelegram(text, 64);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    }
  });

  it("renders an aborted notice without analytical result sections", () => {
    const text = renderAbortedNotice({
      sessionId: "s1",
      doctorToken: "doctor1",
      startedAt: 1_721_000_000_000,
      abortedAt: 1_721_000_060_000,
      reason: "ttl_expired",
    });

    expect(text).toContain("пациент начал опрос и не закончил");
    expect(text).toContain("Токен врача: doctor1");
    expect(text).toContain("Причина: ttl_expired");
    expect(text).not.toContain("ГИПОТЕЗА");
    expect(text).not.toContain("МАРШРУТИЗАЦИЯ");
  });
});

describe("Telegram Bot API adapter", () => {
  it("sends every summary chunk as plain text without parse_mode", async () => {
    const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
    const client = new TelegramClient("bot-token", {
      fetcher: successfulFetch(calls),
    });
    const current = result("rules_only");
    current.hypothesis.text = "длинный текст ".repeat(700);
    const expected = renderSummary(session(current), current);

    await sendDoctorSummary(client, "chat-1", session(current), current);

    expect(calls.length).toBeGreaterThan(1);
    const sent = calls.map(({ init }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(calls[0].input.toString()).toBe(
        "https://api.telegram.org/botbot-token/sendMessage",
      );
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/json",
      );
      expect(body.chat_id).toBe("chat-1");
      expect(body).not.toHaveProperty("parse_mode");
      expect(String(body.text).length).toBeLessThanOrEqual(4096);
      return String(body.text);
    });
    expect(sent.join("")).toBe(expected);
  });

  it("sends a supplied PDF as multipart document after the text", async () => {
    const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
    const client = new TelegramClient("bot-token", {
      fetcher: successfulFetch(calls),
    });
    const current = result();

    await sendDoctorSummary(
      client,
      "chat-1",
      session(current),
      current,
      new Uint8Array([37, 80, 68, 70]),
    );

    expect(calls.at(-1)?.input.toString()).toContain("/sendDocument");
    const form = calls.at(-1)?.init?.body;
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("chat_id")).toBe("chat-1");
    const document = (form as FormData).get("document");
    expect(document).toBeInstanceOf(Blob);
    expect((document as Blob).size).toBe(4);
  });

  it("reports non-2xx and Bot API errors", async () => {
    const client = new TelegramClient("bot-token", {
      fetcher: async () =>
        new Response(JSON.stringify({ ok: false, description: "bad chat" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.sendMessage("chat", "text")).rejects.toMatchObject({
      kind: "api",
      message: expect.stringContaining("HTTP 400"),
    });
  });

  it.each([
    {
      label: "HTTP 200 with ok:false",
      response: new Response(JSON.stringify({ ok: false }), { status: 200 }),
    },
    {
      label: "malformed JSON",
      response: new Response("not-json", { status: 200 }),
    },
    {
      label: "non-JSON HTTP error",
      response: new Response("upstream failed", { status: 502 }),
    },
  ])("rejects $label as an API delivery error", async ({ response }) => {
    const client = new TelegramClient("bot-token", {
      fetcher: async () => response.clone(),
    });

    await expect(client.sendMessage("chat", "text")).rejects.toMatchObject({
      kind: "api",
    });
  });

  it("requires both environment values to construct the live notifier", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_ID", undefined);
    expect(telegramNotifierFromEnv()).toBeUndefined();

    vi.stubEnv("TELEGRAM_BOT_TOKEN", "token");
    expect(telegramNotifierFromEnv()).toBeUndefined();

    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_ID", "chat");
    expect(telegramNotifierFromEnv()).toBeInstanceOf(TelegramNotifier);
  });

  it("distinguishes network failures from timeouts", async () => {
    const network = new TelegramClient("bot-token", {
      fetcher: async () => Promise.reject(new Error("offline")),
    });
    await expect(network.sendMessage("chat", "text")).rejects.toMatchObject({
      kind: "network",
    });

    const timeout = new TelegramClient("bot-token", {
      timeoutMs: 5,
      fetcher: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error("missing signal"));
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    });
    await expect(timeout.sendMessage("chat", "text")).rejects.toMatchObject({
      kind: "timeout",
    } satisfies Partial<TelegramDeliveryError>);
  });
});

describe("delivery lifecycle integration", () => {
  it("schedules one completed delivery and marks it sent without blocking finalize", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Болит грудь",
    });
    const current = result("rules_only");
    const send = vi.fn(async () => Promise.resolve());
    const markNotified = vi.spyOn(sessionStore, "markNotified");
    const jobs: (() => Promise<void>)[] = [];

    const first = await finalizeSession(created.id, {
      sessionStore,
      analyze: async () => current,
      doctorSummary: { sendDoctorSummary: send },
      schedule: (work) => jobs.push(work),
    });
    const repeated = await finalizeSession(created.id, {
      sessionStore,
      analyze: async () => current,
      doctorSummary: { sendDoctorSummary: send },
      schedule: (work) => jobs.push(work),
    });

    expect(first.replayed).toBe(false);
    expect(repeated.replayed).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(1);
    await jobs[0]();
    expect(send).toHaveBeenCalledOnce();
    expect(markNotified).toHaveBeenCalledOnce();
    expect(markNotified).toHaveBeenCalledWith(created.id, "sent");
    await expect(sessionStore.getSession(created.id)).resolves.toMatchObject({
      deliveryStatus: "sent",
      notifiedAt: expect.any(Number),
    });
  });

  it("marks completed delivery failed after an adapter error", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Болит грудь",
    });
    const jobs: (() => Promise<void>)[] = [];
    const markNotified = vi.spyOn(sessionStore, "markNotified");

    await finalizeSession(created.id, {
      sessionStore,
      analyze: async () => result("rules_only"),
      doctorSummary: {
        sendDoctorSummary: async () => {
          throw new Error("delivery failed");
        },
      },
      schedule: (work) => jobs.push(work),
    });
    await jobs[0]();

    expect(markNotified).toHaveBeenCalledOnce();
    expect(markNotified).toHaveBeenCalledWith(created.id, "failed");

    await expect(sessionStore.getSession(created.id)).resolves.toMatchObject({
      deliveryStatus: "failed",
      notifiedAt: expect.any(Number),
    });
  });

  it("coalesces concurrent finalize calls into one analysis and one delivery", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Болит грудь",
    });
    const analyze = vi.fn(async () => result("rules_only"));
    const send = vi.fn(async () => Promise.resolve());
    const jobs: (() => Promise<void>)[] = [];

    const [first, second] = await Promise.all([
      finalizeSession(created.id, {
        sessionStore,
        analyze,
        doctorSummary: { sendDoctorSummary: send },
        schedule: (work) => jobs.push(work),
      }),
      finalizeSession(created.id, {
        sessionStore,
        analyze,
        doctorSummary: { sendDoctorSummary: send },
        schedule: (work) => jobs.push(work),
      }),
    ]);

    expect(first).toEqual(second);
    expect(analyze).toHaveBeenCalledOnce();
    expect(jobs).toHaveLength(1);
    await jobs[0]();
    expect(send).toHaveBeenCalledOnce();
  });

  it("records missing live Telegram configuration as a delivery failure", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_ID", undefined);
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Болит грудь",
    });

    await finalizeSession(created.id, {
      sessionStore,
      analyze: async () => result("rules_only"),
      schedule: (work) => void work(),
    });

    await expect(sessionStore.getSession(created.id)).resolves.toMatchObject({
      status: "completed",
      deliveryStatus: "failed",
      notifiedAt: expect.any(Number),
    });
  });

  it("returns the completed result when the background scheduler rejects setup", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Болит грудь",
    });

    await expect(
      finalizeSession(created.id, {
        sessionStore,
        analyze: async () => result("rules_only"),
        doctorSummary: { sendDoctorSummary: async () => Promise.resolve() },
        schedule: () => {
          throw new Error("background unavailable");
        },
      }),
    ).resolves.toMatchObject({ replayed: false });
    await expect(sessionStore.getSession(created.id)).resolves.toMatchObject({
      status: "completed",
      deliveryStatus: "failed",
      notifiedAt: expect.any(Number),
    });
  });

  it("sends one aborted notice through the real adapter seam", async () => {
    const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-token", { fetcher: successfulFetch(calls) }),
      "chat-1",
    );
    const sessionStore = new MemorySessionStore({ abortedNotice: notifier });
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Я начал опрос",
    });

    await sessionStore.abortSession(created.id, "ttl_expired");
    await sessionStore.abortSession(created.id, "ttl_expired");

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init?.body)) as {
      text: string;
      parse_mode?: string;
    };
    expect(body.text).toContain("пациент начал опрос и не закончил");
    expect(body).not.toHaveProperty("parse_mode");
    await expect(sessionStore.getSession(created.id)).resolves.toMatchObject({
      status: "aborted",
      deliveryStatus: "sent",
      notifiedAt: expect.any(Number),
    });
  });

  it("marks a failed aborted notice once and never retries a terminal session", async () => {
    const send = vi.fn(async () => {
      throw new Error("delivery failed");
    });
    const sessionStore = new MemorySessionStore({
      abortedNotice: { sendAbortedNotice: send },
    });
    const markNotified = vi.spyOn(sessionStore, "markNotified");
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Я начал опрос",
    });

    await sessionStore.abortSession(created.id, "ttl_expired");
    await sessionStore.abortSession(created.id, "ttl_expired");

    expect(send).toHaveBeenCalledOnce();
    expect(markNotified).toHaveBeenCalledOnce();
    expect(markNotified).toHaveBeenCalledWith(created.id, "failed");
    await expect(sessionStore.getSession(created.id)).resolves.toMatchObject({
      status: "aborted",
      deliveryStatus: "failed",
      notifiedAt: expect.any(Number),
    });
  });
});
