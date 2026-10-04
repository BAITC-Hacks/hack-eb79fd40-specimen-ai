import { spawn } from "node:child_process";
import { randomBytes, scrypt, createHash } from "node:crypto";
import { once } from "node:events";
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOTAL_TIMEOUT_MS = 240_000;
const REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 90_000;
const BUILD_TIMEOUT_MS = 150_000;
const SAFE_ROOT_ENTRIES = new Set([
  "app", "assets", "data", "docs", "eval", "lib", "models", "reports", "scripts",
  "next.config.mjs", "next-env.d.ts", "package.json", "package-lock.json", "tsconfig.json", ".env.example",
]);
const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];
const FORBIDDEN_ROOTS = new Set([".git", ".next", "node_modules", ".venv", ".unlazy", ".playwright-mcp", ".worktrees", "secrets"]);
const APP_TOKEN = "local-mock-token";

export function finalizationSnapshotFilter(source, root = ROOT) {
  const path = relative(root, source);
  if (!path) return true;
  const parts = path.split(sep);
  if (!SAFE_ROOT_ENTRIES.has(parts[0]) || FORBIDDEN_ROOTS.has(parts[0])) return false;
  if (parts.some((part) => part.startsWith(".env") && part !== ".env.example")) return false;
  if (parts[0] === "data" && ["raw", "processed", "runtime"].includes(parts[1])) return false;
  if (parts[0] === "docs" && parts.length > 1 && parts[1] !== "openapi.json") return false;
  if (parts[0] === "models" && parts.length > 1 && !parts.at(-1)?.endsWith(".json")) return false;
  return true;
}

