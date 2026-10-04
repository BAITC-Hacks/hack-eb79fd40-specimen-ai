import type { ChatMessage, TriageResult } from "@/lib/types";
import type { PatientClosing } from "@/lib/patient-response";

export type Language = "ru" | "kk";

export type ApiFailure =
  | {
      kind: "http";
      status: number;
      code?: string;
      requestId?: string;
      retryAfterMs?: number;
    }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "bad_json" };

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: ApiFailure };

export interface StartChatResponse {
  sessionId: string;
  reply: string;
  turnsLeft: number;
  preparationId?: string;
  preparationUrl?: string;
  preparationPending?: boolean;
}

export interface ChatTurnResponse {
  reply: string;
  done: boolean;
  turnsLeft: number;
  closing?: PatientClosing;
}

const pendingChatRequestIds = new Map<string, string>();
const MAX_PENDING_CHAT_REQUESTS = 256;

function chatRequestId(sessionId: string, message: string): { key: string; requestId: string } {
  const key = `${sessionId}\0${message}`;
  const existing = pendingChatRequestIds.get(key);
  if (existing) return { key, requestId: existing };
  const requestId = globalThis.crypto.randomUUID();
  pendingChatRequestIds.set(key, requestId);
  while (pendingChatRequestIds.size > MAX_PENDING_CHAT_REQUESTS) {
    const oldest = pendingChatRequestIds.keys().next().value;
    if (typeof oldest !== "string") break;
    pendingChatRequestIds.delete(oldest);
  }
  return { key, requestId };
}

export interface FinalizeChatResponse {
  closing: PatientClosing;
  replayed: boolean;
}

export interface ResumeChatResponse {
  sessionId: string;
  language: Language;
  messages: ChatMessage[];
  turnsLeft: number;
  status: "collecting" | "completed" | "aborted";
  closing?: PatientClosing;
}

export function resumeChat(sessionId: string, token: string): Promise<ApiResult<ResumeChatResponse>> {
  return requestJson({
    url: "/api/chat/resume", body: { sessionId, token }, timeoutMs: 10_000,
    guard: (value): value is ResumeChatResponse => isRecord(value) &&
      value.sessionId === sessionId && (value.language === "ru" || value.language === "kk") &&
      turnsLeft(value.turnsLeft) && ["collecting", "completed", "aborted"].includes(String(value.status)) &&
      Array.isArray(value.messages) && value.messages.every((message) => isRecord(message) &&
        (message.role === "user" || message.role === "assistant") && typeof message.content === "string") &&
      value.result === undefined && value.source === undefined &&
      (value.status === "completed" ? isPatientClosing(value.closing) : value.closing === undefined),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function probability(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

function turnsLeft(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRedFlag(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmpty(value.code) &&
    nonEmpty(value.label) &&
    nonEmpty(value.evidence) &&
    (value.evidence_kind === "quote" || value.evidence_kind === "derived") &&
    typeof value.emergency === "boolean" &&
    finiteNumber(value.source_message_index) &&
    Number.isInteger(value.source_message_index) &&
    ((value.evidence_kind === "quote" && Number(value.source_message_index) >= 0) ||
      (value.evidence_kind === "derived" && value.source_message_index === -1)) &&
    (value.elicited_by === undefined || typeof value.elicited_by === "string")
  );
}

function isAnamnesis(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.symptom) || !isRecord(value.context)) {
    return false;
  }
  const symptom = value.symptom;
  const context = value.context;
  return (
    typeof value.chief_complaint === "string" &&
    typeof symptom.onset === "string" &&
    typeof symptom.location === "string" &&
    typeof symptom.quality === "string" &&
    (symptom.severity === null ||
      (finiteNumber(symptom.severity) &&
        Number.isInteger(symptom.severity) &&
        symptom.severity >= 0 &&
        symptom.severity <= 10)) &&
    typeof symptom.modifiers === "string" &&
    stringArray(symptom.associated) &&
    stringArray(value.past_history) &&
    stringArray(value.chronic) &&
    stringArray(value.allergies) &&
    stringArray(value.medications) &&
    (context.age === null || finiteNumber(context.age)) &&
    (context.sex === "m" || context.sex === "f" || context.sex === "unknown") &&
    (context.pregnancy === "yes" ||
      context.pregnancy === "no" ||
      context.pregnancy === "na") &&
    stringArray(context.risk_factors)
  );
}

function isModel(value: unknown): value is NonNullable<TriageResult["model"]> {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.pathologies) &&
    value.pathologies.every(
      (item) =>
        isRecord(item) &&
        nonEmpty(item.code) &&
        nonEmpty(item.label_ru) &&
        probability(item.prob) &&
        (item.icd10 === undefined || typeof item.icd10 === "string"),
    ) &&
    Array.isArray(value.top_contributions) &&
    value.top_contributions.every(
      (item) =>
        isRecord(item) &&
        nonEmpty(item.feature) &&
        nonEmpty(item.label_ru) &&
        finiteNumber(item.contribution),
    ) &&
    value.pathologies.length <= 5 &&
    typeof value.abstained === "boolean" &&
    (value.abstain_reason === undefined ||
      value.abstain_reason === "low_confidence" ||
      value.abstain_reason === "out_of_label_space") &&
    nonEmpty(value.model_version) &&
    (!value.abstained ||
      (value.pathologies.length === 0 && value.top_contributions.length === 0))
  );
}

