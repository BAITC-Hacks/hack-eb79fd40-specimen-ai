import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_BASE = "https://specimen-ai.govtech-kz.com";
export const LEGACY_PRODUCTION_ORIGIN = "https://84.247.161.211";
export const L1_OPT_IN = "I_ACCEPT_PRODUCTION_SMOKE";
export const L2_OPT_IN = "I_AUTHORIZE_3_SCENARIOS_AND_UP_TO_24_ANTHROPIC_REQUESTS";
export const SCENARIO1_ONCE_OPT_IN = "I_AUTHORIZE_ONE_PRODUCTION_SCENARIO1_ONCE";

const MAX_JSON_BYTES = 1_000_000;
const L1_HTTP_CAP = 5;
const L2_HTTP_CAP = 25;
const SCENARIO1_HTTP_CAP = 8;
const RESTRICTED_WORD = "\u0434\u0438\u0430\u0433\u043d\u043e\u0437";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ARTIFACT_ROOT = resolve(ROOT, "reports/live-e2e");

const SCENARIOS = [
  {
    id: "scenario-1-chest-pain",
    lines: [
      "Мне 58 лет, я мужчина. Сильная давящая боль в груди и одышка в покое, боль 8 из 10.",
    ],
    verify(result) {
      must(result.urgency === "emergency", "scenario 1 urgency is not emergency");
      must(
        result.red_flags.some((flag) => flag.code === "chest_pain" && flag.emergency === true),
        "scenario 1 has no emergency chest_pain flag",
      );
      must(
        result.routing.some(({ specialty }) => /кардиолог|скор|неотлож/iu.test(specialty)),
        "scenario 1 routing has no cardiology or emergency care",
      );
    },
  },
  {
    id: "scenario-2-back-pain",
    lines: [
      "Мне 34 года, я женщина. Уже две недели ноющая боль в пояснице, 4 из 10, к вечеру сильнее.",
      "Температуры нет, ноги не немеют, мочеиспускание нормальное.",
      "Хронических состояний нет, лекарств не принимаю, аллергий нет.",
    ],
    verify(result) {
      must(result.urgency !== "emergency", "scenario 2 has false emergency urgency");
      must(result.red_flags.every((flag) => !flag.emergency), "scenario 2 has false emergency flag");
    },
  },
  {
    id: "scenario-3-rhinitis",
    lines: [
      "Мне 27 лет, я мужчина. Со вчера насморк, немного чихаю.",
      "Температуры нет, горло не болит, других жалоб нет.",
    ],
    verify(result) {
      must(!["urgent", "emergency"].includes(result.urgency), "scenario 3 urgency is too high");
      must(result.red_flags.length === 0, "scenario 3 has red flags");
    },
  },
];

class SmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SmokeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SmokeError(code, message);
}

