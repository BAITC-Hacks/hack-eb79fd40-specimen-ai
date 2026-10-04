import { afterEach, describe, expect, it, vi } from "vitest";

import { finalizeSession } from "../../lib/finalize";
import { ABSTAIN_HYPOTHESIS } from "../../lib/triage";
import { MemorySessionStore } from "../../lib/store";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TelegramClient,
  TelegramBroadcastError,
  TelegramDeliveryError,
  TelegramNotifier,
  parseTelegramDoctorChatIds,
  renderAbortedNotice,
  renderSummary,
  sendDoctorSummary,
  splitForTelegram,
  splitForTelegramWithDisclaimer,
  telegramNotifierFromEnv,
  type TelegramFetch,
} from "../../lib/telegram";
import type {
  ReadonlySession,
  TriageResult,
} from "../../lib/types";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
      text: source === "llm_fallback" ? ABSTAIN_HYPOTHESIS : "Требуется срочная оценка врача.",
      confidence: source === "model" ? 0.71 : 0,
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
  it("renders the scoped episode and doctor without exposing a visible session UUID", () => {
    const current = result("model");
    const context = {
      episodeLabel: "Новый завершённый опрос",
      doctorDisplayName: "Врач Ардан",
      intakeUrl: "https://demeu.example.test/workspace/intakes/session-12345678",
    };
    const text = renderSummary(session(current), current, context);
    const lines = text.split("\n");

    expect(lines[0]).toBe("🔴 НЕОТЛОЖНО — Demeu, сводка первичного опроса");
    expect(lines[1]).toBe("Эпизод: Новый завершённый опрос · Врач: Врач Ардан");
    expect(text.replace(context.intakeUrl, "")).not.toContain("session-12345678");
    expect(lines.at(-1)).toBe(context.intakeUrl);
  });

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
      if (source === "model") {
        expect(text).toContain("кардиология — 71%");
      } else if (source === "llm_fallback") {
        expect(text).toContain("1. кардиология");
        expect(text).toContain(
          "Ориентировочный маршрут, без числовой оценки",
        );
        expect(text).not.toContain("кардиология — 71%");
        expect(text).not.toContain("кардиология — 0%");
      } else {
        expect(text).toContain("Недоступна.");
        expect(text).not.toContain("кардиология");
      }
      expect(text).toContain(current.model?.abstained ? "ГИПОТЕЗА НЕ СФОРМИРОВАНА" : "ПРЕДВАРИТЕЛЬНАЯ ГИПОТЕЗА");
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

  it.each(["low_confidence", "out_of_label_space"] as const)(
    "keeps abstain explicit without any confidence wording for %s",
    (reason) => {
      const current = result("llm_fallback");
      current.model!.abstain_reason = reason;
      current.hypothesis.text = ABSTAIN_HYPOTHESIS;
      current.hypothesis.confidence = 0;

      const text = renderSummary(session(current), current);

      expect(text).toContain("МОДЕЛЬ ВОЗДЕРЖАЛАСЬ");
      expect(text).toContain("ГИПОТЕЗА НЕ СФОРМИРОВАНА");
      expect(text).toContain(ABSTAIN_HYPOTHESIS);
      expect(text).not.toMatch(/уверенн/iu);
    },
  );

  it("renders explicit negative history separately from unanswered history", () => {
    const current = result("rules_only");
    current.anamnesis = {
      ...current.anamnesis,
      chronic: [],
      allergies: [],
      medications: [],
      history_status: {
        past_history: "not_stated",
        chronic: "denied",
        allergies: "denied",
        medications: "not_stated",
      },
      negative_findings: ["температуры нет", "ноги не немеют"],
    };

    const text = renderSummary(session(current), current);

    expect(text).toContain("Перенесённое: не уточнено");
    expect(text).toContain("Хронические: отрицает");
    expect(text).toContain("лекарства: не уточнено");
    expect(text).toContain("аллергии: отрицает");
    expect(text).toContain("Явно отрицает: температуры нет, ноги не немеют");
  });

  it("does not claim model uncertainty when no model was run", () => {
    const current = result("llm_fallback");
    delete current.model;

    const text = renderSummary(session(current), current);

    expect(text).toContain("ИСТОЧНИК:");
    expect(text).not.toContain("модель не уверена");
  });

  it("renders unknown intensity as an em dash and explicit zero as 0/10", () => {
    const unknown = result();
    unknown.anamnesis.symptom.severity = null;
    const zero = result();
    zero.anamnesis.symptom.severity = 0;

    expect(renderSummary(session(unknown), unknown)).toContain("сила: —");
    expect(renderSummary(session(zero), zero)).toContain("сила: 0/10");
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

  it("reserves disclaimer space in every nonempty Telegram chunk", () => {
    const disclaimer = "Это не диагноз, решает врач.";
    const chunks = splitForTelegramWithDisclaimer(
      "секция ".repeat(100),
      disclaimer,
      96,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 96)).toBe(
      true,
    );
    expect(
      chunks.every(
        (chunk) =>
          chunk.includes(disclaimer) &&
          chunk.match(/Это не диагноз, решает врач\./g)?.length === 1,
      ),
    ).toBe(true);
    expect(() =>
      splitForTelegramWithDisclaimer("body", disclaimer, disclaimer.length),
    ).toThrow("leaves no room for content");
  });

  it("keeps the scoped intake URL as the final line while every chunk retains the disclaimer", () => {
    const current = result("rules_only");
    current.hypothesis.text = "длинная сводка ".repeat(100);
    const context = {
      episodeLabel: "Новый завершённый опрос",
      doctorDisplayName: "Врач Ардан",
      intakeUrl: "https://demeu.example.test/workspace/intakes/session-12345678",
    };
    const chunks = splitForTelegramWithDisclaimer(
      renderSummary(session(current), current, context),
      current.hypothesis.disclaimer,
      420,
      context.intakeUrl,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 420 && chunk.includes(current.hypothesis.disclaimer))).toBe(true);
    expect(chunks.at(-1)?.split("\n").at(-1)).toBe(context.intakeUrl);
    expect(chunks.join("\n").match(/https:\/\/demeu\.example\.test\/workspace\/intakes\/session-12345678/gu)).toHaveLength(1);
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
    expect(text).not.toContain("doctor1");
    expect(text).not.toContain("Сессия:");
    expect(text).toContain("Причина: время опроса истекло");
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
    expect(sent.length).toBeGreaterThan(1);
    expect(
      sent.every(
        (chunk) =>
          chunk.includes(current.hypothesis.disclaimer) &&
          chunk.length <= TELEGRAM_MESSAGE_LIMIT,
      ),
    ).toBe(true);
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

    const error = await client
      .sendMessage("private-chat", "private-text")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "api",
      message: expect.stringContaining("HTTP 400"),
    });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(
      /bad chat|private-chat|private-text|bot-token/i,
    );
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

  it("parses plural recipients with stable deduplication and legacy fallback", () => {
    expect(
      parseTelegramDoctorChatIds(" 1001, , 1002,1001 ", "9999"),
    ).toEqual(["1001", "1002"]);
    expect(parseTelegramDoctorChatIds("   ", " -1003 ")).toEqual(["-1003"]);
    expect(parseTelegramDoctorChatIds(undefined, undefined)).toEqual([]);
  });

  it.each(["0", "+1", "1.5", "doctor", "9223372036854775808"])(
    "fails closed for malformed plural recipient %s instead of using legacy",
    (invalid) => {
      expect(() =>
        parseTelegramDoctorChatIds(`1001,${invalid}`, "9999"),
      ).toThrow();
    },
  );

  it("rejects a nonblank plural value that contains no recipients", () => {
    expect(() => parseTelegramDoctorChatIds(", ,", "9999")).toThrow(
      "At least one Telegram doctor chat ID is required",
    );
  });

  it("requires the bot token and at least one recipient to construct the live notifier", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_IDS", undefined);
    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_ID", undefined);
    expect(telegramNotifierFromEnv()).toBeUndefined();

    vi.stubEnv("TELEGRAM_BOT_TOKEN", "token");
    expect(telegramNotifierFromEnv()).toBeUndefined();

    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_ID", "1001");
    expect(telegramNotifierFromEnv()).toBeInstanceOf(TelegramNotifier);

    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_IDS", "2001,2002");
    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_ID", "legacy-is-ignored");
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

describe("Telegram broadcast notifier", () => {
  it("renders once and sends completed text and PDF to every recipient", async () => {
    const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
    const renderPdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70]));
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-token", { fetcher: successfulFetch(calls) }),
      ["1001", "1002"],
      renderPdf,
    );

    await notifier.sendDoctorSummary(session(), result("rules_only"));

    expect(renderPdf).toHaveBeenCalledOnce();
    expect(
      calls.map(({ input, init }) => {
        const body = init?.body;
        const chatId =
          body instanceof FormData
            ? body.get("chat_id")
            : (JSON.parse(String(body)) as { chat_id: string }).chat_id;
        return [input.toString().split("/").at(-1), chatId];
      }),
    ).toEqual([
      ["sendMessage", "1001"],
      ["sendDocument", "1001"],
      ["sendMessage", "1002"],
      ["sendDocument", "1002"],
    ]);
  });

  it("continues after a mandatory text failure and throws only a privacy-safe aggregate", async () => {
    const calls: { method: string; chatId: string }[] = [];
    const fetcher: TelegramFetch = async (input, init) => {
      const method = input.toString().split("/").at(-1) ?? "";
      const body = init?.body;
      const chatId = String(
        body instanceof FormData
          ? body.get("chat_id")
          : (JSON.parse(String(body)) as { chat_id: string }).chat_id,
      );
      calls.push({ method, chatId });
      if (method === "sendMessage" && chatId === "1001") {
        return new Response(
          JSON.stringify({
            ok: false,
            description: "recipient 1001 rejected private summary result 77",
          }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-secret", { fetcher }),
      ["1001", "1002"],
      async () => new Uint8Array([37, 80, 68, 70]),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await notifier
      .sendDoctorSummary(session(), result("rules_only"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramBroadcastError);
    expect(error).toMatchObject({
      delivery: "completed",
      failedRecipientCount: 1,
    });
    const serialized = JSON.stringify(error);
    expect(`${String(error)} ${serialized}`).not.toMatch(
      /1001|1002|bot-secret|private summary|result 77/i,
    );
    expect(log).toHaveBeenCalledWith(
      "Telegram completed text chunk delivery failed",
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /1001|1002|bot-secret|private summary|result 77/i,
    );
    expect(calls).toEqual([
      { method: "sendMessage", chatId: "1001" },
      { method: "sendDocument", chatId: "1001" },
      { method: "sendMessage", chatId: "1002" },
      { method: "sendDocument", chatId: "1002" },
    ]);
  });

  it("logs a fixed safe message for PDF failure and keeps text broadcast successful", async () => {
    const calls: { method: string; chatId: string }[] = [];
    const fetcher: TelegramFetch = async (input, init) => {
      const method = input.toString().split("/").at(-1) ?? "";
      const body = init?.body;
      const chatId = String(
        body instanceof FormData
          ? body.get("chat_id")
          : (JSON.parse(String(body)) as { chat_id: string }).chat_id,
      );
      calls.push({ method, chatId });
      return method === "sendDocument" && chatId === "1001"
        ? new Response(
            JSON.stringify({
              ok: false,
              description: "recipient 1001 document result 88 rejected",
            }),
            { status: 500 },
          )
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-secret", { fetcher }),
      ["1001", "1002"],
      async () => new Uint8Array([37, 80, 68, 70]),
    );

    await expect(
      notifier.sendDoctorSummary(session(), result("rules_only")),
    ).resolves.toBeUndefined();

    expect(calls.filter(({ method }) => method === "sendMessage")).toHaveLength(2);
    expect(calls.filter(({ method }) => method === "sendDocument")).toHaveLength(2);
    expect(log).toHaveBeenCalledWith("Telegram PDF delivery failed");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /1001|1002|bot-secret|document result|summary/i,
    );
  });

  it("attempts every chunk and recipient before aggregating middle-chunk and PDF failures", async () => {
    const current = result("rules_only");
    current.hypothesis.text = "длинный проверочный текст ".repeat(1_600);
    const expectedChunks = splitForTelegramWithDisclaimer(
      renderSummary(session(current), current),
      current.hypothesis.disclaimer,
    );
    expect(expectedChunks.length).toBeGreaterThanOrEqual(3);

    const calls: {
      method: string;
      chatId: string;
      text?: string;
    }[] = [];
    const recipientMessageCounts = new Map<string, number>();
    const fetcher: TelegramFetch = async (input, init) => {
      const method = input.toString().split("/").at(-1) ?? "";
      const body = init?.body;
      const chatId = String(
        body instanceof FormData
          ? body.get("chat_id")
          : (JSON.parse(String(body)) as { chat_id: string }).chat_id,
      );
      const text =
        body instanceof FormData
          ? undefined
          : (JSON.parse(String(body)) as { text: string }).text;
      calls.push({ method, chatId, ...(text ? { text } : {}) });

      if (method === "sendMessage") {
        const count = (recipientMessageCounts.get(chatId) ?? 0) + 1;
        recipientMessageCounts.set(chatId, count);
        if (chatId === "1001" && count === 2) {
          return new Response(
            JSON.stringify({
              ok: false,
              description: "private middle chunk for 1001",
            }),
            { status: 503 },
          );
        }
      }
      if (method === "sendDocument" && chatId === "1001") {
        return new Response(
          JSON.stringify({
            ok: false,
            description: "private PDF result for 1001",
          }),
          { status: 500 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const renderPdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70]));
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-secret", { fetcher }),
      ["1001", "1002"],
      renderPdf,
    );

    const error = await notifier
      .sendDoctorSummary(session(), current)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      delivery: "completed",
      failedRecipientCount: 1,
    });
    expect(renderPdf).toHaveBeenCalledOnce();
    const textCalls = calls.filter(({ method }) => method === "sendMessage");
    expect(textCalls).toHaveLength(expectedChunks.length * 2);
    expect(
      textCalls.filter(({ chatId }) => chatId === "1001"),
    ).toHaveLength(expectedChunks.length);
    expect(
      textCalls.filter(({ chatId }) => chatId === "1002"),
    ).toHaveLength(expectedChunks.length);
    expect(
      textCalls.every(
        ({ text }) =>
          typeof text === "string" &&
          text.length <= TELEGRAM_MESSAGE_LIMIT &&
          text.includes(current.hypothesis.disclaimer),
      ),
    ).toBe(true);
    expect(calls.filter(({ method }) => method === "sendDocument")).toHaveLength(
      2,
    );
    expect(calls.at(-1)).toMatchObject({
      method: "sendDocument",
      chatId: "1002",
    });
    expect(log.mock.calls).toEqual([
      ["Telegram completed text chunk delivery failed"],
      ["Telegram PDF delivery failed"],
    ]);
    expect(`${String(error)} ${JSON.stringify(error)} ${JSON.stringify(log.mock.calls)}`)
      .not.toMatch(/1001|1002|bot-secret|private middle|private PDF/i);
  });

  it("broadcasts aborted text without PDF and isolates recipient failures", async () => {
    const calls: { method: string; chatId: string }[] = [];
    const renderPdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70]));
    const fetcher: TelegramFetch = async (input, init) => {
      const method = input.toString().split("/").at(-1) ?? "";
      const body = JSON.parse(String(init?.body)) as { chat_id: string };
      calls.push({ method, chatId: body.chat_id });
      return body.chat_id === "1001"
        ? new Response(
            JSON.stringify({ ok: false, description: "private 1001" }),
            { status: 400 },
          )
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-secret", { fetcher }),
      ["1001", "1002"],
      renderPdf,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await notifier
      .sendAbortedNotice({
        sessionId: "private-session",
        doctorToken: "private-doctor",
        startedAt: 1_721_000_000_000,
        abortedAt: 1_721_000_060_000,
        reason: "ttl_expired",
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      delivery: "aborted",
      failedRecipientCount: 1,
    });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(
      /1001|1002|bot-secret|private-session|private-doctor/i,
    );
    expect(log).toHaveBeenCalledWith("Telegram aborted text delivery failed");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /1001|1002|bot-secret|private-session|private-doctor/i,
    );
    expect(calls).toEqual([
      { method: "sendMessage", chatId: "1001" },
      { method: "sendMessage", chatId: "1002" },
    ]);
    expect(renderPdf).not.toHaveBeenCalled();
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

  it("repeated finalize schedules exactly one two-recipient broadcast", async () => {
    const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-token", { fetcher: successfulFetch(calls) }),
      ["1001", "1002"],
      async () => new Uint8Array([37, 80, 68, 70]),
    );
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Болит грудь",
    });
    const jobs: (() => Promise<void>)[] = [];

    await finalizeSession(created.id, {
      sessionStore,
      analyze: async () => result("rules_only"),
      doctorSummary: notifier,
      schedule: (work) => jobs.push(work),
    });
    await finalizeSession(created.id, {
      sessionStore,
      analyze: async () => result("rules_only"),
      doctorSummary: notifier,
      schedule: (work) => jobs.push(work),
    });

    expect(jobs).toHaveLength(1);
    await jobs[0]();
    expect(calls).toHaveLength(4);
    await expect(sessionStore.getSession(created.id)).resolves.toMatchObject({
      deliveryStatus: "sent",
    });
  });

  it("marks the aggregate session delivery failed after a partial broadcast", async () => {
    const fetcher: TelegramFetch = async (input, init) => {
      const method = input.toString().split("/").at(-1);
      const body = init?.body;
      const chatId = String(
        body instanceof FormData
          ? body.get("chat_id")
          : (JSON.parse(String(body)) as { chat_id: string }).chat_id,
      );
      return method === "sendMessage" && chatId === "1001"
        ? new Response(JSON.stringify({ ok: false }), { status: 403 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-token", { fetcher }),
      ["1001", "1002"],
      async () => new Uint8Array([37, 80, 68, 70]),
    );
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const created = await sessionStore.createSession(token);
    await sessionStore.appendMessage(created.id, {
      role: "user",
      content: "Болит грудь",
    });
    const jobs: (() => Promise<void>)[] = [];

    await expect(
      finalizeSession(created.id, {
        sessionStore,
        analyze: async () => result("rules_only"),
        doctorSummary: notifier,
        schedule: (work) => jobs.push(work),
      }),
    ).resolves.toMatchObject({ replayed: false });
    await jobs[0]();

    await expect(sessionStore.getSession(created.id)).resolves.toMatchObject({
      status: "completed",
      deliveryStatus: "failed",
      notifiedAt: expect.any(Number),
    });
    expect(log).toHaveBeenCalledWith(
      "Telegram completed text chunk delivery failed",
    );
  });

  it("records missing live Telegram configuration as a delivery failure", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_IDS", undefined);
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
      ["1001"],
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