export function hasMandatoryDisclaimer(value: string): boolean {
  return (
    /(?:^|[^\p{L}])(?:это\s+)?(?:не|а\s+не)\s+диагноз(?!\p{L})/iu.test(value) &&
    /(?:^|[^\p{L}])(?:решает|решение\s+принимает)\s+врач(?!\p{L})/iu.test(value)
  );
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

export function isTriageResult(value: unknown): value is TriageResult {
  if (
    !isRecord(value) ||
    !isAnamnesis(value.anamnesis) ||
    !Array.isArray(value.red_flags) ||
    !value.red_flags.every(isRedFlag) ||
    ![
      "routine",
      "planned",
      "urgent",
      "emergency",
    ].includes(String(value.urgency)) ||
    !stringArray(value.urgency_reasons) ||
    !Array.isArray(value.routing) ||
    !value.routing.every(
      (item) =>
        isRecord(item) && nonEmpty(item.specialty) && probability(item.confidence),
    ) ||
    value.routing.length > 3 ||
    !isRecord(value.hypothesis) ||
    typeof value.hypothesis.text !== "string" ||
    !probability(value.hypothesis.confidence) ||
    !nonEmpty(value.hypothesis.disclaimer) ||
    !hasMandatoryDisclaimer(value.hypothesis.disclaimer) ||
    (value.source !== "model" &&
      value.source !== "llm_fallback" &&
      value.source !== "rules_only") ||
    (value.processing_mode !== undefined &&
      value.processing_mode !== "external_llm" &&
      value.processing_mode !== "deterministic") ||
    (value.model !== undefined && !isModel(value.model))
  ) {
    return false;
  }
  if (
    value.red_flags.some(
      (flag) => isRecord(flag) && flag.emergency === true,
    ) && value.urgency !== "emergency"
  ) {
    return false;
  }
  const model = value.model;
  if (value.source === "model") {
    return (
      isModel(model) &&
      !model.abstained &&
      model.pathologies.length > 0 &&
      nearlyEqual(value.hypothesis.confidence, model.pathologies[0].prob)
    );
  }
  if (value.source === "rules_only") {
    return model === undefined && value.hypothesis.confidence === 0;
  }
  return (
    value.hypothesis.confidence <= 0.5 &&
    (model === undefined || (isModel(model) && model.abstained))
  );
}

function isStartResponse(value: unknown): value is StartChatResponse {
  return (
    isRecord(value) &&
    nonEmpty(value.sessionId) &&
    nonEmpty(value.reply) &&
    turnsLeft(value.turnsLeft) &&
    (value.preparationId === undefined || nonEmpty(value.preparationId)) &&
    (value.preparationUrl === undefined || typeof value.preparationUrl === "string" && /^\/p\/[A-Za-z0-9_-]{43}$/u.test(value.preparationUrl)) &&
    (value.preparationPending === undefined || typeof value.preparationPending === "boolean")
  );
}

function isPatientClosing(value: unknown): value is PatientClosing {
  return isRecord(value) && typeof value.emergency === "boolean" && nonEmpty(value.text);
}

function isChatResponse(value: unknown): value is ChatTurnResponse {
  if (
    !isRecord(value) ||
    typeof value.reply !== "string" ||
    typeof value.done !== "boolean" ||
    !turnsLeft(value.turnsLeft)
  ) {
    return false;
  }
  const hasClosing = value.closing !== undefined;
  return value.result === undefined && value.source === undefined &&
    value.done === hasClosing && (!hasClosing || isPatientClosing(value.closing));
}

function isFinalizeResponse(value: unknown): value is FinalizeChatResponse {
  return (
    isRecord(value) &&
    isPatientClosing(value.closing) &&
    value.result === undefined &&
    value.source === undefined &&
    typeof value.replayed === "boolean"
  );
}

function retryAfterHeader(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function errorPayload(value: unknown): {
  code?: string;
  requestId?: string;
  retryAfterMs?: number;
} {
  if (!isRecord(value)) return {};
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    requestId:
      typeof value.request_id === "string" ? value.request_id : undefined,
    retryAfterMs:
      finiteNumber(value.retry_after_ms) && value.retry_after_ms >= 0
        ? value.retry_after_ms
        : undefined,
  };
}

async function requestJson<T>({
  url,
  body,
  timeoutMs,
  guard,
  headers,
}: {
  url: string;
  body?: unknown;
  timeoutMs: number;
  guard: (value: unknown) => value is T;
  headers?: HeadersInit;
}): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return {
        ok: false,
        failure: { kind: controller.signal.aborted ? "timeout" : "network" },
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const details = errorPayload(payload);
      return {
        ok: false,
        failure: {
          kind: "http",
          status: response.status,
          code: details.code,
          requestId: details.requestId,
          retryAfterMs:
            details.retryAfterMs ?? retryAfterHeader(response.headers.get("retry-after")),
        },
      };
    }

    return guard(payload)
      ? { ok: true, data: payload }
      : { ok: false, failure: { kind: "bad_json" } };
  } finally {
    clearTimeout(timeout);
  }
}

