import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HARD_TURN_CAP } from "../lib/config.ts";
import { assertTriageInvariants } from "../tests/contract/invariants.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCENARIOS = [
  {
    id: "scenario-1-chest-pain",
    title: "Мужчина 58 лет, боль в груди и одышка",
    lines: [
      "Мне 58 лет, я мужчина. Сильная давящая боль в груди и одышка в покое, боль 8 из 10.",
    ],
    verify(result) {
      must(result.red_flags.some(
        (flag) => flag.code === "chest_pain" && flag.emergency === true,
      ), "нет emergency-флага chest_pain");
      must(result.urgency === "emergency", `urgency=${result.urgency}`);
      if (result.source === "model") {
        must(
          result.routing.some(({ specialty }) =>
            ["кардиология", "скорая/приёмный покой"].includes(specialty)
          ),
          `model routing=${JSON.stringify(result.routing)}`,
        );
      } else if (result.source === "llm_fallback") {
        must(
          result.routing.length === 1 &&
            result.routing[0]?.specialty === "скорая/приёмный покой" &&
            result.routing[0]?.confidence === 0,
          `fallback routing=${JSON.stringify(result.routing)}`,
        );
      } else {
        must(
          result.routing.length === 0,
          `rules_only routing=${JSON.stringify(result.routing)}`,
        );
      }
    },
  },
  {
    id: "scenario-2-back-pain",
    title: "Женщина 34 года, боль в пояснице две недели",
    lines: [
      "Мне 34 года, я женщина. Уже две недели ноющая боль в пояснице, 4 из 10, к вечеру сильнее.",
      "Температуры нет, ноги не немеют, мочеиспускание нормальное.",
      "Хронических состояний нет, лекарств не принимаю, аллергий нет.",
    ],
    verify(result) {
      must(result.urgency !== "emergency", `ложный emergency: ${result.urgency}`);
      must(
        result.red_flags.every((flag) => !flag.emergency),
        `ложный emergency-флаг: ${JSON.stringify(result.red_flags)}`,
      );
    },
  },
  {
    id: "scenario-3-rhinitis",
    title: "Насморк один день",
    lines: [
      "Мне 27 лет, я мужчина. Со вчера насморк, немного чихаю.",
      "Температуры нет, горло не болит, других жалоб нет.",
    ],
    verify(result) {
      must(
        result.urgency !== "urgent" && result.urgency !== "emergency",
        `избыточная срочность: ${result.urgency}`,
      );
      must(result.red_flags.length === 0, `лишние флаги: ${JSON.stringify(result.red_flags)}`);
    },
  },
];

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function safeJson(text, context) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context} returned non-JSON: ${text.slice(0, 500)}`);
  }
}

function createHttpClient(baseUrl, history) {
  let cookie = "";
  return async (path, body) => {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json", origin: baseUrl }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`${path} network failure`, { cause: error });
    }
    const text = await response.text();
    history.push({ path, status: response.status });
    if (!response.ok) {
      throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 1_000)}`);
    }
    const nextCookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (nextCookie) cookie = nextCookie;
    return safeJson(text, path);
  };
}

async function writeFixture(fixtureDir, scenario, provenance, payload) {
  await mkdir(fixtureDir, { recursive: true });
  const path = resolve(fixtureDir, `${scenario.id}.${provenance}.json`);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

export async function runDemoScenarios({
  baseUrl,
  fixtureDir = resolve(ROOT, "tests/fixtures/transcripts"),
  provenance,
  workspaceCredentials,
}) {
  must(provenance === "mock" || provenance === "live", "provenance must be mock or live");
  must(workspaceCredentials?.id && workspaceCredentials?.password,
    "workspace credentials are required to verify the doctor-only result");
  const output = [];

  for (const scenario of SCENARIOS) {
    const http = [];
    const doctorRequest = createHttpClient(baseUrl, http);
    const patientRequest = createHttpClient(baseUrl, http);
    const health = await doctorRequest("/api/healthz");
    must(health.ok === true, `healthz not ok: ${JSON.stringify(health)}`);
    await doctorRequest("/api/workspace/auth", workspaceCredentials);

    const link = await doctorRequest("/api/link", {});
    must(typeof link.token === "string" && link.token.length > 0, "link token missing");
    const start = await patientRequest("/api/chat/start", { token: link.token });
    must(typeof start.sessionId === "string", "sessionId missing");
    must(typeof start.reply === "string" && start.reply.length > 0, "greeting missing");

    const messages = [{ role: "assistant", content: start.reply }];
    let closing;
    let completedVia = "none";
    for (let index = 0; index < HARD_TURN_CAP && !closing; index += 1) {
      const line = scenario.lines[Math.min(index, scenario.lines.length - 1)];
      messages.push({ role: "user", content: line });
      const turn = await patientRequest("/api/chat", {
        sessionId: start.sessionId,
        message: line,
      });
      must(typeof turn.reply === "string", "chat reply missing");
      messages.push({ role: "assistant", content: turn.reply });
      if (turn.done === true) {
        must(turn.closing && typeof turn.closing.text === "string", "done response has no patient closing");
        must(turn.result === undefined, "patient API leaked TriageResult");
        closing = turn.closing;
        completedVia = "chat";
      }
    }

    if (!closing) {
      const finalized = await patientRequest("/api/chat/finalize", {
        sessionId: start.sessionId,
      });
      must(finalized.result === undefined, "patient finalize leaked TriageResult");
      closing = finalized.closing;
      completedVia = "finalize";
    }
    must(closing, "patient closing missing after finalize");
    const intake = await doctorRequest(`/api/workspace/intakes/${encodeURIComponent(start.sessionId)}`);
    const result = intake.intake?.result;
    must(result, "doctor intake has no TriageResult after finalize");
    must(completedVia === "chat", `${scenario.id} did not reach done=true`);
    must(http.every(({ status }) => status === 200), `non-200 status: ${JSON.stringify(http)}`);
    assertTriageInvariants(result, messages);
    scenario.verify(result);

    const fixture = {
      schema_version: 1,
      provenance,
      live_verified: provenance === "live",
      scenario: { id: scenario.id, title: scenario.title },
      completed_via: completedVia,
      session_id: start.sessionId,
      health: {
        ok: health.ok,
        commit: health.commit,
        model_version: health.model_version,
        llm_ok: health.llm_ok,
      },
      http,
      messages,
      closing,
      result,
    };
    const path = await writeFixture(fixtureDir, scenario, provenance, fixture);
    output.push({ scenario: scenario.id, path, result });
    console.log(
      `OK ${scenario.id} provenance=${provenance} source=${result.source} urgency=${result.urgency}`,
    );
  }

  return output;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  if (process.env.E2E_LIVE !== "1") {
    throw new Error("Live E2E is opt-in: run npm run e2e:live");
  }
  await runDemoScenarios({
    baseUrl: process.env.BASE_URL ?? "http://127.0.0.1:3000",
    provenance: "live",
    workspaceCredentials: {
      id: process.env.E2E_WORKSPACE_ID,
      password: process.env.E2E_WORKSPACE_PASSWORD,
    },
  });
}
