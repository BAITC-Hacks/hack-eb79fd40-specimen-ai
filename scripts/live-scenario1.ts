import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { POST as createLink } from "../app/api/link/route";
import { handleChat } from "../app/api/chat/handler";
import { handleFinalize } from "../app/api/chat/finalize/handler";
import { handleChatStart } from "../app/api/chat/start/handler";
import { runAnamnesisTurn } from "../lib/anamnesis";
import { buildHealthResponse } from "../lib/health";
import {
  CHAT_TIMEOUT_MS,
  STRUCTURED_TIMEOUT_MS,
  chatTurn,
  type LlmDependencies,
} from "../lib/llm";
import { renderSummaryPdf } from "../lib/pdf";
import { store } from "../lib/store";
import {
  TelegramClient,
  TelegramNotifier,
  parseTelegramDoctorChatIds,
  type TelegramFetch,
} from "../lib/telegram";
import { analyze, createProductionLlm } from "../lib/triage";
import type { RedFlag, TriageResult } from "../lib/types";

export const MAX_ANTHROPIC_CALLS = 3;
export const OUTER_GUARD_MS =
  CHAT_TIMEOUT_MS + STRUCTURED_TIMEOUT_MS + 15_000;
const REPORT_PATH = new URL(
  "../reports/live-e2e/scenario1-structured-telegram.json",
  import.meta.url,
);
const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
] as const;

type Operation = "chat" | "structured";

export interface AnthropicCallBudget {
  readonly actual: number;
  claim(): void;
}

export function createAnthropicCallBudget(
  maximum = MAX_ANTHROPIC_CALLS,
): AnthropicCallBudget {
  let actual = 0;
  return {
    get actual() {
      return actual;
    },
    claim() {
      if (actual >= maximum) {
        throw Object.assign(new Error("call cap"), { stage: "anthropic_call_cap" });
      }
      actual += 1;
    },
  };
}

export function resolveLiveTelegramRecipients(
  env: {
    TELEGRAM_DOCTOR_CHAT_IDS?: string;
    TELEGRAM_DOCTOR_CHAT_ID?: string;
  } = process.env as {
    TELEGRAM_DOCTOR_CHAT_IDS?: string;
    TELEGRAM_DOCTOR_CHAT_ID?: string;
  },
): readonly string[] {
  return parseTelegramDoctorChatIds(
    env.TELEGRAM_DOCTOR_CHAT_IDS,
    env.TELEGRAM_DOCTOR_CHAT_ID,
  );
}

interface TelegramObservation {
  method: "sendMessage" | "sendDocument";
  http_status: number;
  ok: boolean;
  message_id?: number;
  document_file_id?: string;
}

interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

function request(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jsonResponse<T>(stage: string, response: Response): Promise<T> {
  const payload = (await response.json()) as T;
  if (!response.ok) throw Object.assign(new Error(stage), { stage, status: response.status });
  return payload;
}

async function guarded<T>(stage: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(stage), { stage: `${stage}_outer_guard` })),
      OUTER_GUARD_MS,
    );
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assert(condition: unknown, stage: string): asserts condition {
  if (!condition) throw Object.assign(new Error(stage), { stage });
}

function quoteIsVerifiable(flag: RedFlag, messages: readonly { role: string; content: string }[]): boolean {
  if (flag.evidence_kind !== "quote") return true;
  const source = messages[flag.source_message_index];
  return Boolean(
    flag.evidence.trim() &&
      source?.role === "user" &&
      source.content.includes(flag.evidence),
  );
}

function safeFailure(error: unknown): { name: string; stage: string; status?: number } {
  const value = error as { name?: unknown; stage?: unknown; status?: unknown };
  return {
    name: typeof value?.name === "string" ? value.name : "Error",
    stage: typeof value?.stage === "string" ? value.stage : "unknown",
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
  };
}