export function createLink(doctorCode?: string): Promise<ApiResult<{ token: string }>> {
  return requestJson({
    url: "/api/link",
    timeoutMs: 10_000,
    headers: doctorCode ? { "x-doctor-code": doctorCode } : undefined,
    guard: (value): value is { token: string } =>
      isRecord(value) && nonEmpty(value.token),
  });
}

export function startChat(
  token: string,
  language: Language,
): Promise<ApiResult<StartChatResponse>> {
  return requestJson({
    url: "/api/chat/start",
    body: { token, language },
    timeoutMs: 10_000,
    guard: isStartResponse,
  });
}

export function sendChat(
  sessionId: string,
  message: string,
): Promise<ApiResult<ChatTurnResponse>> {
  const { key, requestId } = chatRequestId(sessionId, message);
  return requestJson({
    url: "/api/chat",
    body: { sessionId, message, requestId },
    timeoutMs: 45_000,
    guard: isChatResponse,
  }).then((result) => {
    if (result.ok && pendingChatRequestIds.get(key) === requestId) {
      pendingChatRequestIds.delete(key);
    }
    return result;
  });
}

export function finalizeChat(
  sessionId: string,
): Promise<ApiResult<FinalizeChatResponse>> {
  return requestJson({
    url: "/api/chat/finalize",
    body: { sessionId },
    timeoutMs: 60_000,
    guard: isFinalizeResponse,
  });
}