export function isolatedFinalizationEnv(environment = process.env, overrides = {}) {
  const result = {};
  for (const key of SAFE_ENV_KEYS) if (typeof environment[key] === "string") result[key] = environment[key];
  return { ...result, NEXT_TELEMETRY_DISABLED: "1", CI: "1", ...overrides };
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function derivePassword(password, salt) {
  return new Promise((resolveKey, reject) => scrypt(password, salt, 64,
    { N: 16_384, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 },
    (error, key) => error ? reject(error) : resolveKey(key)));
}

async function passwordHash(password) {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `scrypt$16384$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

export async function allocateFinalizationResources(deps = {}) {
  const makeTemp = deps.makeTemp ?? mkdtemp;
  const findPort = deps.findPort ?? freePort;
  const remove = deps.remove ?? rm;
  let snapshot; let privateRuntime;
  try {
    snapshot = await makeTemp(join(tmpdir(), "demeu-finalization-src-"));
    privateRuntime = await makeTemp(join(tmpdir(), "demeu-finalization-data-"));
    const appPort = await findPort(); const telegramPort = await findPort();
    return { snapshot, privateRuntime, appPort, telegramPort };
  } catch (error) {
    await Promise.allSettled([snapshot ? remove(snapshot, { recursive: true, force: true }) : Promise.resolve(),
      privateRuntime ? remove(privateRuntime, { recursive: true, force: true }) : Promise.resolve()]);
    throw error;
  }
}

async function assertPortCanRebind(port) {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.listen(port, "127.0.0.1", resolveListen).once("error", reject));
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function spawnCaptured(label, command, args, options) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  let markerCarry = ""; let externalFetchBlocked = false;
  const marker = "DEMEU_FINALIZATION_EXTERNAL_FETCH_BLOCKED";
  const append = (chunk) => {
    const text = chunk.toString("utf8");
    externalFetchBlocked ||= `${markerCarry}${text}`.includes(marker);
    markerCarry = `${markerCarry}${text}`.slice(-(marker.length - 1));
    tail = `${tail}${text}`.slice(-30_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => append(Buffer.from(`${label}: ${error.message}\n`)));
  return { label, child, tail: () => tail, externalFetchBlocked: () => externalFetchBlocked };
}
export { spawnCaptured as spawnFinalizationCaptured };

async function stopProcess(processInfo) {
  const child = processInfo?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  let timeout;
  await Promise.race([once(child, "exit"), new Promise((resolveTimeout) => {
    timeout = setTimeout(resolveTimeout, 5_000); timeout.unref?.();
  })]);
  if (timeout) clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { return; }
    await Promise.race([once(child, "exit"), new Promise((resolveTimeout) => {
      timeout = setTimeout(resolveTimeout, 5_000); timeout.unref?.();
    })]);
    if (timeout) clearTimeout(timeout);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error(`${processInfo.label.toUpperCase()}_STOP_TIMEOUT`);
}
export { stopProcess as stopFinalizationProcess };

async function waitReady(url, processInfo, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) throw new Error(`${processInfo.label} exited before readiness`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* starting */ }
    await delay(250);
  }
  throw new Error(`${processInfo.label} readiness timeout`);
}

async function waitSuccessful(processInfo, timeoutMs = READY_TIMEOUT_MS) {
  let timeout;
  const exited = await Promise.race([once(processInfo.child, "exit"), new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout([null, "TIMEOUT"]), timeoutMs); timeout.unref?.();
  })]);
  if (timeout) clearTimeout(timeout);
  const [code, signal] = exited;
  if (code !== 0) throw new Error(`${processInfo.label.toUpperCase()}_${signal === "TIMEOUT" ? "TIMEOUT" : "FAILED"}`);
}

class CookieJar {
  constructor() { this.cookies = new Map(); }
  absorb(response) {
    const headers = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")].filter(Boolean);
    for (const header of headers) {
      const [pair, ...attrs] = header.split(";").map((item) => item.trim());
      const split = pair.indexOf("=");
      if (split < 1) continue;
      const name = pair.slice(0, split); const value = pair.slice(split + 1);
      const path = attrs.find((attr) => attr.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
      if (/max-age=0/i.test(header)) this.cookies.delete(name); else this.cookies.set(name, { value, path });
    }
  }
  header(path) {
    return [...this.cookies].filter(([, item]) => path.startsWith(item.path)).map(([name, item]) => `${name}=${item.value}`).join("; ");
  }
}

function client(baseUrl, address) {
  const jar = new CookieJar();
  return {
    jar,
    async request(path, { method = "GET", body, expected = 200, headers = {}, format = "json" } = {}) {
      const cookie = jar.header(path);
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "x-forwarded-for": address,
          ...(body === undefined ? {} : { "content-type": "application/json", origin: baseUrl }),
          ...(cookie ? { cookie } : {}), ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      jar.absorb(response);
      if (response.status !== expected) {
        await response.body?.cancel();
        throw new Error(`HTTP_STATUS_${expected}_${response.status}`);
      }
      if (format === "buffer") return { response, value: Buffer.from(await response.arrayBuffer()) };
      if (format === "text") return { response, value: await response.text() };
      return { response, value: await response.json() };
    },
  };
}

async function login(api, id, password) {
  await api.request("/api/workspace/auth", { method: "POST", body: { id, password } });
}

async function createAccounts(runtime, password) {
  const hash = await passwordHash(password);
  const organizationId = "clinic-a";
  const accounts = [
    ["doctor-a", "doctor", organizationId, "100001"],
    ["doctor-b", "doctor", organizationId, "100002"],
    ["owner-a", "owner", organizationId, undefined],
    ["analyst-a", "analyst", organizationId, undefined],
    ["doctor-foreign", "doctor", "clinic-b", "100003"],
  ].map(([id, role, org, telegramChatId]) => ({
    id, displayName: `Local ${role}`, role, organizationId: org,
    organizationDisplayName: org === organizationId ? "Local clinic" : "Other clinic",
    ...(telegramChatId ? { telegramChatId } : {}), passwordHash: hash, sessionVersion: 1,
  }));
  const file = join(runtime, "accounts.json");
  await writeFile(file, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

async function createMisCredentials(runtime, secret) {
  const secretHash = createHash("sha256").update("demeu:mis:credential:v1\0").update(secret).digest("hex");
  const file = join(runtime, "mis-credentials.json");
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, integrations: [{
    integrationId: "local-integration", organizationId: "clinic-a", enabled: true,
    keys: [{ credentialId: "local-key", secretHash: `sha256$${secretHash}`, enabled: true,
      scopes: ["events:pull", "events:ack", "events:research"], expiresAt: null }],
  }] }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

async function writeGuard(snapshot, telegramPort) {
  const file = join(snapshot, "finalization-fetch-guard.mjs");
  await writeFile(file, `
const originalFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const raw = typeof input === "string" || input instanceof URL ? input : input.url;
  const url = new URL(raw);
  if (url.hostname === "api.telegram.org" && url.pathname.startsWith("/bot${APP_TOKEN}/")) {
    url.protocol = "http:"; url.hostname = "127.0.0.1"; url.port = "${telegramPort}";
    return originalFetch(url, init);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    process.stderr.write("DEMEU_FINALIZATION_EXTERNAL_FETCH_BLOCKED " + url.origin + "\\n");
    throw new Error("External fetch blocked by finalization smoke");
  }
  return originalFetch(input, init);
};
process.stderr.write("DEMEU_FINALIZATION_FETCH_GUARD_READY\\n");
`);
  return file;
}

async function assertSnapshot(snapshot) {
  const entries = await readdir(snapshot, { recursive: true });
  const leaks = entries.filter((entry) => {
    const parts = entry.split(sep);
    return parts.some((part) => FORBIDDEN_ROOTS.has(part) || (part.startsWith(".env") && part !== ".env.example")) ||
      (parts[0] === "data" && ["raw", "processed", "runtime"].includes(parts[1]));
  });
  if (leaks.length) throw new Error(`Unsafe snapshot entries: ${leaks.slice(0, 5).map(basename).join(",")}`);
  await access(join(snapshot, "models", "referral-risk-v1.json"));
}

async function chat(api, doctor, language, answers) {
  const link = (await doctor.request("/api/link", { method: "POST", body: {} })).value;
  const started = (await api.request("/api/chat/start", { method: "POST", body: { token: link.token, language } })).value;
  if (!started.sessionId || !started.preparationUrl) throw new Error("Chat did not issue a patient preparation capability");
  if (language === "ru" ? !started.reply?.startsWith("Здравствуйте") : !started.reply?.startsWith("Сәлеметсіз бе")) {
    throw new Error("Patient greeting language mismatch");
  }
  let final;
  for (const message of answers) {
    final = (await api.request("/api/chat", { method: "POST", body: { sessionId: started.sessionId, message } })).value;
    if (final.done) break;
  }
  if (!final?.done || "result" in final || !final.closing) throw new Error("Patient chat completion contract failed");
  if (language === "ru" ? !final.reply?.includes("врачу") : !final.reply?.includes("дәрігер")) throw new Error("Patient completion language mismatch");
  return { sessionId: started.sessionId, preparationUrl: started.preparationUrl, closing: final.closing };
}

async function waitTelegram(baseUrl, minimum) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/outbox`, { signal: AbortSignal.timeout(2_000) });
    const outbox = (await response.json()).outbox;
    if (outbox.length >= minimum && outbox.filter((item) => item.method === "sendDocument").length >= 3) return outbox;
    await delay(250);
  }
  throw new Error("Telegram delivery journal did not settle");
}

