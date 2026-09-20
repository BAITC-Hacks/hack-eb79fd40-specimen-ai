import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileReferralRepository, ReferralService } from "../lib/referrals/service.ts";
import { REFERRAL_PROFILES } from "../lib/referrals/profiles.ts";
import { hashWorkspacePassword } from "../lib/workspace-auth.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const port = Number(process.env.DEMEU_DEMO_PORT ?? 3240);
const password = "DemeuDemo2026!";
const organizationId = "demo-clinic";
const people = [
  { id: "doctor-a", displayName: "Врач А · демо", role: "doctor", telegramChatId: "100001" },
  { id: "doctor-b", displayName: "Врач Б · демо", role: "doctor", telegramChatId: "100002" },
  { id: "analyst", displayName: "Аналитик · демо", role: "analyst" },
  { id: "owner", displayName: "Руководитель · демо", role: "owner" },
].map((entry) => ({ ...entry, organizationId }));

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  const value = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return value;
}

async function assertPortFree(value) {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.listen(value, "127.0.0.1", resolveListen).once("error", reject));
  await new Promise((resolveClose) => server.close(resolveClose));
}

function child(label, file, env, args = []) {
  const processHandle = spawn(process.execPath, [file, ...args], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on("data", (chunk) => {
    const line = chunk.toString("utf8");
    tail = `${tail}${line}`.slice(-15_000);
    if (!checkOnly && label === "app") process.stdout.write(line);
  });
  return { processHandle, tail: () => tail, label };
}

async function ready(url, processHandle, timeout = 90_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (processHandle.exitCode !== null) throw new Error(`Service exited before ready: ${url}`);
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function stop(item) {
  const processHandle = item?.processHandle;
  if (!processHandle || processHandle.exitCode !== null || !processHandle.pid) return;
  try { process.kill(-processHandle.pid, "SIGTERM"); } catch { return; }
  await Promise.race([once(processHandle, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
  if (processHandle.exitCode === null) try { process.kill(-processHandle.pid, "SIGKILL"); } catch { /* exited */ }
}

const date = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function seed(directory) {
  await mkdir(directory, { recursive: true });
  const hash = await hashWorkspacePassword(password);
  const accounts = people.map((person) => ({ ...person, passwordHash: hash, sessionVersion: 1 }));
  const accountsFile = join(directory, "accounts.json");
  await writeFile(accountsFile, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
  const repository = new FileReferralRepository(join(directory, "referrals.json"));
  let clock = Date.now() - 3 * 86400000;
  const service = new ReferralService(repository, { now: () => clock });
  const ownIds = { "doctor-a": [], "doctor-b": [] };
  try {
    for (let index = 0; index < 14; index += 1) {
      const actor = people[index % 2];
      const referral = await service.create(actor, {
        patientLabel: `Учебный пациент ${String(index + 1).padStart(2, "0")}`,
        profile: REFERRAL_PROFILES[index % REFERRAL_PROFILES.length],
        icd10Code: ["K80.2", "N20.0", "M54.5", "I25.1", "S83.2"][index % 5],
        destinationOrganization: "Учебная клиника",
        idempotencyKey: randomUUID(),
      });
      ownIds[actor.id].push(referral.id);
      if (index >= 6) {
        await service.update(actor, referral.id, { expectedRevision: referral.revision, idempotencyKey: randomUUID(), patch: index < 11 ? { queue: true } : { scheduledDate: date(7) } });
      }
    }
    clock = Date.now();
    const actor = people[11 % 2];
    const scheduled = await service.detail(actor, ownIds[actor.id][Math.floor(11 / 2)]);
    await service.examination(actor, scheduled.id, {
      expectedRevision: scheduled.revision, idempotencyKey: randomUUID(),
      record: { requirementId: "cbc", label: "Общий анализ крови (развернутый)", resultAvailable: true, performedOn: date(-30), expiresOn: date(-16), applicability: "yes" },
    });
  } finally { await repository.close(); }
  return { accountsFile, ownIds };
}

async function request(base, path, body, cookie) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: base }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
  return { result, response };
}

async function smoke(base, telegramBase, ownIds) {
  const loginA = await request(base, "/api/workspace/auth", { id: "doctor-a", password });
  const loginB = await request(base, "/api/workspace/auth", { id: "doctor-b", password });
  const loginAnalyst = await request(base, "/api/workspace/auth", { id: "analyst", password });
  const cookieA = loginA.response.headers.get("set-cookie")?.split(";", 1)[0];
  const cookieB = loginB.response.headers.get("set-cookie")?.split(";", 1)[0];
  const cookieAnalyst = loginAnalyst.response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookieA || !cookieB || !cookieAnalyst) throw new Error("Demo login cookie missing");
  const referralsA = (await request(base, "/api/referrals", undefined, cookieA)).result.referrals;
  const referralsB = (await request(base, "/api/referrals", undefined, cookieB)).result.referrals;
  if (referralsA.length !== 7 || referralsB.length !== 7 || referralsA.some((item) => ownIds["doctor-b"].includes(item.id))) {
    throw new Error("Doctor scope failed in demo");
  }
  const aggregate = (await request(base, "/api/workspace/aggregates", undefined, cookieAnalyst)).result.aggregates;
  if (!aggregate.suppressed || aggregate.total !== null || !aggregate.groups.some((item) => item.count >= 5)) {
    throw new Error("Analyst suppression failed in demo");
  }
  const link = (await request(base, "/api/link", {}, cookieA)).result;
  if (!/^[0-9a-f]{16}$/u.test(link.token)) throw new Error("Patient link missing");
  const start = await request(base, "/api/chat/start", { token: link.token });
  const patientCookie = start.response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!patientCookie || !start.result.sessionId) throw new Error("Patient capability missing");
  const turn = (await request(base, "/api/chat", {
    sessionId: start.result.sessionId,
    message: "Мне 58 лет, я мужчина. Сильная давящая боль в груди и одышка в покое, боль 8 из 10.",
  }, patientCookie)).result;
  if (turn.done !== true || turn.result?.urgency !== "emergency") throw new Error("Patient chat did not complete safely");
  const until = Date.now() + 15_000;
  let outbox = [];
  while (Date.now() < until) {
    outbox = (await (await fetch(`${telegramBase}/outbox`)).json()).outbox;
    if (outbox.some((item) => item.method === "sendMessage" && item.chatId === "100001") && outbox.some((item) => item.method === "sendDocument" && item.chatId === "100001")) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  const document = outbox.find((item) => item.method === "sendDocument" && item.chatId === "100001");
  if (!document?.documentId) throw new Error("Mock Telegram PDF delivery missing");
  const pdfResponse = await fetch(`${telegramBase}/document/${document.documentId}`);
  if (!pdfResponse.ok || !Buffer.from(await pdfResponse.arrayBuffer()).subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Mock Telegram PDF cannot be downloaded");
  }
  const genericLink = (await request(base, "/api/link", {}, cookieB)).result;
  const genericStart = await request(base, "/api/chat/start", { token: genericLink.token });
  const genericCookie = genericStart.response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!genericCookie) throw new Error("Generic patient capability missing");
  let genericTurn;
  for (const message of [
    "Мне трудно спать последние три дня.",
    "Началось три дня назад, сейчас сплю плохо.",
    "Других симптомов нет, лекарства не принимаю.",
  ]) {
    genericTurn = (await request(base, "/api/chat", { sessionId: genericStart.result.sessionId, message }, genericCookie)).result;
    if (genericTurn.done) break;
  }
  if (!genericTurn?.done || genericTurn.result?.source === "rules_only" || !genericTurn.result?.anamnesis?.chief_complaint?.includes("трудно спать")) {
    throw new Error("Generic patient flow fell back to empty extraction");
  }
  return { patientUrl: `${base}/c/${link.token}`, sessionId: start.result.sessionId, outboxCount: outbox.length };
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DEMEU_DEMO_PORT must be a free TCP port");
  await assertPortFree(port);
  const directory = await mkdtemp(join(tmpdir(), "demeu-local-demo-"));
  const children = [];
  let failure;
  try {
    const { accountsFile, ownIds } = await seed(directory);
    const anthropicPort = await freePort();
    const telegramPort = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const telegramBase = `http://127.0.0.1:${telegramPort}`;
    const mockA = child("anthropic", join(root, "scripts/mock-anthropic.mjs"), { ...process.env, MOCK_PORT: String(anthropicPort) });
    children.push(mockA);
    const mockT = child("telegram", join(root, "scripts/mock-telegram.mjs"), { ...process.env, MOCK_TELEGRAM_PORT: String(telegramPort) });
    children.push(mockT);
    await Promise.all([ready(`http://127.0.0.1:${anthropicPort}/health`, mockA.processHandle), ready(`${telegramBase}/health`, mockT.processHandle)]);
    const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "development",
      NODE_OPTIONS: `--import=${join(root, "scripts/demo-fetch-router.mjs")}`,
      ANTHROPIC_API_KEY: "local-mock-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicPort}`,
      TELEGRAM_BOT_TOKEN: "local-mock-token", DEMEU_MOCK_TELEGRAM_PORT: String(telegramPort),
      DEMEU_ACCOUNTS_FILE: accountsFile, DEMEU_DATA_DIR: directory,
      DEMEU_AUTH_SECRET: randomBytes(32).toString("hex"), DEMEU_LOCAL_DEMO: "1", APP_BASE_URL: base,
    };
    for (const key of ["ANTHROPIC_AUTH_TOKEN", "TELEGRAM_DOCTOR_CHAT_ID", "TELEGRAM_DOCTOR_CHAT_IDS", "DOCTOR_ACCESS_CODE"]) delete env[key];
    const app = child("app", join(root, "node_modules/next/dist/bin/next"), env,
      ["dev", "--hostname", "127.0.0.1", "--port", String(port)]);
    children.push(app);
    await ready(`${base}/api/healthz`, app.processHandle);
    if (!app.tail().includes("DEMEU_DEMO_FETCH_GUARD_READY")) throw new Error("Demo network guard did not start");
    const verified = await smoke(base, telegramBase, ownIds);
    if (app.tail().includes("DEMEU_DEMO_EXTERNAL_FETCH_BLOCKED")) throw new Error("Demo attempted external fetch");
    if (checkOnly) {
      process.stdout.write("Demo boot, doctor isolation, analyst suppression, patient chat and mock Telegram PDF: OK\n");
    } else {
      process.stdout.write(`\nЛОКАЛЬНОЕ ДЕМО — вымышленные данные, внешние API заменены\nКабинет: ${base}/workspace\nОпрос пациента: ${verified.patientUrl}\nЛокальные уведомления и PDF: ${telegramBase}/\nУчётки: doctor-a, doctor-b, analyst, owner\nПароль для всех: ${password}\nДля остановки: Ctrl+C\n\n`);
      await new Promise((resolveSignal) => {
        process.once("SIGINT", resolveSignal); process.once("SIGTERM", resolveSignal);
      });
    }
  } catch (error) { failure = error; }
  finally {
    for (const item of children.reverse()) await stop(item);
    await rm(directory, { recursive: true, force: true });
  }
  if (failure) {
    for (const item of children) process.stderr.write(`\n--- ${item.label} ---\n${item.tail()}\n`);
    throw failure;
  }
}

await main();