async function main(): Promise<void> {
  assert(process.env.LIVE_E2E === "1", "live_opt_in_missing");
  assert(
    REQUIRED_ENV.every((name) => Boolean(process.env[name]?.trim())),
    "required_credentials_missing",
  );
  const telegramChatIds = resolveLiveTelegramRecipients();
  assert(telegramChatIds.length > 0, "required_credentials_missing");
  assert(OUTER_GUARD_MS > STRUCTURED_TIMEOUT_MS, "invalid_outer_guard");

  await mkdir(new URL("../reports/live-e2e/", import.meta.url), { recursive: true });
  const reservation = await open(REPORT_PATH, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      throw Object.assign(new Error("report exists"), { stage: "live_run_already_consumed" });
    }
    throw error;
  });
  await reservation.writeFile(
    `${JSON.stringify({ schema_version: 1, verdict: "running", started_at: new Date().toISOString() }, null, 2)}\n`,
  );
  await reservation.close();

  const startedAt = new Date();
  const callStartedAt = new Map<Operation, number>();
  const timings: Partial<Record<Operation, number>> = {};
  const usage: UsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const callBudget = createAnthropicCallBudget();
  let pdfBytes = 0;
  let result: TriageResult | undefined;
  let sessionId: string | undefined;
  let stage = "preflight";
  const telegram: TelegramObservation[] = [];

  const llmDeps: LlmDependencies = {
    applicationMaxRetries: 0,
    onAttempt(operation) {
      callBudget.claim();
      callStartedAt.set(operation, Date.now());
    },
    onResponse(operation, response) {
      const started = callStartedAt.get(operation);
      if (started !== undefined) timings[operation] = Date.now() - started;
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      usage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens ?? 0;
      usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;
    },
  };

  const observingFetch: TelegramFetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = url.endsWith("/sendDocument") ? "sendDocument" : "sendMessage";
    const response = await fetch(input, init);
    const payload = (await response.clone().json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { message_id?: number; document?: { file_id?: string } };
    };
    telegram.push({
      method,
      http_status: response.status,
      ok: response.ok && payload.ok === true,
      ...(typeof payload.result?.message_id === "number"
        ? { message_id: payload.result.message_id }
        : {}),
      ...(typeof payload.result?.document?.file_id === "string"
        ? { document_file_id: payload.result.document.file_id }
        : {}),
    });
    return response;
  };

  const notifier = new TelegramNotifier(
    new TelegramClient(process.env.TELEGRAM_BOT_TOKEN!, { fetcher: observingFetch }),
    telegramChatIds,
    async (session, triageResult) => {
      const pdf = await renderSummaryPdf(session, triageResult);
      pdfBytes = pdf.byteLength;
      return pdf;
    },
  );
  const deliveryJobs: Promise<void>[] = [];
  const deps = {
    sessionStore: store(),
    runTurn: (messages: Parameters<typeof runAnamnesisTurn>[0]) =>
      runAnamnesisTurn(messages, {
        chatTurn: (system, apiMessages) => chatTurn(system, apiMessages, llmDeps),
      }),
    analyze: (messages: Parameters<typeof analyze>[0]) =>
      analyze(messages, { llm: createProductionLlm(llmDeps) }),
    doctorSummary: notifier,
    schedule(work: () => Promise<void>) {
      deliveryJobs.push(work());
    },
  };

  try {
    stage = "health";
    const health = buildHealthResponse();
    assert(health.ok && health.llm_ok, "health_not_ready");
    assert(health.model_version === "lr-v1", "health_model_version");

    stage = "link";
    const link = await jsonResponse<{ token: string }>(stage, await createLink());

    stage = "start";
    const started = await jsonResponse<{ sessionId: string; turnsLeft: number }>(
      stage,
      await handleChatStart(request("/api/chat/start", { token: link.token }), deps.sessionStore),
    );
    sessionId = started.sessionId;

    stage = "chat_and_analysis";
    const turn = await guarded(
      stage,
      handleChat(
          request("/api/chat", {
            sessionId,
            message: "Мне 58 лет, я мужчина. Давит в груди и тяжело дышать в покое.",
          }),
          deps,
        ).then((response) =>
          jsonResponse<{ done: boolean; result?: TriageResult }>(stage, response),
        ),
    );
    if (turn.done && turn.result) {
      result = turn.result;
    } else {
      stage = "explicit_finalize";
      const finalized = await guarded(
        stage,
        handleFinalize(request("/api/chat/finalize", { sessionId }), deps).then(
          (response) =>
            jsonResponse<{ result: TriageResult; replayed: boolean }>(stage, response),
        ),
      );
      result = finalized.result;
    }

    stage = "delivery";
    await Promise.all(deliveryJobs);
    const session = await deps.sessionStore.getSession(sessionId);
    assert(session?.status === "completed", "session_not_completed");
    assert(session.deliveryStatus === "sent" && session.notifiedAt, "delivery_not_marked_sent");
    assert(result.source !== "rules_only", "structured_extraction_failed");
    assert(result.urgency === "emergency", "urgency_not_emergency");
    assert(
      result.red_flags.some((flag) => flag.code === "chest_pain" && flag.emergency),
      "chest_pain_missing",
    );
    assert(
      result.red_flags.every((flag) => quoteIsVerifiable(flag, session.messages)),
      "redflag_quote_not_verifiable",
    );
    assert(/не\s+диагноз/iu.test(result.hypothesis.disclaimer), "disclaimer_invalid");
    assert(/решает\s+врач/iu.test(result.hypothesis.disclaimer), "disclaimer_invalid");
    assert(
      result.source === "model"
        ? Boolean(result.model && !result.model.abstained)
        : Boolean(result.model?.abstained),
      "model_source_incoherent",
    );
    assert(pdfBytes > 0, "pdf_not_generated");
    const telegramPairsConfirmed =
      telegram.length === telegramChatIds.length * 2 &&
      telegramChatIds.every(
        (_chatId, index) =>
          telegram[index * 2]?.method === "sendMessage" &&
          telegram[index * 2 + 1]?.method === "sendDocument" &&
          typeof telegram[index * 2 + 1]?.document_file_id === "string",
      );
    assert(
      telegramPairsConfirmed &&
        telegram.every((observation) => observation.ok) &&
        telegram.every((observation) => typeof observation.message_id === "number"),
      "telegram_delivery_unconfirmed",
    );

    const report = {
      schema_version: 1,
      verdict: "full_success",
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      case_ref: createHash("sha256").update(`${sessionId}:${startedAt.toISOString()}`).digest("hex").slice(0, 12),
      credentials_present: true,
      health: { model_version: health.model_version, llm_ok: health.llm_ok },
      cost_cap: {
        max_anthropic_calls: MAX_ANTHROPIC_CALLS,
        actual_anthropic_calls: callBudget.actual,
        sdk_retries: 0,
        application_retries: 0,
        usage,
      },
      timeout_layers: {
        chat_ms: CHAT_TIMEOUT_MS,
        structured_ms: STRUCTURED_TIMEOUT_MS,
        outer_guard_ms: OUTER_GUARD_MS,
      },
      timings_ms: timings,
      result: {
        source: result.source,
        model_version: result.model?.model_version ?? null,
        abstained: result.model?.abstained ?? null,
        abstain_reason: result.model?.abstain_reason ?? null,
        urgency: result.urgency,
        redflag_codes: result.red_flags.map((flag) => flag.code),
        quote_evidence_verified: true,
        disclaimer_verified: true,
      },
      delivery: {
        status: session.deliveryStatus,
        notified_at_present: Boolean(session.notifiedAt),
        pdf_bytes: pdfBytes,
        telegram,
      },
      patient_content_in_artifact: false,
    };
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.info(
      JSON.stringify({
        verdict: report.verdict,
        anthropic_calls: callBudget.actual,
        usage,
        source: result.source,
        urgency: result.urgency,
        telegram: telegram.map(({ method, ok, message_id, document_file_id }) => ({
          method,
          ok,
          message_id,
          document_file_id,
        })),
      }),
    );
  } catch (error) {
    const report = {
      schema_version: 1,
      verdict: "failed",
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      failure: safeFailure(Object.assign(error instanceof Error ? error : new Error("failure"), {
        stage: (error as { stage?: string })?.stage ?? stage,
      })),
      cost_cap: {
        max_anthropic_calls: MAX_ANTHROPIC_CALLS,
        actual_anthropic_calls: callBudget.actual,
        sdk_retries: 0,
        application_retries: 0,
        usage,
      },
      timeout_layers: {
        chat_ms: CHAT_TIMEOUT_MS,
        structured_ms: STRUCTURED_TIMEOUT_MS,
        outer_guard_ms: OUTER_GUARD_MS,
      },
      timings_ms: timings,
      downstream: {
        result_source: result?.source ?? null,
        pdf_generated: pdfBytes > 0,
        telegram,
      },
      patient_content_in_artifact: false,
    };
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.error(JSON.stringify({ verdict: "failed", failure: report.failure, anthropic_calls: callBudget.actual }));
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) await main();