async function seedAnalytics(doctorA, doctorB) {
  for (let index = 0; index < 10; index += 1) {
    const actor = index % 2 ? doctorB : doctorA;
    let referral = (await actor.request("/api/referrals", { method: "POST", body: {
      patientLabel: `Local patient ${index + 1}`, profile: "Хирургический", icd10Code: "K80.2",
      destinationOrganization: "Local clinic", idempotencyKey: `smoke-seed-create-${index}`,
    } })).value.referral;
    referral = (await actor.request(`/api/referrals/${referral.id}/doctor-assessment`, { method: "POST", body: {
      expectedRevision: referral.revision, expectedAssessmentRevision: 0, idempotencyKey: `smoke-seed-assess-${index}`,
      reason: "Local integrated smoke", assessment: { hypothesis: "Учебное заключение врача", profile: "Хирургический", icd10Code: "K80.2", careContext: "operative" },
    } })).value.referral;
    if (index >= 5) await actor.request(`/api/referrals/${referral.id}/events`, { method: "POST", body: {
      expectedRevision: referral.revision, idempotencyKey: `smoke-seed-event-${index}`,
      patch: index < 8 ? { queue: true } : { scheduledDate: day(7) }, reason: "Local integrated smoke",
    } });
  }
}

function assertPdf(value) {
  if (value.length < 500 || value.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Patient PDF contract failed");
}

async function exercise(baseUrl, telegramBase, password, bearer, runtime, snapshot) {
  const doctorA = client(baseUrl, "127.0.0.11"); const doctorB = client(baseUrl, "127.0.0.12");
  const owner = client(baseUrl, "127.0.0.13"); const analyst = client(baseUrl, "127.0.0.14");
  const foreign = client(baseUrl, "127.0.0.15"); const anonymous = client(baseUrl, "127.0.0.16");
  await Promise.all([
    login(doctorA, "doctor-a", password), login(doctorB, "doctor-b", password), login(owner, "owner-a", password),
    login(analyst, "analyst-a", password), login(foreign, "doctor-foreign", password),
  ]);
  await anonymous.request("/api/referrals", { expected: 401 });
  await analyst.request("/api/referrals", { expected: 403 });
  await owner.request("/api/link", { method: "POST", body: {}, expected: 403 });
  await seedAnalytics(doctorA, doctorB);

  const ruPatient = client(baseUrl, "127.0.0.21");
  const ru = await chat(ruPatient, doctorA, "ru", ["Болит поясница", "Вчера", "Поясница, ноет", "4 из 10", "Температуры нет", "Операций не было", "Гипертония", "Аллергий нет", "Лекарств не принимаю", "34 года, женщина, беременности нет"]);
  const kkPatient = client(baseUrl, "127.0.0.22");
  const kk = await chat(kkPatient, doctorB, "kk", ["Белім ауырады", "Кеше", "Белім сыздайды", "10 ұпайдан 4", "Қызу жоқ", "Операция болған жоқ", "Қан қысымы жоғары", "Аллергия жоқ", "Дәрі қабылдамаймын", "34 жас, әйел, жүктілік жоқ"]);
  const emergencyPatient = client(baseUrl, "127.0.0.23");
  const emergency = await chat(emergencyPatient, doctorA, "kk", ["Кеудемді қатты қысады, дем алуым қиындады"]);
  if (!emergency.closing.emergency) throw new Error("KK emergency did not finish before another question");

  const ruIntake = (await doctorA.request(`/api/workspace/intakes/${ru.sessionId}`)).value.intake;
  if (ruIntake.result?.processing_mode !== "deterministic" || ruIntake.result?.source !== "rules_only") throw new Error("RU deterministic intake missing");
  const kkIntake = (await doctorB.request(`/api/workspace/intakes/${kk.sessionId}`)).value.intake;
  if (kkIntake.result?.processing_mode !== "deterministic" || kkIntake.result?.source !== "rules_only") throw new Error("KK deterministic intake missing");
  await foreign.request(`/api/workspace/intakes/${ru.sessionId}`, { expected: 404 });
  await doctorB.request(`/api/workspace/intakes/${ru.sessionId}`, { expected: 404 });
  await doctorA.request(`/api/workspace/intakes/${kk.sessionId}`, { expected: 404 });
  await analyst.request(`/api/workspace/intakes/${ru.sessionId}`, { expected: 404 });
  const emergencyIntake = (await doctorA.request(`/api/workspace/intakes/${emergency.sessionId}`)).value.intake;
  if (emergencyIntake.result?.urgency !== "emergency") throw new Error("Emergency intake is not emergency");

  let referral = (await doctorA.request("/api/referrals", { method: "POST", body: {
    patientLabel: "Local linked patient", profile: "Хирургический", icd10Code: "K80.2", destinationOrganization: "Local clinic",
    sourceSessionId: ru.sessionId, idempotencyKey: "smoke-linked-create",
  } })).value.referral;
  await foreign.request(`/api/referrals/${referral.id}`, { expected: 404 });
  await doctorB.request(`/api/referrals/${referral.id}`, { expected: 404 });
  await owner.request(`/api/referrals/${referral.id}/doctor-assessment`, { method: "POST", body: {}, expected: 403 });
  referral = (await doctorA.request(`/api/referrals/${referral.id}/doctor-assessment`, { method: "POST", body: {
    expectedRevision: referral.revision, expectedAssessmentRevision: 0, idempotencyKey: "smoke-linked-assess", reason: "Local integrated smoke",
    assessment: { hypothesis: "Учебное заключение врача", profile: "Хирургический", icd10Code: "K80.2", careContext: "operative" },
  } })).value.referral;

  const token = new URL(ru.preparationUrl, baseUrl).pathname.split("/").at(-1);
  const packageClient = client(baseUrl, "127.0.0.24");
  let patientPackage = (await packageClient.request("/api/patient/access", { method: "POST", body: { token } })).value.package;
  const expires = patientPackage.expiresAt - Date.now();
  if (expires < 29 * 86_400_000 || expires > 31 * 86_400_000) throw new Error("Patient capability TTL is outside the 30-day contract");
  for (const forbidden of ["triage", "risk", "transcript", "messages", "red_flags"]) {
    if (JSON.stringify(patientPackage).toLowerCase().includes(`\"${forbidden}\"`)) throw new Error(`Patient package leaked ${forbidden}`);
  }
  const otherDevice = client(baseUrl, "127.0.0.25");
  const otherPackage = (await otherDevice.request("/api/patient/access", { method: "POST", body: { token } })).value.package;
  if (otherPackage.accessId !== patientPackage.accessId) throw new Error("Other-device patient exchange changed package identity");
  const requirements = patientPackage.items.filter((item) => item.conditional === false).slice(0, 2);
  if (requirements.length < 2) throw new Error("Patient checklist lacks two required items");
  for (const [index, requirement] of requirements.entries()) {
    const response = await packageClient.request(`/api/patient/${patientPackage.accessId}/package`, { method: "POST", body: {
      requirementId: requirement.requirementId, performedOn: day(-1), resultAvailable: true,
      expectedRevision: 0, idempotencyKey: `smoke-patient-report-${index}`,
    } });
    patientPackage = response.value.package;
  }
  const ruPdf = await packageClient.request(`/api/patient/${patientPackage.accessId}/package?format=pdf&lang=ru`, { format: "buffer" });
  const kkPdf = await packageClient.request(`/api/patient/${patientPackage.accessId}/package?format=pdf&lang=kk`, { format: "buffer" });
  assertPdf(ruPdf.value); assertPdf(kkPdf.value);
  const [ruDocument, kkDocument] = await Promise.all([PDFDocument.load(ruPdf.value), PDFDocument.load(kkPdf.value)]);
  if (ruDocument.getPageCount() < 1 || kkDocument.getPageCount() < 1
    || createHash("sha256").update(ruPdf.value).digest("hex") === createHash("sha256").update(kkPdf.value).digest("hex")) {
    throw new Error("Patient PDF language variants are not distinct valid documents");
  }
  const detail = (await doctorA.request(`/api/referrals/${referral.id}`)).value.referral;
  const pending = detail.patientReports ?? [];
  if (pending.length < 2) throw new Error("Patient self-reports were not separate pending records");
  const confirmed = await doctorA.request(`/api/referrals/${referral.id}/patient-reports/confirm`, { method: "POST", body: {
    reportId: pending[0].id, expectedRevision: detail.revision, expectedReportRevision: pending[0].revision,
    idempotencyKey: "smoke-confirm-patient-report",
  } });
  referral = confirmed.value.referral;
  if (!referral.examinations?.some((item) => item.patientReportId === pending[0].id)) throw new Error("Clinician confirmation missing");
  const currentPackage = (await packageClient.request(`/api/patient/${patientPackage.accessId}/package`)).value.package;
  if (currentPackage.catalogueAvailable !== false || currentPackage.confirmedCompleteness !== "unknown") {
    throw new Error("Unvalidated catalogue was presented as verified readiness");
  }

  referral = (await doctorA.request(`/api/referrals/${referral.id}/registration-snapshot`, { method: "POST", body: {
    expectedRevision: referral.revision, idempotencyKey: "smoke-registration", attestedAtRegistration: true,
    features: { bed_profile: null, icd10_ref_diag_code: "K80.2", referring_mo: "Local clinic", hospital_mo: "Local hospital",
      territorial_type: "urban", finance_source: "state", referral_purpose: "planned" },
  } })).value.referral;
  const risk = (await doctorA.request(`/api/referrals/${referral.id}/risk`)).value.risk;
  if (risk.status !== "available" || risk.researchOnly !== true || typeof risk.refusalProbabilityAmongMatureOutcomes !== "number") {
    throw new Error("B3 research response unavailable");
  }
  const mis = client(baseUrl, "127.0.0.31");
  const authorization = { authorization: `Bearer ${bearer}` };
  const pulled = (await mis.request("/api/mis/v1/events/pull", { method: "POST", body: { limit: 20 }, headers: authorization })).value;
  const event = pulled.events?.find((item) => item.subject?.referralId === referral.id && item.type === "referral.research_risk.changed");
  if (!event || !Number.isInteger(event.sequence)) throw new Error("MIS research state event missing");
  const expectedResearchState = risk.riskBand === "at_or_above_working_threshold" ? "high" : "below_threshold";
  if (event.data?.researchOnly !== true || event.data.state !== expectedResearchState) throw new Error("MIS research state differs from B3 response");
  if (pulled.events.some((item) => item.type === "referral.readiness.changed" && item.data?.state === "ready")) throw new Error("Unvalidated catalogue emitted a positive readiness event");
  const acknowledged = (await mis.request(`/api/mis/v1/events/${event.eventId}/ack`, { method: "POST", body: { deliveryId: event.deliveryId, idempotencyKey: "smoke-mis-ack" }, headers: authorization })).value;
  const replayedAck = (await mis.request(`/api/mis/v1/events/${event.eventId}/ack`, { method: "POST", body: { deliveryId: event.deliveryId, idempotencyKey: "smoke-mis-ack" }, headers: authorization })).value;
  if (acknowledged.eventId !== replayedAck.eventId || acknowledged.ackedAt !== replayedAck.ackedAt || acknowledged.acked !== true || replayedAck.replayed !== true) {
    throw new Error("MIS ACK replay changed the durable result");
  }
  await doctorA.request("/api/mis/v1/events/pull", { method: "POST", body: { limit: 1 }, expected: 401 });

  const aggregate = (await analyst.request("/api/workspace/aggregates")).value.aggregates;
  if (!Array.isArray(aggregate.groups) || aggregate.groups.some((group) => group.count < 5)) throw new Error("Analyst aggregate exposed a small group");
  const openapi = (await anonymous.request("/api/openapi")).value;
  const expectedOpenapi = JSON.parse(await readFile(join(snapshot, "docs/openapi.json"), "utf8"));
  if (JSON.stringify(openapi) !== JSON.stringify(expectedOpenapi)) throw new Error("Live OpenAPI differs from docs/openapi.json");
  const apiDocs = await anonymous.request("/api-docs", { format: "text" });
  if (!apiDocs.value.includes("OpenAPI") || apiDocs.value.includes(password) || apiDocs.value.includes(bearer)) throw new Error("API docs contract failed");

  const outbox = await waitTelegram(telegramBase, 6);
  const documents = outbox.filter((item) => item.method === "sendDocument");
  const document = await fetch(`${telegramBase}/document/${documents[0].documentId}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  assertPdf(Buffer.from(await document.arrayBuffer()));
  return {
    cookies: { doctorA, packageClient, chatPatient: ruPatient }, referralId: referral.id, sessionId: ru.sessionId, accessId: patientPackage.accessId,
    preparationToken: token,
    telegramCount: outbox.length, telegramDocuments: documents.length, mis, authorization,
    evidence: { languages: ["ru", "kk"], emergency: true, patientReports: pending.length, clinicianConfirmed: true,
      patientPdfLanguages: 2, sourceRetentionPending: true, riskStatus: risk.status, misSequence: event.sequence,
      aggregateVisibleGroups: aggregate.groups.length, aggregateSuppressed: aggregate.suppressed, openapiExact: true },
  };
}

async function startApp(snapshot, runtime, baseUrl, env) {
  const port = Number(new URL(baseUrl).port);
  const processInfo = spawnCaptured("app", process.execPath,
    [join(snapshot, ".next/standalone/server.js")],
    { cwd: snapshot, env: { ...env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port) } });
  await waitReady(`${baseUrl}/api/healthz`, processInfo);
  if (!processInfo.tail().includes("DEMEU_FINALIZATION_FETCH_GUARD_READY")) throw new Error("Finalization fetch guard did not start");
  if (!runtime) throw new Error("Runtime path missing");
  return processInfo;
}

async function run() {
  let snapshot; let privateRuntime; let appPort; let telegramPort;
  const processes = []; const applicationAudits = []; let app; let result; let primaryError; let cleanupError;
  let step = "SNAPSHOT";
  const auditApplication = (processInfo) => {
    if (!processInfo) return;
    applicationAudits.push(processInfo.tail());
    if (processInfo.externalFetchBlocked()) throw new Error("EXTERNAL_FETCH_BLOCKED");
  };
  let deadlineReached = false;
  const terminate = () => {
    deadlineReached = true;
    for (const item of processes) if (item.child.pid) try { process.kill(-item.child.pid, "SIGTERM"); } catch { /* already exited */ }
  };
  process.once("SIGINT", terminate); process.once("SIGTERM", terminate); process.once("SIGHUP", terminate);
  const timeout = setTimeout(() => {
    terminate();
  }, TOTAL_TIMEOUT_MS);
  try {
    ({ snapshot, privateRuntime, appPort, telegramPort } = await allocateFinalizationResources());
    const baseUrl = `http://127.0.0.1:${appPort}`; const telegramBase = `http://127.0.0.1:${telegramPort}`;
    const password = randomBytes(24).toString("base64url"); const misSecret = randomBytes(32).toString("base64url");
    const bearer = `local-key.${misSecret}`;
    await cp(ROOT, snapshot, { recursive: true, filter: (source) => finalizationSnapshotFilter(source, ROOT) });
    await assertSnapshot(snapshot);
    await symlink(join(ROOT, "node_modules"), join(snapshot, "node_modules"), "dir");
    const guard = await writeGuard(snapshot, telegramPort);
    const accountsFile = await createAccounts(privateRuntime, password);
    const misFile = await createMisCredentials(privateRuntime, misSecret);
    const commonEnv = isolatedFinalizationEnv(process.env, {
      NODE_ENV: "production", NODE_OPTIONS: `--import=${guard}`, DEMEU_PROCESSING_MODE: "deterministic",
      TELEGRAM_BOT_TOKEN: APP_TOKEN, DEMEU_MOCK_TELEGRAM_PORT: String(telegramPort),
      DEMEU_ACCOUNTS_FILE: accountsFile, DEMEU_DATA_DIR: privateRuntime,
      DEMEU_AUTH_SECRET: randomBytes(32).toString("hex"), APP_BASE_URL: baseUrl,
      DEMEU_MIS_CREDENTIALS_FILE: misFile, DEMEU_MIS_RESEARCH_EVENTS: "I_ACKNOWLEDGE_RESEARCH_ONLY",
      COMMIT_SHA: "local-finalization-smoke",
    });
    const telegram = spawnCaptured("telegram", process.execPath, [join(snapshot, "scripts/mock-telegram.mjs")], {
      cwd: snapshot, env: isolatedFinalizationEnv(process.env, { MOCK_TELEGRAM_PORT: String(telegramPort) }),
    });
    step = "BOOT";
    processes.push(telegram); await waitReady(`${telegramBase}/health`, telegram);
    const build = spawnCaptured("build", process.execPath, [join(snapshot, "node_modules/next/dist/bin/next"), "build"], {
      cwd: snapshot, env: commonEnv,
    });
    processes.push(build); await waitSuccessful(build, BUILD_TIMEOUT_MS);
    if (build.externalFetchBlocked()) throw new Error("EXTERNAL_FETCH_BLOCKED");
    processes.splice(processes.indexOf(build), 1);
    await mkdir(join(snapshot, ".next/standalone/.next"), { recursive: true });
    await cp(join(snapshot, ".next/static"), join(snapshot, ".next/standalone/.next/static"), { recursive: true });
    app = await startApp(snapshot, privateRuntime, baseUrl, commonEnv); processes.push(app);
    step = "INTEGRATED_FLOW";
    const state = await exercise(baseUrl, telegramBase, password, bearer, privateRuntime, snapshot);
    await stopProcess(app); auditApplication(app); processes.splice(processes.indexOf(app), 1); app = undefined;

    step = "RESTART_REPLAY";
    app = await startApp(snapshot, privateRuntime, baseUrl, commonEnv); processes.push(app);
    step = "RESTART_PACKAGE";
    await state.cookies.packageClient.request(`/api/patient/${state.accessId}/package`);
    step = "RESTART_LOGIN";
    await login(state.cookies.doctorA, "doctor-a", password);
    step = "RESTART_REFERRAL";
    await state.cookies.doctorA.request(`/api/referrals/${state.referralId}`);
    step = "RESTART_FINALIZE";
    await state.cookies.chatPatient.request("/api/chat/finalize", { method: "POST", body: { sessionId: state.sessionId } });
    step = "RESTART_MIS";
    const afterRestartPull = (await state.mis.request("/api/mis/v1/events/pull", { method: "POST", body: { limit: 20 }, headers: state.authorization })).value;
    if (afterRestartPull.events?.some((item) => item.subject?.referralId === state.referralId)) throw new Error("ACKed MIS event was redelivered after restart");
    await delay(1_000);
    const outboxAfterRestart = (await (await fetch(`${telegramBase}/outbox`)).json()).outbox;
    if (outboxAfterRestart.length !== state.telegramCount) throw new Error("Telegram delivery duplicated after restart/replay");
    await stopProcess(app); auditApplication(app); processes.splice(processes.indexOf(app), 1); app = undefined;

    step = "SOURCE_RETENTION";
    const sessionsFile = join(privateRuntime, "sessions.json");
    const sessions = JSON.parse(await readFile(sessionsFile, "utf8"));
    const source = sessions.sessions.find((item) => item.id === state.sessionId);
    if (!source) throw new Error("Persisted source session missing before retention probe");
    source.completedAt = Date.now() - 86_460_000;
    await writeFile(sessionsFile, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
    const sweep = spawnCaptured("retention-sweep", process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      `import { FileSessionStore } from ${JSON.stringify(pathToFileURL(join(snapshot, "lib/storage/session-store.ts")).href)}; const store = new FileSessionStore({ path: ${JSON.stringify(sessionsFile)} }); await store.sweepExpired(Date.now()); await store.close();`],
    { cwd: snapshot, env: isolatedFinalizationEnv(process.env, { NODE_ENV: "test", NODE_OPTIONS: `--import=${join(snapshot, "finalization-fetch-guard.mjs")}` }) });
    processes.push(sweep); await waitSuccessful(sweep, 30_000); processes.splice(processes.indexOf(sweep), 1);
    if (sweep.externalFetchBlocked()) throw new Error("EXTERNAL_FETCH_BLOCKED");
    app = await startApp(snapshot, privateRuntime, baseUrl, commonEnv); processes.push(app);
    await login(state.cookies.doctorA, "doctor-a", password);
    await state.cookies.doctorA.request(`/api/workspace/intakes/${state.sessionId}`, { expected: 404 });
    await state.cookies.doctorA.request(`/api/referrals/${state.referralId}`);
    const retainedPatient = client(baseUrl, "127.0.0.43");
    const retainedPackage = (await retainedPatient.request("/api/patient/access", { method: "POST", body: { token: state.preparationToken } })).value.package;
    if (retainedPackage.accessId !== state.accessId) throw new Error("Original patient URL changed identity after source retention");
    const retainedPdf = await retainedPatient.request(`/api/patient/${state.accessId}/package?format=pdf&lang=ru`, { format: "buffer" });
    assertPdf(retainedPdf.value);
    const journal = JSON.parse(await readFile(join(privateRuntime, "deliveries.json"), "utf8"));
    if (journal.schemaVersion !== 1 || !Array.isArray(journal.entries) || journal.entries.length < 3
      || journal.entries.some((entry) => entry.status !== "sent")) throw new Error("Durable Telegram delivery journal missing");
    auditApplication(app);
    if (applicationAudits.length !== 3) throw new Error("APP_GENERATION_AUDIT_INCOMPLETE");
    result = { ok: true, processingMode: "deterministic", anthropicRequestUpperBound: 0,
      isolation: { privateSnapshot: true, privateStorage: true, externalFetchBlocked: false },
      restart: { misAckNoRedelivery: true, telegramNoDuplicate: true, sourceExpiredPackageRetained: true },
      ...state.evidence, sourceRetentionPending: undefined };
  } catch (error) {
    primaryError = new Error(`STEP_${step}`);
    if (process.env.FINALIZATION_SMOKE_DEBUG === "1") {
      const safeMessage = error instanceof Error ? error.message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/giu, "[id]").replace(/[A-Za-z0-9_-]{32,}/gu, "[secret]").slice(0, 160) : "UNKNOWN";
      process.stderr.write(`FINALIZATION_SMOKE_CAUSE ${JSON.stringify(safeMessage)}\n`);
      const blocked = processes.flatMap((item) => item.tail().split(/\r?\n/u).filter((line) => line.startsWith("DEMEU_FINALIZATION_EXTERNAL_FETCH_BLOCKED ")));
      if (blocked.length) process.stderr.write(`${[...new Set(blocked)].join("\n")}\n`);
    }
  }
  finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", terminate); process.removeListener("SIGTERM", terminate); process.removeListener("SIGHUP", terminate);
    const stopResults = await Promise.allSettled([...processes].reverse().map((item) => stopProcess(item)));
    const removeResults = await Promise.allSettled([
      privateRuntime ? rm(privateRuntime, { recursive: true, force: true }) : Promise.resolve(),
      snapshot ? rm(snapshot, { recursive: true, force: true }) : Promise.resolve(),
    ]);
    const probeResults = await Promise.allSettled([
      appPort ? assertPortCanRebind(appPort) : Promise.resolve(), telegramPort ? assertPortCanRebind(telegramPort) : Promise.resolve(),
      privateRuntime ? access(privateRuntime).then(() => { throw new Error("RUNTIME_REMAINS"); }, () => {}) : Promise.resolve(),
      snapshot ? access(snapshot).then(() => { throw new Error("SNAPSHOT_REMAINS"); }, () => {}) : Promise.resolve(),
    ]);
    if ([...stopResults, ...removeResults, ...probeResults].some((outcome) => outcome.status === "rejected")) cleanupError = new Error("CLEANUP_INCOMPLETE");
  }
  if (deadlineReached) throw new Error("TOTAL_TIMEOUT");
  if (cleanupError) throw new Error("CLEANUP_FAILED");
  if (primaryError) throw primaryError;
  return result;
}

async function main() {
  const result = await run();
  process.stdout.write(`FINALIZATION_SMOKE_RESULT ${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try { await main(); }
  catch (error) {
    if (process.env.FINALIZATION_SMOKE_DEBUG === "1") {
      const errors = error instanceof AggregateError ? error.errors : [error];
      const details = errors.map((item) => item instanceof Error ? item.message : "UNKNOWN")
        .map((message) => message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/giu, "[id]").replace(/[A-Za-z0-9_-]{32,}/gu, "[secret]").slice(0, 160));
      process.stderr.write(`FINALIZATION_SMOKE_DETAIL ${JSON.stringify(details)}\n`);
    }
    const code = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "FINALIZATION_SMOKE_FAILED";
    process.stderr.write(`FINALIZATION_SMOKE_ERROR ${code}\n`);
    process.exitCode = 1;
  }
}
