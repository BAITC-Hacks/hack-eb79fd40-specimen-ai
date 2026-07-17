import Anthropic from "@anthropic-ai/sdk";
import { assertSupportedStructuredSchema } from "./structured-schema";

const MODEL = "claude-sonnet-5";
export const CHAT_TIMEOUT_MS = 30_000;
export const STRUCTURED_TIMEOUT_MS = 180_000;
const CHAT_MAX_RETRIES = 1;
const STRUCTURED_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 10_000;

const anthropic = new Anthropic({
  maxRetries: 0,
  timeout: 60_000,
});

export type MessageCreatePort = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: Anthropic.RequestOptions,
) => Promise<Anthropic.Message>;

export type LlmErrorCode =
  | "llm_refusal"
  | "llm_truncated"
  | "llm_bad_json"
  | "llm_unavailable";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}

export interface LlmLogEvent {
  operation: "chat" | "structured";
  event: "response" | "retry" | "failure";
  attempt: number;
  stop_reason?: Anthropic.Message["stop_reason"];
  code?: LlmErrorCode | string;
  status?: number;
  delay_ms?: number;
}

export interface LlmDependencies {
  createMessage?: MessageCreatePort;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  log?: (event: LlmLogEvent) => void;
  applicationMaxRetries?: number;
  onAttempt?: (operation: LlmLogEvent["operation"], attempt: number) => void;
  onResponse?: (
    operation: LlmLogEvent["operation"],
    response: Readonly<
      Pick<Anthropic.Message, "id" | "model" | "stop_reason" | "usage">
    >,
  ) => void;
}

const createLiveMessage: MessageCreatePort = (params, options) =>
  anthropic.messages.create(params, options);

const sleepLive = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

function logLive(event: LlmLogEvent): void {
  const label = `[llm] ${event.operation} ${event.event}`;
  if (event.event === "failure") {
    console.error(label, event);
  } else if (event.event === "retry") {
    console.warn(label, event);
  } else {
    console.info(label, event);
  }
}

function safeStatus(error: unknown): number | undefined {
  if (error instanceof Anthropic.APIError) return error.status;
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return undefined;
}

function safeApiCode(error: unknown): string | undefined {
  if (error instanceof Anthropic.APIError) {
    return error.type ?? error.constructor.name;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.constructor.name : undefined;
}

function isRetryableApiError(error: unknown): boolean {
  if (
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return true;
  }
  const status = safeStatus(error);
  return status === 408 || status === 409 || status === 429 || Boolean(status && status >= 500);
}

function normalizeError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const retryable = isRetryableApiError(error);
  return new LlmError(
    "LLM request failed",
    "llm_unavailable",
    retryable,
    { cause: error },
  );
}

function retryAfterMs(error: unknown, now: () => number): number | undefined {
  if (!(error instanceof Anthropic.APIError) || !error.headers) return undefined;
  const raw = error.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now()) : undefined;
}

function retryDelayMs(attempt: number, error: unknown, now: () => number): number {
  const advised = retryAfterMs(error, now);
  const exponential = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(advised ?? exponential, RETRY_MAX_DELAY_MS);
}

async function withRetries<T>(
  operation: LlmLogEvent["operation"],
  maxRetries: number,
  deps: LlmDependencies,
  run: (attempt: number) => Promise<T>,
): Promise<T> {
  const sleep = deps.sleep ?? sleepLive;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? logLive;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      deps.onAttempt?.(operation, attempt);
      return await run(attempt);
    } catch (error) {
      const normalized = normalizeError(error);
      const status = safeStatus(error);
      const code =
        normalized.code === "llm_unavailable"
          ? (safeApiCode(error) ?? normalized.code)
          : normalized.code;
      if (!normalized.retryable || attempt > maxRetries) {
        log({ operation, event: "failure", attempt, code, status });
        throw normalized;
      }
      const delay_ms = retryDelayMs(attempt, error, now);
      log({ operation, event: "retry", attempt, code, status, delay_ms });
      await sleep(delay_ms);
    }
  }

  throw new LlmError("LLM retry loop exhausted", "llm_unavailable", false);
}

function textContent(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function inspectStopReason(
  operation: LlmLogEvent["operation"],
  response: Anthropic.Message,
  attempt: number,
  log: NonNullable<LlmDependencies["log"]>,
): void {
  log({
    operation,
    event: "response",
    attempt,
    stop_reason: response.stop_reason,
  });
  if (response.stop_reason === "refusal") {
    throw new LlmError("Model refused the request", "llm_refusal", false);
  }
  if (response.stop_reason === "max_tokens" && operation === "structured") {
    throw new LlmError("Structured output was truncated", "llm_truncated", true);
  }
  if (
    response.stop_reason !== "end_turn" &&
    !(operation === "chat" && response.stop_reason === "max_tokens")
  ) {
    throw new LlmError("Unexpected LLM stop reason", "llm_unavailable", true);
  }
}

// Разговорный ход опросника: коротко, без «размышлений», низкая задержка.
export async function chatTurn(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  deps: LlmDependencies = {},
): Promise<string> {
  const createMessage = deps.createMessage ?? createLiveMessage;
  const log = deps.log ?? logLive;
  const maxRetries = deps.applicationMaxRetries ?? CHAT_MAX_RETRIES;
  return withRetries("chat", maxRetries, deps, async (attempt) => {
    const response = await createMessage(
      {
        model: MODEL,
        max_tokens: 1024,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system,
        messages,
      },
      { timeout: CHAT_TIMEOUT_MS, maxRetries: 0 },
    );
    deps.onResponse?.("chat", response);
    inspectStopReason("chat", response, attempt, log);
    const text = textContent(response).trim();
    if (!text) {
      throw new LlmError("LLM returned no text", "llm_unavailable", true);
    }
    return text;
  });
}

// Структурированный вызов: возвращает JSON по схеме (извлечение/скоринг).
export async function structured<T>(
  system: string,
  userContent: string,
  schema: Record<string, unknown>,
  deps: LlmDependencies = {},
): Promise<T> {
  assertSupportedStructuredSchema(schema);
  const createMessage = deps.createMessage ?? createLiveMessage;
  const log = deps.log ?? logLive;
  const maxRetries = deps.applicationMaxRetries ?? STRUCTURED_MAX_RETRIES;
  return withRetries(
    "structured",
    maxRetries,
    deps,
    async (attempt) => {
      const response = await createMessage(
        {
          model: MODEL,
          max_tokens: 8000,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "medium",
            format: { type: "json_schema", schema },
          },
          system,
          messages: [{ role: "user", content: userContent }],
        },
        { timeout: STRUCTURED_TIMEOUT_MS, maxRetries: 0 },
      );
      deps.onResponse?.("structured", response);
      inspectStopReason("structured", response, attempt, log);
      const text = textContent(response);
      if (!text.trim()) {
        throw new LlmError("Structured output contained no JSON text", "llm_bad_json", true);
      }
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new LlmError("Structured output was not valid JSON", "llm_bad_json", true, {
          cause: error,
        });
      }
    },
  );
}
