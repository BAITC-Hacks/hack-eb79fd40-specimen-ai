import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  finalizeSession,
  type DoctorSummaryPort,
} from "../../lib/finalize";
import {
  CHAT_TIMEOUT_MS,
  STRUCTURED_TIMEOUT_MS,
  chatTurn,
  LlmError,
  structured,
  type LlmLogEvent,
  type MessageCreatePort,
} from "../../lib/llm";
import { MemorySessionStore } from "../../lib/store";
import { analyze, type LlmAnalysis, type LlmPort, type ModelPort } from "../../lib/triage";

function message(
  content: Anthropic.Message["content"],
  stopReason: Anthropic.Message["stop_reason"] = "end_turn",
): Anthropic.Message {
  return {
    id: "msg_test",
    container: null,
    content,
    model: "claude-sonnet-5",
    role: "assistant",
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 7,
      output_tokens: 4,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

function jsonMessage(
  stopReason: Anthropic.Message["stop_reason"] = "end_turn",
): Anthropic.Message {
  return message(
    [{ type: "text", text: '{"ok":true}', citations: null }],
    stopReason,
  );
}

function sequence(
  steps: readonly (Anthropic.Message | Error)[],
): { createMessage: MessageCreatePort; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async createMessage() {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

function deterministicDeps(createMessage: MessageCreatePort) {
  const events: LlmLogEvent[] = [];
  const delays: number[] = [];
  return {
    events,
    delays,
    deps: {
      createMessage,
      log: (event: LlmLogEvent) => events.push(event),
      sleep: async (delayMs: number) => {
        delays.push(delayMs);
      },
    },
  };
}

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

describe("LLM resilience", () => {
  it("lets one structured attempt finish after the old 90-second window", async () => {
    vi.useFakeTimers();
    try {
      const createMessage = vi.fn<MessageCreatePort>((_params, options) =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Anthropic.APIConnectionTimeoutError({ message: "timeout" })),
            options?.timeout ?? 0,
          );
          setTimeout(() => {
            clearTimeout(timeout);
            resolve(jsonMessage());
          }, 100_000);
        }),
      );
      let settled = false;
      const request = structured<{ ok: boolean }>("system", "text", SCHEMA, {
        createMessage,
        applicationMaxRetries: 0,
        log: () => undefined,
      }).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(90_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(request).resolves.toEqual({ ok: true });
      expect(createMessage).toHaveBeenCalledOnce();
      expect(createMessage.mock.calls[0][1]).toEqual({
        timeout: STRUCTURED_TIMEOUT_MS,
        maxRetries: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the zero-retry structured attempt exactly at its owned timeout", async () => {
    vi.useFakeTimers();
    try {
      const createMessage = vi.fn<MessageCreatePort>((_params, options) =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Anthropic.APIConnectionTimeoutError({ message: "timeout" })),
            options?.timeout ?? 0,
          );
        }),
      );
      let settled = false;
      const outcome = structured("system", "text", SCHEMA, {
        createMessage,
        applicationMaxRetries: 0,
        log: () => undefined,
      }).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      await vi.advanceTimersByTimeAsync(STRUCTURED_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({
        code: "llm_unavailable",
      });
      expect(createMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the interactive chat deadline shorter than structured", async () => {
    const createMessage = vi.fn<MessageCreatePort>(async () => jsonMessage());

    await chatTurn("system", [{ role: "user", content: "text" }], {
      createMessage,
      applicationMaxRetries: 0,
      log: () => undefined,
    });

    expect(CHAT_TIMEOUT_MS).toBe(30_000);
    expect(STRUCTURED_TIMEOUT_MS).toBe(180_000);
    expect(CHAT_TIMEOUT_MS).toBeLessThan(STRUCTURED_TIMEOUT_MS);
    expect(createMessage.mock.calls[0][1]).toEqual({
      timeout: CHAT_TIMEOUT_MS,
      maxRetries: 0,
    });
  });

  it("retries truncated structured output with deterministic backoff and logs stop_reason", async () => {
    const fake = sequence([jsonMessage("max_tokens"), jsonMessage()]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      structured<{ ok: boolean }>("system", "patient text", SCHEMA, harness.deps),
    ).resolves.toEqual({ ok: true });

    expect(fake.calls()).toBe(2);
    expect(harness.delays).toEqual([250]);
    expect(harness.events).toContainEqual({
      operation: "structured",
      event: "response",
      attempt: 1,
      stop_reason: "max_tokens",
    });
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        operation: "structured",
        event: "retry",
        code: "llm_truncated",
      }),
    );
  });

  it.each([
    {
      label: "malformed JSON",
      response: message([{ type: "text", text: "{", citations: null }]),
    },
    {
      label: "empty text",
      response: message([{ type: "text", text: "   ", citations: null }]),
    },
    {
      label: "non-text output",
      response: message([
        { type: "thinking", thinking: "internal", signature: "sig" },
      ]),
    },
  ])("turns terminal $label into typed llm_bad_json", async ({ response }) => {
    const fake = sequence([response]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      structured("system", "patient text", SCHEMA, harness.deps),
    ).rejects.toMatchObject({
      name: "LlmError",
      code: "llm_bad_json",
      retryable: true,
    } satisfies Partial<LlmError>);
    expect(fake.calls()).toBe(4);
    expect(harness.delays).toEqual([250, 500, 1_000]);
  });

  it("does not retry a refusal", async () => {
    const fake = sequence([jsonMessage("refusal")]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      structured("system", "patient text", SCHEMA, harness.deps),
    ).rejects.toMatchObject({
      code: "llm_refusal",
      retryable: false,
    } satisfies Partial<LlmError>);
    expect(fake.calls()).toBe(1);
    expect(harness.delays).toEqual([]);
  });

  it.each(["stop_sequence", "tool_use", "pause_turn", null] as const)(
    "handles unexpected structured stop reason %s as a bounded typed failure",
    async (stopReason) => {
      const fake = sequence([jsonMessage(stopReason)]);
      const harness = deterministicDeps(fake.createMessage);

      await expect(
        structured("system", "patient text", SCHEMA, harness.deps),
      ).rejects.toMatchObject({ code: "llm_unavailable" } satisfies Partial<LlmError>);
      expect(fake.calls()).toBe(4);
      expect(harness.events).toContainEqual(
        expect.objectContaining({ stop_reason: stopReason }),
      );
    },
  );

  it.each([
    Object.assign(new Error("rate limited"), { status: 429, code: "rate_limit_error" }),
    Object.assign(new Error("server error"), { status: 500, code: "server_error" }),
    new Anthropic.APIConnectionError({ cause: new Error("network") }),
    new Anthropic.APIConnectionTimeoutError({ message: "timeout" }),
  ])("retries a transient API failure without logging request content", async (failure) => {
    const fake = sequence([failure, jsonMessage()]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      structured<{ ok: boolean }>("system secret", "patient secret", SCHEMA, harness.deps),
    ).resolves.toEqual({ ok: true });
    expect(fake.calls()).toBe(2);
    expect(harness.delays).toEqual([250]);
    const logs = JSON.stringify(harness.events);
    expect(logs).not.toContain("system secret");
    expect(logs).not.toContain("patient secret");
  });

  it("does not retry a non-transient API status", async () => {
    const failure = Object.assign(new Error("unauthorized"), {
      status: 401,
      code: "authentication_error",
    });
    const fake = sequence([failure]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      structured("system", "patient text", SCHEMA, harness.deps),
    ).rejects.toMatchObject({
      code: "llm_unavailable",
      retryable: false,
    } satisfies Partial<LlmError>);
    expect(fake.calls()).toBe(1);
    expect(harness.delays).toEqual([]);
  });

  it("honors Retry-After through injected time and sleep ports", async () => {
    const failure = new Anthropic.RateLimitError(
      429,
      {},
      "rate limited",
      new Headers({ "retry-after": "2" }),
    );
    const fake = sequence([failure, jsonMessage()]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      structured<{ ok: boolean }>("system", "patient text", SCHEMA, {
        ...harness.deps,
        now: () => 1_721_000_000_000,
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.delays).toEqual([2_000]);
  });

  it("honors an HTTP-date Retry-After deterministically", async () => {
    const now = 1_721_000_000_000;
    const failure = new Anthropic.RateLimitError(
      429,
      {},
      "rate limited",
      new Headers({ "retry-after": new Date(now + 3_000).toUTCString() }),
    );
    const fake = sequence([failure, jsonMessage()]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      structured<{ ok: boolean }>("system", "patient text", SCHEMA, {
        ...harness.deps,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.delays).toEqual([3_000]);
  });

  it("bounds chat and structured retries exactly and disables SDK retries per request", async () => {
    const failure = Object.assign(new Error("server error"), {
      status: 503,
      code: "server_error",
    });
    const chatCreate = vi.fn<MessageCreatePort>(async () => {
      throw failure;
    });
    const structuredCreate = vi.fn<MessageCreatePort>(async () => {
      throw failure;
    });
    const chatHarness = deterministicDeps(chatCreate);
    const structuredHarness = deterministicDeps(structuredCreate);

    await expect(
      chatTurn("system", [{ role: "user", content: "текст" }], chatHarness.deps),
    ).rejects.toMatchObject({ code: "llm_unavailable" });
    await expect(
      structured("system", "patient text", SCHEMA, structuredHarness.deps),
    ).rejects.toMatchObject({ code: "llm_unavailable" });

    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(structuredCreate).toHaveBeenCalledTimes(4);
    for (const call of chatCreate.mock.calls) {
      expect(call[1]).toEqual({ timeout: 30_000, maxRetries: 0 });
    }
    for (const call of structuredCreate.mock.calls) {
      expect(call[1]).toEqual({ timeout: 180_000, maxRetries: 0 });
    }
    expect(chatHarness.delays).toEqual([250]);
    expect(structuredHarness.delays).toEqual([250, 500, 1_000]);
  });

  it("keeps production retry defaults but permits a zero-retry live override", async () => {
    const failure = Object.assign(new Error("server error"), {
      status: 503,
      code: "server_error",
    });
    const defaultChat = sequence([failure]);
    const defaultStructured = sequence([failure]);
    const liveChat = sequence([failure]);
    const liveStructured = sequence([failure]);
    const noDelay = { sleep: async () => undefined, log: () => undefined };

    await expect(
      chatTurn("system", [{ role: "user", content: "text" }], {
        ...noDelay,
        createMessage: defaultChat.createMessage,
      }),
    ).rejects.toMatchObject({ code: "llm_unavailable" });
    await expect(
      structured("system", "text", SCHEMA, {
        ...noDelay,
        createMessage: defaultStructured.createMessage,
      }),
    ).rejects.toMatchObject({ code: "llm_unavailable" });
    await expect(
      chatTurn("system", [{ role: "user", content: "text" }], {
        ...noDelay,
        createMessage: liveChat.createMessage,
        applicationMaxRetries: 0,
      }),
    ).rejects.toMatchObject({ code: "llm_unavailable" });
    await expect(
      structured("system", "text", SCHEMA, {
        ...noDelay,
        createMessage: liveStructured.createMessage,
        applicationMaxRetries: 0,
      }),
    ).rejects.toMatchObject({ code: "llm_unavailable" });

    expect(defaultChat.calls()).toBe(2);
    expect(defaultStructured.calls()).toBe(4);
    expect(liveChat.calls()).toBe(1);
    expect(liveStructured.calls()).toBe(1);
  });

  it("fails closed on a future unknown stop reason and logs it without response text", async () => {
    const unknown = "future_stop_reason" as Anthropic.Message["stop_reason"];
    const fake = sequence([
      message([{ type: "text", text: "patient-secret", citations: null }], unknown),
    ]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      structured("system-secret", "patient-secret", SCHEMA, harness.deps),
    ).rejects.toMatchObject({ code: "llm_unavailable" });
    expect(fake.calls()).toBe(4);
    expect(harness.events.filter((event) => event.stop_reason === unknown)).toHaveLength(4);
    expect(JSON.stringify(harness.events)).not.toContain("patient-secret");
    expect(JSON.stringify(harness.events)).not.toContain("system-secret");
  });

  it("returns a truncated chat text but rejects empty chat output", async () => {
    const partial = sequence([
      message([{ type: "text", text: " Частичный ответ ", citations: null }], "max_tokens"),
    ]);
    const partialHarness = deterministicDeps(partial.createMessage);
    await expect(
      chatTurn("system", [{ role: "user", content: "текст" }], partialHarness.deps),
    ).resolves.toBe("Частичный ответ");
    expect(partial.calls()).toBe(1);

    const empty = sequence([message([], "end_turn")]);
    const emptyHarness = deterministicDeps(empty.createMessage);
    await expect(
      chatTurn("system", [{ role: "user", content: "текст" }], emptyHarness.deps),
    ).rejects.toMatchObject({ code: "llm_unavailable" } satisfies Partial<LlmError>);
    expect(empty.calls()).toBe(2);
  });

  it("does not retry a chat refusal", async () => {
    const fake = sequence([jsonMessage("refusal")]);
    const harness = deterministicDeps(fake.createMessage);

    await expect(
      chatTurn("system", [{ role: "user", content: "текст" }], harness.deps),
    ).rejects.toMatchObject({
      code: "llm_refusal",
      retryable: false,
    } satisfies Partial<LlmError>);
    expect(fake.calls()).toBe(1);
    expect(harness.delays).toEqual([]);
  });

  it.each(["stop_sequence", "tool_use", "pause_turn", null] as const)(
    "handles unexpected chat stop reason %s as a bounded typed failure",
    async (stopReason) => {
      const fake = sequence([jsonMessage(stopReason)]);
      const harness = deterministicDeps(fake.createMessage);

      await expect(
        chatTurn("system", [{ role: "user", content: "текст" }], harness.deps),
      ).rejects.toMatchObject({ code: "llm_unavailable" });
      expect(fake.calls()).toBe(2);
      expect(harness.delays).toEqual([250]);
      expect(harness.events.filter((event) => event.stop_reason === stopReason)).toHaveLength(2);
    },
  );
});

describe("truncated extraction degradation", () => {
  it("finalizes rules_only, skips model, and still schedules the doctor summary", async () => {
    const truncated = sequence([jsonMessage("max_tokens")]);
    const harness = deterministicDeps(truncated.createMessage);
    const llm: LlmPort = {
      analyze: () =>
        structured<LlmAnalysis>("extract", "patient transcript", SCHEMA, harness.deps),
    };
    const predict = vi.fn<ModelPort["predict"]>();
    const model: ModelPort = { predict };
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Давит в груди и появилась одышка в покое.",
    });
    const sent = vi.fn<DoctorSummaryPort["sendDoctorSummary"]>(async () =>
      Promise.resolve(),
    );
    const jobs: (() => Promise<void>)[] = [];

    const outcome = await finalizeSession(session.id, {
      sessionStore,
      analyze: (messages) => analyze(messages, { llm, model }),
      doctorSummary: { sendDoctorSummary: sent },
      schedule: (work) => jobs.push(work),
    });

    expect(outcome.result).toMatchObject({
      source: "rules_only",
      urgency: "emergency",
      routing: [],
      hypothesis: { confidence: 0 },
    });
    expect(outcome.result.model).toBeUndefined();
    expect(outcome.result.hypothesis.disclaimer).toMatch(/не\s+диагноз/iu);
    expect(outcome.result.hypothesis.disclaimer).toMatch(/решает\s+врач/iu);
    expect(outcome.result.urgency_reasons).toContain(
      "признаки не извлечены — сводка построена только на правилах",
    );
    expect(predict).not.toHaveBeenCalled();
    expect(truncated.calls()).toBe(4);
    expect(harness.events.filter((event) => event.stop_reason === "max_tokens")).toHaveLength(4);
    expect(jobs).toHaveLength(1);
    expect(sent).not.toHaveBeenCalled();
    await jobs[0]();
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0][1]).toBe(outcome.result);
    await expect(sessionStore.getSession(session.id)).resolves.toMatchObject({
      status: "completed",
      deliveryStatus: "sent",
    });
  });
});