function must(condition, message, code = "VALIDATION_FAILED") {
  if (!condition) fail(code, message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProductionHostname(hostname) {
  if (["84.247.161.211", "109.123.248.16"].includes(hostname)) return hostname;
  must(
    typeof hostname === "string" &&
      hostname.length <= 253 &&
      hostname.includes(".") &&
      /^[a-z0-9.-]+$/.test(hostname),
    "production hostname is not the approved public IPv4 or a normalized lowercase ASCII DNS FQDN",
  );
  const labels = hostname.split(".");
  must(labels.length >= 2, "production hostname requires at least two labels");
  for (const label of labels) {
    must(
      label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) &&
        !label.startsWith("xn--"),
      "production hostname contains an invalid DNS label",
    );
  }
  const finalLabel = labels.at(-1);
  must(
    typeof finalLabel === "string" &&
      !/^[0-9]+$/.test(finalLabel) &&
      !/^0x[0-9a-f]*$/.test(finalLabel),
    "production hostname has an IP-shaped final DNS label",
  );
  must(
    !(labels.length === 4 && labels.every((label) => /^[0-9]+$/.test(label))),
    "production hostname must not be an IP literal",
  );
  must(hostname !== "localhost", "production hostname must not be localhost");
  return hostname;
}

export function validateProductionOrigin(origin) {
  must(
    typeof origin === "string" && /^https:\/\/[a-z0-9.-]+$/.test(origin),
    "production origin must be exact lowercase HTTPS without authority extras",
  );
  const parsed = new URL(origin);
  must(parsed.protocol === "https:", "production smoke requires HTTPS");
  must(parsed.origin === origin && parsed.pathname === "/", "production origin must not contain a path");
  must(!parsed.username && !parsed.password && !parsed.port, "production origin contains forbidden authority fields");
  validateProductionHostname(parsed.hostname);
  return parsed.origin;
}

function validateBase(baseUrl, expectedOrigin = CANONICAL_BASE) {
  const trustedOrigin = validateProductionOrigin(expectedOrigin);
  must(baseUrl === trustedOrigin, "BASE_URL does not match EXPECTED_PRODUCTION_ORIGIN");
  return validateProductionOrigin(baseUrl);
}

function safeError(error) {
  return error instanceof SmokeError ? error.code : "UNEXPECTED_FAILURE";
}

function safeConsoleError(error) {
  return error instanceof SmokeError ? error.message : "smoke failed safely";
}

function endpointLabel(path) {
  if (path === "/") return "root";
  if (path === "/api/healthz") return "healthz";
  if (path === "/api/link") return "link";
  if (path === "/api/chat/start") return "chat start";
  if (path === "/api/chat") return "chat";
  if (path === "/api/chat/finalize") return "chat finalize";
  if (/^\/c\/[0-9a-f]{16}$/i.test(path)) return "patient page";
  return "request";
}

function createClient({
  baseUrl,
  expectedOrigin = CANONICAL_BASE,
  fetchImpl = globalThis.fetch,
  cap,
  initialCookieHeader = "",
}) {
  const origin = validateBase(baseUrl, expectedOrigin);
  let count = 0;
  const cookies = new Map();

  function mergeCookiePair(value) {
    if (typeof value !== "string" || /[\r\n]/u.test(value)) return;
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) return;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) return;
    if (cookieValue) cookies.set(name, cookieValue);
    else cookies.delete(name);
  }

  if (typeof initialCookieHeader === "string" && !/[\r\n]/u.test(initialCookieHeader)) {
    for (const pair of initialCookieHeader.split(/;\s*/u)) mergeCookiePair(pair);
  }

  async function request(path, {
    method = "GET",
    body,
    expectedStatus = 200,
    expectJson = true,
    timeoutMs = 20_000,
  } = {}) {
    const label = endpointLabel(path);
    must(
      path === "/" || /^\/[a-z0-9/_-]+(?:\/[0-9a-f]{16})?$/i.test(path),
      "unsafe request path",
      "UNSAFE_REQUEST_PATH",
    );
    count += 1;
    must(count <= cap, "HTTP request cap exceeded", "HTTP_CAP_EXCEEDED");

    let response;
    try {
      const headers = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (method !== "GET") headers.origin = origin;
      if (cookies.size > 0) {
        headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      }
      response = await fetchImpl(`${origin}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      fail(
        timedOut ? "HTTP_TIMEOUT" : "HTTP_TRANSPORT_FAILED",
        `${label} transport failure (${timedOut ? "timeout" : "network or TLS"})`,
      );
    }

    must(
      response.status === expectedStatus,
      `${label} -> unexpected HTTP ${response.status}`,
      "HTTP_STATUS_UNEXPECTED",
    );
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const setCookie of setCookies) mergeCookiePair(setCookie);
    const text = await response.text();
    must(
      Buffer.byteLength(text, "utf8") <= MAX_JSON_BYTES,
      `${label} response is too large`,
      "HTTP_RESPONSE_TOO_LARGE",
    );
    if (!expectJson) return { text, contentType: response.headers.get("content-type") ?? "" };

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("HTTP_NON_JSON", `${label} returned non-JSON`);
    }
    must(isRecord(parsed), `${label} returned a non-object JSON value`, "HTTP_JSON_SHAPE_INVALID");
    return parsed;
  }

  return { request, count: () => count };
}

function assertExactHealth(health) {
  must(
    Object.keys(health).sort().join(",") === "commit,llm_ok,model_version,ok,processing_mode",
    "healthz fields differ from the SPINE contract",
  );
  must(health.ok === true, "healthz ok is not true");
  must(typeof health.commit === "string" && health.commit.length > 0, "healthz commit is empty");
  must(
    typeof health.model_version === "string" && health.model_version.length > 0,
    "healthz model_version is empty",
  );
  must(typeof health.llm_ok === "boolean", "healthz llm_ok is not boolean");
  must(
    health.processing_mode === "external_llm" || health.processing_mode === "deterministic",
    "healthz processing_mode is invalid",
  );
}

function assertOnlyNegativeRestrictedUsage(value) {
  const strings = [];
  const visit = (current) => {
    if (typeof current === "string") strings.push(current);
    else if (Array.isArray(current)) current.forEach(visit);
    else if (isRecord(current)) Object.values(current).forEach(visit);
  };
  visit(value);

  for (const text of strings) {
    const lower = text.toLocaleLowerCase("ru-RU");
    let at = lower.indexOf(RESTRICTED_WORD);
    while (at !== -1) {
      const before = lower.slice(Math.max(0, at - 24), at);
      must(/(?:не\s+|не\s+ставим\s+)$/iu.test(before), "restricted product term is not negated");
      at = lower.indexOf(RESTRICTED_WORD, at + RESTRICTED_WORD.length);
    }
  }
}

export function assertSmokeResult(result, messages) {
  must(isRecord(result), "TriageResult is not an object");
  must(Array.isArray(result.red_flags), "red_flags is not an array");
  must(["routine", "planned", "urgent", "emergency"].includes(result.urgency), "urgency is invalid");
  must(Array.isArray(result.urgency_reasons), "urgency_reasons is not an array");
  must(Array.isArray(result.routing) && result.routing.length <= 3, "routing is invalid");
  must(isRecord(result.anamnesis), "anamnesis is missing");
  must(isRecord(result.hypothesis), "hypothesis is missing");
  must(["model", "llm_fallback", "rules_only"].includes(result.source), "source is invalid");

  if (result.red_flags.some((flag) => flag.emergency === true)) {
    must(result.urgency === "emergency", "emergency flag did not dominate urgency");
  }
  for (const flag of result.red_flags) {
    must(isRecord(flag), "red flag is not an object");
    must(typeof flag.code === "string" && flag.code.trim(), "red flag code is empty");
    must(typeof flag.label === "string" && flag.label.trim(), "red flag label is empty");
    must(typeof flag.emergency === "boolean", "red flag emergency is not boolean");
    must(typeof flag.evidence === "string" && flag.evidence.trim(), "red flag evidence is empty");
    must(Number.isInteger(flag.source_message_index), "red flag source index is invalid");
    if (flag.evidence_kind === "derived") {
      must(flag.source_message_index === -1, "derived evidence index is not -1");
      continue;
    }
    must(flag.evidence_kind === "quote", "red flag evidence_kind is invalid");
    const source = messages[flag.source_message_index];
    must(source?.role === "user", "quote evidence does not point to a patient message");
    must(source.content.includes(flag.evidence), "quote evidence is not an exact patient substring");
    let occurrence = source.content.indexOf(flag.evidence);
    let hasWholeEnding = false;
    while (occurrence !== -1) {
      const end = occurrence + flag.evidence.length;
      if (end === source.content.length || !/\p{L}/u.test(source.content[end])) {
        hasWholeEnding = true;
        break;
      }
      occurrence = source.content.indexOf(flag.evidence, occurrence + 1);
    }
    must(hasWholeEnding, "quote evidence ends inside a word");
  }

  const anamnesisKeys = [
    "chief_complaint",
    "symptom",
    "past_history",
    "chronic",
    "allergies",
    "medications",
    "context",
  ];
  must(anamnesisKeys.every((key) => Object.hasOwn(result.anamnesis, key)), "anamnesis is incomplete");
  must(typeof result.anamnesis.chief_complaint === "string", "chief complaint is invalid");
  must(isRecord(result.anamnesis.symptom), "anamnesis symptom is invalid");
  must(
    Object.hasOwn(result.anamnesis.symptom, "severity"),
    "symptom severity is missing",
  );
  const severity = result.anamnesis.symptom.severity;
  must(
    severity === null ||
      (Number.isFinite(severity) &&
        Number.isInteger(severity) &&
        severity >= 0 &&
        severity <= 10),
    "symptom severity must be null or an integer from 0 to 10",
  );
  for (const key of ["past_history", "chronic", "allergies", "medications"]) {
    must(Array.isArray(result.anamnesis[key]), `anamnesis ${key} is not an array`);
  }
  must(isRecord(result.anamnesis.context), "anamnesis context is invalid");
  const { age, sex, pregnancy } = result.anamnesis.context;
  must(age === null || (Number.isFinite(age) && age >= 0 && age <= 120), "context age is invalid");
  must(["m", "f", "unknown"].includes(sex), "context sex is invalid");
  must(["yes", "no", "na"].includes(pregnancy), "context pregnancy is invalid");

  must(result.urgency_reasons.every((reason) => typeof reason === "string"), "urgency reason is invalid");
  if (result.source !== "rules_only") must(result.routing.length > 0, "routing is empty");
  for (let index = 0; index < result.routing.length; index += 1) {
    const route = result.routing[index];
    must(isRecord(route), "routing row is invalid");
    must(typeof route.specialty === "string" && route.specialty.trim(), "routing specialty is empty");
    must(
      Number.isFinite(route.confidence) && route.confidence >= 0 && route.confidence <= 1,
      "routing confidence is invalid",
    );
    if (index > 0) {
      must(result.routing[index - 1].confidence >= route.confidence, "routing is not sorted");
    }
  }

  must(
    typeof result.hypothesis.disclaimer === "string" && result.hypothesis.disclaimer.trim(),
    "hypothesis disclaimer is empty",
  );
  must(typeof result.hypothesis.text === "string" && result.hypothesis.text.trim(), "hypothesis text is empty");
  const disclaimer = result.hypothesis.disclaimer.toLocaleLowerCase("ru-RU");
  must(
    disclaimer.includes(`не ${RESTRICTED_WORD}`) && /решает\s+врач/iu.test(disclaimer),
    "hypothesis disclaimer misses the mandatory negative wording",
  );
  must(
    Number.isFinite(result.hypothesis.confidence) &&
      result.hypothesis.confidence >= 0 &&
      result.hypothesis.confidence <= 1,
    "hypothesis confidence is invalid",
  );

  if (result.source === "rules_only") {
    must(result.model === undefined, "rules_only unexpectedly contains model audit");
    must(result.hypothesis.confidence === 0, "rules_only confidence is not zero");
  } else if (result.source === "model") {
    must(isRecord(result.model), "model source has no model audit");
    must(result.model.abstained === false, "model source is abstained");
    must(
      Array.isArray(result.model.pathologies) &&
        result.model.pathologies.length > 0 &&
        result.model.pathologies.length <= 5,
      "model pathologies are empty or longer than top-5",
    );
    must(Array.isArray(result.model.top_contributions), "model contributions are invalid");
    for (let index = 0; index < result.model.pathologies.length; index += 1) {
      const pathology = result.model.pathologies[index];
      must(isRecord(pathology), "model pathology is invalid");
      must(typeof pathology.code === "string" && pathology.code.trim(), "model pathology code is empty");
      must(typeof pathology.label_ru === "string" && pathology.label_ru.trim(), "model pathology label is empty");
      must(Number.isFinite(pathology.prob) && pathology.prob >= 0 && pathology.prob <= 1, "model probability is invalid");
      if (index > 0) {
        must(result.model.pathologies[index - 1].prob >= pathology.prob, "model pathologies are not sorted");
      }
    }
    must(
      Math.abs(result.hypothesis.confidence - result.model.pathologies[0].prob) <= 1e-9,
      "model confidence differs from top pathology",
    );
  } else if (result.model !== undefined) {
    must(isRecord(result.model) && result.model.abstained === true, "fallback model audit is not abstained");
    must(result.model.pathologies?.length === 0, "abstained pathologies are not empty");
    must(result.model.top_contributions?.length === 0, "abstained contributions are not empty");
    must(
      ["low_confidence", "out_of_label_space"].includes(result.model.abstain_reason),
      "abstain reason is invalid",
    );
  }
  if (result.source === "llm_fallback") {
    must(result.hypothesis.confidence <= 0.5, "fallback confidence is above 0.5");
  }
  assertOnlyNegativeRestrictedUsage(result);
}

export async function runL1({
  baseUrl = CANONICAL_BASE,
  expectedOrigin = CANONICAL_BASE,
  fetchImpl = globalThis.fetch,
  workspaceCookie = "",
} = {}) {
  const client = createClient({ baseUrl, expectedOrigin, fetchImpl, cap: L1_HTTP_CAP, initialCookieHeader: workspaceCookie });
  const checks = [];

  const workspace = await client.request("/workspace", { expectJson: false, timeoutMs: 15_000 });
  must(/text\/html/iu.test(workspace.contentType), "workspace is not HTML");
  checks.push("tls_hostname_and_workspace");

  const health = await client.request("/api/healthz", { timeoutMs: 15_000 });
  assertExactHealth(health);
  checks.push("healthz_contract");

  const link = await client.request("/api/link", { method: "POST", body: {} });
  must(typeof link.token === "string" && /^[0-9a-f]{16}$/.test(link.token), "link token is malformed");
  checks.push("create_link");

  const invalidToken = link.token === "0000000000000000" ? "1111111111111111" : "0000000000000000";
  const invalid = await client.request("/api/chat/start", {
    method: "POST",
    body: { token: invalidToken },
    expectedStatus: 404,
  });
  must(invalid.code === "TOKEN_NOT_FOUND", "unknown token error code differs from SPINE");
  checks.push("unknown_token_404");

  const patient = await client.request(`/c/${encodeURIComponent(link.token)}`, {
    expectJson: false,
    timeoutMs: 15_000,
  });
  must(/text\/html/iu.test(patient.contentType), "patient route is not HTML");
  checks.push("patient_page");

  must(checks.length === 5 && client.count() === L1_HTTP_CAP, "L1 did not execute exactly five checks");
  return {
    level: "L1",
    ok: true,
    checks,
    health: {
      contract_verified: true,
      llm_ok: health.llm_ok,
      processing_mode: health.processing_mode,
    },
    valid_start: "not_called; current route is static and does not prove LLM readiness",
    http_requests: client.count(),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function anthropicRequestUpperBound(processingMode) {
  return processingMode === "deterministic" ? 0 : 24;
}

export async function runL2({
  baseUrl = CANONICAL_BASE,
  expectedOrigin = CANONICAL_BASE,
  fetchImpl = globalThis.fetch,
  workspaceCookie = "",
} = {}) {
  const client = createClient({ baseUrl, expectedOrigin, fetchImpl, cap: L2_HTTP_CAP, initialCookieHeader: workspaceCookie });
  const health = await client.request("/api/healthz", { timeoutMs: 15_000 });
  assertExactHealth(health);
  must(
    health.processing_mode === "deterministic" || health.llm_ok === true,
    "external LLM mode requires healthz llm_ok=true",
  );

  const summaries = [];
  for (const scenario of SCENARIOS) {
    const link = await client.request("/api/link", { method: "POST", body: {} });
    must(typeof link.token === "string" && /^[0-9a-f]{16}$/.test(link.token), "link token is malformed");
    const start = await client.request("/api/chat/start", {
      method: "POST",
      body: { token: link.token },
    });
    must(typeof start.sessionId === "string" && start.sessionId.trim(), "sessionId is missing");
    must(typeof start.reply === "string" && start.reply.trim(), "start reply is empty");
    must(Number.isInteger(start.turnsLeft), "start turnsLeft is missing");

    const messages = [{ role: "assistant", content: start.reply }];
    let chatClosing;
    for (const line of scenario.lines) {
      if (chatClosing) break;
      messages.push({ role: "user", content: line });
      const turn = await client.request("/api/chat", {
        method: "POST",
        body: { sessionId: start.sessionId, message: line },
        timeoutMs: 75_000,
      });
      must(typeof turn.reply === "string", "chat reply is missing");
      must(typeof turn.done === "boolean", "chat done is missing");
      must(Number.isInteger(turn.turnsLeft), "chat turnsLeft is missing");
      messages.push({ role: "assistant", content: turn.reply });
      if (turn.done) {
        must(isRecord(turn.closing), "done chat response has no patient closing");
        must(turn.result === undefined && turn.source === undefined, "done chat exposed clinician-only fields");
        chatClosing = turn.closing;
      }
    }

    const firstFinalize = await client.request("/api/chat/finalize", {
      method: "POST",
      body: { sessionId: start.sessionId },
      timeoutMs: 750_000,
    });
    must(isRecord(firstFinalize.closing), "first finalize has no patient closing");
    must(firstFinalize.result === undefined && firstFinalize.source === undefined, "first finalize exposed clinician-only fields");
    if (chatClosing) must(sameJson(chatClosing, firstFinalize.closing), "finalize changed patient closing");

    const secondFinalize = await client.request("/api/chat/finalize", {
      method: "POST",
      body: { sessionId: start.sessionId },
      timeoutMs: 30_000,
    });
    must(secondFinalize.replayed === true, "second finalize is not marked replayed");
    must(secondFinalize.result === undefined && secondFinalize.source === undefined, "second finalize exposed clinician-only fields");
    must(sameJson(firstFinalize.closing, secondFinalize.closing), "idempotent finalize changed patient closing");

    const completed = await client.request("/api/chat", {
      method: "POST",
      body: { sessionId: start.sessionId, message: "Дополнительный вопрос" },
      expectedStatus: 409,
    });
    must(completed.code === "SESSION_COMPLETED", "completed session did not return SESSION_COMPLETED");

    const intake = await client.request(`/api/workspace/intakes/${encodeURIComponent(start.sessionId)}`, {
      timeoutMs: 30_000,
    });
    must(isRecord(intake.intake) && isRecord(intake.intake.result), "workspace intake has no TriageResult");
    const result = intake.intake.result;

    assertSmokeResult(result, messages);
    scenario.verify(result);
    summaries.push({
      scenario: scenario.id,
      ok: true,
      urgency: result.urgency,
      source: result.source,
      red_flag_count: result.red_flags.length,
      evidence_verified: true,
      disclaimer_verified: true,
      finalize_replayed: true,
    });
  }

  return {
    level: "L2",
    ok: true,
    processing_mode: health.processing_mode,
    health: {
      contract_verified: true,
      llm_ok: health.llm_ok,
      processing_mode: health.processing_mode,
    },
    scenarios: summaries,
    http_requests: client.count(),
    http_request_cap: L2_HTTP_CAP,
    anthropic_request_upper_bound: anthropicRequestUpperBound(health.processing_mode),
    client_retries: 0,
    telegram_delivery: "not observable from the public API; verify Bot API acceptance separately",
  };
}

async function runScenario1Once({
  baseUrl = CANONICAL_BASE,
  expectedOrigin = CANONICAL_BASE,
  expectedCommit = "",
  fetchImpl = globalThis.fetch,
  workspaceCookie = "",
} = {}) {
  must(
    typeof expectedCommit === "string" && /^[0-9a-f]{7}$/.test(expectedCommit),
    "EXPECTED_COMMIT must be exactly seven lowercase hexadecimal characters",
    "EXPECTED_COMMIT_INVALID",
  );
  const client = createClient({
    baseUrl,
    expectedOrigin,
    fetchImpl,
    cap: SCENARIO1_HTTP_CAP,
    initialCookieHeader: workspaceCookie,
  });
  const scenario = SCENARIOS[0];
  must(scenario.lines.length === 1, "scenario 1 must contain exactly one patient line");

  const health = await client.request("/api/healthz", { timeoutMs: 15_000 });
  assertExactHealth(health);
  must(health.commit === expectedCommit, "healthz commit differs from EXPECTED_COMMIT");
  must(
    health.processing_mode === "deterministic" || health.llm_ok === true,
    "external LLM mode requires healthz llm_ok=true",
  );

  const link = await client.request("/api/link", { method: "POST", body: {} });
  must(typeof link.token === "string" && /^[0-9a-f]{16}$/.test(link.token), "link token is malformed");
  const start = await client.request("/api/chat/start", {
    method: "POST",
    body: { token: link.token },
  });
  must(typeof start.sessionId === "string" && start.sessionId.trim(), "sessionId is missing");
  must(typeof start.reply === "string" && start.reply.trim(), "start reply is empty");
  must(Number.isInteger(start.turnsLeft), "start turnsLeft is missing");

  const patientLine = scenario.lines[0];
  const messages = [
    { role: "assistant", content: start.reply },
    { role: "user", content: patientLine },
  ];
  const turn = await client.request("/api/chat", {
    method: "POST",
    body: { sessionId: start.sessionId, message: patientLine },
    timeoutMs: 75_000,
  });
  must(typeof turn.reply === "string", "chat reply is missing");
  must(typeof turn.done === "boolean", "chat done is missing");
  must(Number.isInteger(turn.turnsLeft), "chat turnsLeft is missing");
  messages.push({ role: "assistant", content: turn.reply });
  if (turn.done) {
    must(isRecord(turn.closing), "done chat response has no patient closing");
    must(turn.result === undefined && turn.source === undefined, "done chat exposed clinician-only fields");
  }

  const firstFinalize = await client.request("/api/chat/finalize", {
    method: "POST",
    body: { sessionId: start.sessionId },
    timeoutMs: 750_000,
  });
  must(isRecord(firstFinalize.closing), "first finalize has no patient closing");
  must(firstFinalize.result === undefined && firstFinalize.source === undefined, "first finalize exposed clinician-only fields");
  if (turn.done) must(firstFinalize.replayed === true, "completed chat finalize is not replayed");

  const secondFinalize = await client.request("/api/chat/finalize", {
    method: "POST",
    body: { sessionId: start.sessionId },
    timeoutMs: 30_000,
  });
  must(secondFinalize.replayed === true, "second finalize is not marked replayed");
  must(secondFinalize.result === undefined && secondFinalize.source === undefined, "second finalize exposed clinician-only fields");
  must(sameJson(firstFinalize.closing, secondFinalize.closing), "idempotent finalize changed patient closing");

  const completed = await client.request("/api/chat", {
    method: "POST",
    body: { sessionId: start.sessionId, message: "Дополнительный вопрос" },
    expectedStatus: 409,
  });
  must(completed.code === "SESSION_COMPLETED", "completed session did not return SESSION_COMPLETED");

  const intake = await client.request(`/api/workspace/intakes/${encodeURIComponent(start.sessionId)}`, {
    timeoutMs: 30_000,
  });
  must(isRecord(intake.intake) && isRecord(intake.intake.result), "workspace intake has no TriageResult");
  const result = intake.intake.result;

  assertSmokeResult(result, messages);
  scenario.verify(result);
  must(client.count() === SCENARIO1_HTTP_CAP, "scenario 1 did not execute exactly eight HTTP requests");

  const model = result.model;
  return {
    schema_version: 1,
    level: "PROD_E2E_SCENARIO_1",
    ok: true,
    production_origin: expectedOrigin,
    expected_origin_verified: true,
    health_commit: health.commit,
    health_model_version: health.model_version,
    health_llm_ok: health.llm_ok,
    health_processing_mode: health.processing_mode,
    http_requests: client.count(),
    http_cap: SCENARIO1_HTTP_CAP,
    client_retries: 0,
    scenario: {
      number: 1,
      patient_lines: scenario.lines.length,
    },
    result: {
      urgency: result.urgency,
      source: result.source,
      emergency_chest_pain: true,
      routing_verified: true,
      evidence_verified: true,
      disclaimer_verified: true,
      model_present: model !== undefined,
      model_version: model?.model_version ?? null,
      abstained: model?.abstained ?? null,
      abstain_reason: model?.abstain_reason ?? null,
      unsupported_model_outputs_empty: model?.abstained === true
        ? model.pathologies.length === 0 && model.top_contributions.length === 0
        : null,
      finalize_result_equal: true,
      finalize_replayed: true,
      completed_chat_409: true,
    },
    one_shot_guard: "fixed_commit_marker_reserved_before_fetch",
    telegram_delivery: "not observable from the public API; no delivery claim",
  };
}

function nodeErrorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

async function assertNoSymlinkComponents(path) {
  const parts = resolve(path).split(sep).filter(Boolean);
  let current = sep;
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstat(current);
    must(!info.isSymbolicLink(), "artifact path contains a symlink", "ARTIFACT_PATH_UNSAFE");
    must(info.isDirectory(), "artifact ancestor is not a directory", "ARTIFACT_PATH_UNSAFE");
  }
}

async function assertOwnedSafeDirectory(path) {
  const info = await lstat(path);
  must(!info.isSymbolicLink() && info.isDirectory(), "trusted artifact directory is unsafe", "ARTIFACT_PATH_UNSAFE");
  if (typeof process.getuid === "function") {
    must(info.uid === process.getuid(), "trusted artifact directory has another owner", "ARTIFACT_PATH_UNSAFE");
  }
  must((info.mode & 0o002) === 0, "trusted artifact directory is world-writable", "ARTIFACT_PATH_UNSAFE");
  return info;
}

async function assertPinnedDirectory(path, pinned) {
  const current = await lstat(path);
  must(
    current.isDirectory() && !current.isSymbolicLink(),
    "artifact directory binding changed",
    "ARTIFACT_PATH_UNSAFE",
  );
  must(
    current.dev === pinned.dev && current.ino === pinned.ino,
    "artifact directory identity changed",
    "ARTIFACT_PATH_UNSAFE",
  );
  if (typeof process.getuid === "function") {
    must(current.uid === process.getuid(), "artifact directory owner changed", "ARTIFACT_PATH_UNSAFE");
  }
  must((current.mode & 0o002) === 0, "artifact directory became world-writable", "ARTIFACT_PATH_UNSAFE");
}

async function ensureDefaultArtifactRoot() {
  const reportsRoot = resolve(ROOT, "reports");
  await assertNoSymlinkComponents(ROOT);
  for (const directory of [reportsRoot, DEFAULT_ARTIFACT_ROOT]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") {
        fail("ARTIFACT_PATH_UNSAFE", "default artifact directory creation failed");
      }
    }
    try {
      await assertOwnedSafeDirectory(directory);
    } catch (error) {
      if (error instanceof SmokeError) throw error;
      fail("ARTIFACT_PATH_UNSAFE", "default artifact directory validation failed");
    }
  }
}

async function assertFinalDoesNotExist(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail("ARTIFACT_PATH_UNSAFE", "artifact target is a symlink");
    fail("ARTIFACT_EXISTS", "artifact already exists");
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    if (nodeErrorCode(error) !== "ENOENT") fail("ARTIFACT_RESERVATION_FAILED", "artifact reservation failed");
  }
}

async function reserveArtifact(path, trustedRoot) {
  must(
    isAbsolute(path) && /^\/[A-Za-z0-9._/-]+\.json$/.test(path) && !path.includes("/../"),
    "SMOKE_ARTIFACT must be a safe absolute .json path",
    "ARTIFACT_PATH_UNSAFE",
  );
  must(isAbsolute(trustedRoot), "SMOKE_ARTIFACT_ROOT must be absolute", "ARTIFACT_PATH_UNSAFE");

  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(trustedRoot);
  const resolvedParent = dirname(resolvedPath);
  const fromRoot = relative(resolvedRoot, resolvedPath);
  must(
    fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot),
    "artifact path escapes the trusted root",
    "ARTIFACT_PATH_UNSAFE",
  );

  await assertFinalDoesNotExist(resolvedPath);
  try {
    await assertNoSymlinkComponents(resolvedRoot);
    const pinnedRoot = await assertOwnedSafeDirectory(resolvedRoot);
    const inner = relative(resolvedRoot, resolvedParent);
    if (inner) {
      let current = resolvedRoot;
      for (const part of inner.split(sep)) {
        current = resolve(current, part);
        await assertOwnedSafeDirectory(current);
      }
    }
    const pinnedParent = resolvedParent === resolvedRoot
      ? pinnedRoot
      : await assertOwnedSafeDirectory(resolvedParent);
    must(await realpath(resolvedRoot) === resolvedRoot, "trusted artifact root is not real", "ARTIFACT_PATH_UNSAFE");
    must(await realpath(resolvedParent) === resolvedParent, "artifact parent is not real", "ARTIFACT_PATH_UNSAFE");
    await assertPinnedDirectory(resolvedRoot, pinnedRoot);
    if (resolvedParent !== resolvedRoot) {
      await assertPinnedDirectory(resolvedParent, pinnedParent);
    }
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    fail("ARTIFACT_PATH_UNSAFE", "artifact directory validation failed");
  }

  let handle;
  try {
    handle = await open(
      resolvedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") fail("ARTIFACT_EXISTS", "artifact already exists");
    if (nodeErrorCode(error) === "ELOOP") fail("ARTIFACT_PATH_UNSAFE", "artifact target is unsafe");
    fail("ARTIFACT_RESERVATION_FAILED", "artifact reservation failed");
  }

  try {
    const info = await handle.stat();
    must(info.isFile() && info.nlink === 1, "artifact reservation is not a single regular file", "ARTIFACT_PATH_UNSAFE");
    must((info.mode & 0o777) === 0o600, "artifact reservation mode is not 0600", "ARTIFACT_PATH_UNSAFE");
    if (typeof process.getuid === "function") {
      must(info.uid === process.getuid(), "artifact reservation has another owner", "ARTIFACT_PATH_UNSAFE");
    }
    must(await realpath(resolvedParent) === resolvedParent, "artifact parent changed during reservation", "ARTIFACT_PATH_UNSAFE");
    return {
      handle,
      path: resolvedPath,
      parent: resolvedParent,
      dev: info.dev,
      ino: info.ino,
    };
  } catch (error) {
    await handle.close();
    if (error instanceof SmokeError) throw error;
    fail("ARTIFACT_PATH_UNSAFE", "artifact reservation verification failed");
  }
}

async function assertReservationStillBound(reservation) {
  try {
    const parent = await realpath(reservation.parent);
    const target = await lstat(reservation.path);
    const descriptor = await reservation.handle.stat();
    must(
      descriptor.isFile() && target.isFile() && !target.isSymbolicLink(),
      "artifact target changed",
      "ARTIFACT_PATH_UNSAFE",
    );
    must(
      descriptor.nlink === 1 && target.nlink === 1,
      "artifact hardlink count changed",
      "ARTIFACT_PATH_UNSAFE",
    );
    must(
      (descriptor.mode & 0o777) === 0o600 && (target.mode & 0o777) === 0o600,
      "artifact mode changed",
      "ARTIFACT_PATH_UNSAFE",
    );
    if (typeof process.getuid === "function") {
      must(
        descriptor.uid === process.getuid() && target.uid === process.getuid(),
        "artifact owner changed",
        "ARTIFACT_PATH_UNSAFE",
      );
    }
    must(parent === reservation.parent, "artifact parent changed", "ARTIFACT_PATH_UNSAFE");
    must(
      descriptor.dev === reservation.dev &&
        descriptor.ino === reservation.ino &&
        target.dev === reservation.dev &&
        target.ino === reservation.ino,
      "artifact inode changed",
      "ARTIFACT_PATH_UNSAFE",
    );
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    fail("ARTIFACT_PATH_UNSAFE", "artifact binding verification failed");
  }
}

export async function executeScenario1Once({
  baseUrl = CANONICAL_BASE,
  expectedOrigin = CANONICAL_BASE,
  expectedCommit = "",
  optIn = "",
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
  fetchImpl = globalThis.fetch,
  workspaceCookie = process.env.DEMEU_WORKSPACE_COOKIE ?? "",
  tlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED,
} = {}) {
  must(optIn === SCENARIO1_ONCE_OPT_IN, "live scenario 1 one-shot opt-in is missing");
  must(tlsRejectUnauthorized !== "0", "TLS certificate verification is disabled");
  const productionOrigin = validateBase(baseUrl, expectedOrigin);
  must(
    typeof expectedCommit === "string" && /^[0-9a-f]{7}$/.test(expectedCommit),
    "EXPECTED_COMMIT must be exactly seven lowercase hexadecimal characters",
    "EXPECTED_COMMIT_INVALID",
  );

  const resolvedRoot = resolve(artifactRoot);
  if (resolvedRoot === DEFAULT_ARTIFACT_ROOT) await ensureDefaultArtifactRoot();
  const originHash = createHash("sha256").update(productionOrigin).digest("hex");
  const hostnameSlug = new URL(productionOrigin).hostname
    .replaceAll(".", "-")
    .slice(0, 48)
    .replace(/-+$/u, "");
  const originSuffix = productionOrigin === LEGACY_PRODUCTION_ORIGIN
    ? ""
    : `-${hostnameSlug}-${originHash}`;
  const artifactPath = resolve(
    resolvedRoot,
    `prod-s1-${expectedCommit}${originSuffix}-once.json`,
  );
  const artifact = await reserveArtifact(artifactPath, resolvedRoot);
  let payload;
  let failure;
  try {
    payload = await runScenario1Once({
      baseUrl,
      expectedOrigin: productionOrigin,
      expectedCommit,
      fetchImpl,
      workspaceCookie,
    });
  } catch (error) {
    failure = error;
    payload = {
      schema_version: 1,
      level: "PROD_E2E_SCENARIO_1",
      ok: false,
      production_origin: productionOrigin,
      health_commit: expectedCommit,
      error: safeError(error),
      http_cap: SCENARIO1_HTTP_CAP,
      client_retries: 0,
      one_shot_guard: "fixed_commit_marker_reserved_before_fetch",
      telegram_delivery: "not observable from the public API; no delivery claim",
    };
  }
  try {
    await assertReservationStillBound(artifact);
    await artifact.handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await artifact.handle.close();
  }
  if (failure) throw failure;
  return { artifactPath, payload };
}

async function main() {
  const level = process.argv[2];
  must(level === "l1" || level === "l2" || level === "scenario1-once", "usage: smoke.mjs l1|l2|scenario1-once");
  if (level === "scenario1-once") {
    const expectedOrigin = process.env.EXPECTED_PRODUCTION_ORIGIN ?? CANONICAL_BASE;
    const baseUrl = process.env.BASE_URL ?? expectedOrigin;
    const result = await executeScenario1Once({
      baseUrl,
      expectedOrigin,
      expectedCommit: process.env.EXPECTED_COMMIT,
      optIn: process.env.DEMEU_SCENARIO1_LIVE,
    });
    process.stdout.write(`PASS ${result.payload.level}; fixed one-shot marker written\n`);
    return;
  }
  const expectedOptIn = level === "l1" ? L1_OPT_IN : L2_OPT_IN;
  must(process.env.DEMEU_SMOKE_LIVE === expectedOptIn, `live ${level.toUpperCase()} opt-in is missing`);
  must(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "TLS certificate verification is disabled");
  const expectedOrigin = process.env.EXPECTED_PRODUCTION_ORIGIN ?? CANONICAL_BASE;
  const baseUrl = process.env.BASE_URL ?? expectedOrigin;
  validateBase(baseUrl, expectedOrigin);

  const hasCustomRoot = process.env.SMOKE_ARTIFACT_ROOT !== undefined;
  const hasCustomArtifact = process.env.SMOKE_ARTIFACT !== undefined;
  if (hasCustomArtifact) {
    must(
      isAbsolute(process.env.SMOKE_ARTIFACT) &&
        /^\/[A-Za-z0-9._/-]+\.json$/.test(process.env.SMOKE_ARTIFACT) &&
        !process.env.SMOKE_ARTIFACT.includes("/../"),
      "SMOKE_ARTIFACT must be a safe absolute .json path",
      "ARTIFACT_PATH_UNSAFE",
    );
  }
  if (hasCustomArtifact && !hasCustomRoot) {
    await assertFinalDoesNotExist(resolve(process.env.SMOKE_ARTIFACT));
  }
  must(
    hasCustomRoot === hasCustomArtifact,
    "SMOKE_ARTIFACT_ROOT and SMOKE_ARTIFACT must be supplied together",
    "ARTIFACT_CUSTOM_PAIR_REQUIRED",
  );
  if (!hasCustomRoot) await ensureDefaultArtifactRoot();

  const defaultArtifact = resolve(DEFAULT_ARTIFACT_ROOT, `demeu-smoke-${level}-${Date.now()}.json`);
  const configuredArtifact = process.env.SMOKE_ARTIFACT ?? defaultArtifact;
  must(isAbsolute(configuredArtifact), "SMOKE_ARTIFACT must be absolute");
  const artifactPath = resolve(configuredArtifact);
  const artifactRoot = resolve(process.env.SMOKE_ARTIFACT_ROOT ?? DEFAULT_ARTIFACT_ROOT);
  const artifact = await reserveArtifact(artifactPath, artifactRoot);
  let payload;
  let exitCode = 0;
  try {
    payload = level === "l1"
      ? await runL1({ baseUrl, expectedOrigin, workspaceCookie: process.env.DEMEU_WORKSPACE_COOKIE ?? "" })
      : await runL2({ baseUrl, expectedOrigin, workspaceCookie: process.env.DEMEU_WORKSPACE_COOKIE ?? "" });
  } catch (error) {
    payload = { level: level.toUpperCase(), ok: false, error: safeError(error) };
    exitCode = 1;
  }
  try {
    await assertReservationStillBound(artifact);
    await artifact.handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await artifact.handle.close();
  }
  process.stdout.write(`${payload.ok ? "PASS" : "FAIL"} ${payload.level}; sanitized artifact written\n`);
  process.exitCode = exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`FAIL ${safeConsoleError(error)}\n`);
    process.exitCode = 1;
  }
}
