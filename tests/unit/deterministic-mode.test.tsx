import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import DoctorPanel from "../../app/c/[token]/DoctorPanel";
import { handleChat } from "../../app/api/chat/handler";
import { IntakeSummary } from "../../app/workspace/intakes/summary";
import { readFileSync } from "node:fs";
import { ABSTAIN_HYPOTHESIS, DETERMINISTIC_HYPOTHESIS, DISCLAIMER } from "../../lib/clinical-copy";
import {
  assembleDeterministicAnamnesis,
  runDeterministicAnamnesisTurn,
} from "../../lib/deterministic";
import { GREETING_RU } from "../../lib/anamnesis";
import { finalizeSession } from "../../lib/finalize";
import { processingModeFromEnv } from "../../lib/processing-mode";
import { MemorySessionStore } from "../../lib/store";
import { renderSummary } from "../../lib/telegram";
import { analyze } from "../../lib/triage";
import type { ChatMessage, TriageResult } from "../../lib/types";

const FIXED_MESSAGES: ChatMessage[] = [
  { role: "assistant", content: "Что вас беспокоит?" },
  { role: "user", content: "Ноющая боль в пояснице" },
  { role: "assistant", content: "Когда это началось?" },
  { role: "user", content: "Две недели назад" },
  { role: "assistant", content: "Где и как?" },
  { role: "user", content: "В пояснице, ноющая" },
  { role: "assistant", content: "Сила?" },
  { role: "user", content: "4 из 10" },
  { role: "assistant", content: "Другие симптомы?" },
  { role: "user", content: "Температуры нет, ноги не немеют, мочеиспускание не нарушено" },
  { role: "assistant", content: "Перенесённое?" },
  { role: "user", content: "Не помню" },
  { role: "assistant", content: "Хроническое?" },
  { role: "user", content: "Хронических состояний нет" },
  { role: "assistant", content: "Аллергии?" },
  { role: "user", content: "Аллергий нет" },
  { role: "assistant", content: "Лекарства?" },
  { role: "user", content: "Лекарств не принимаю" },
  { role: "assistant", content: "Контекст?" },
  { role: "user", content: "34 года, женщина, не курю, беременности нет" },
];

function transcript(answers: readonly string[]): ChatMessage[] {
  return answers.flatMap((content, index) => index === 0
    ? [{ role: "user" as const, content }]
    : [
        { role: "assistant" as const, content: `question-${index}` },
        { role: "user" as const, content },
      ]);
}

describe("deterministic processing mode", () => {
  it("defaults to external_llm and rejects every unknown value", () => {
    expect(processingModeFromEnv({})).toBe("external_llm");
    expect(processingModeFromEnv({ DEMEU_PROCESSING_MODE: "deterministic" })).toBe("deterministic");
    expect(() => processingModeFromEnv({ DEMEU_PROCESSING_MODE: "local" })).toThrow(
      "DEMEU_PROCESSING_MODE",
    );
  });

  it("uses persisted answers to select a fixed RU/KK next question", () => {
    expect(runDeterministicAnamnesisTurn(FIXED_MESSAGES.slice(0, 2), "ru")).toEqual({
      reply: "Когда это началось?",
      done: false,
    });
    expect(runDeterministicAnamnesisTurn([
      { role: "assistant", content: "Сізді не мазалайды?" },
      { role: "user", content: "Белім ауырады" },
    ], "kk").reply).toBe("Бұл қашан басталды?");
    expect(runDeterministicAnamnesisTurn(FIXED_MESSAGES, "ru").done).toBe(true);
  });

  it.each([
    ["ru" as const, [
      "Болит поясница", "Вчера", "Поясница, ноет", "4 из 10", "Температуры нет",
      "Операций не было", "Гипертония", "Аллергий нет", "Лекарств не принимаю",
      "34 года, женщина, беременности нет",
    ], ["Когда это началось?", "Где вы чувствуете симптом и как его опишете?"]],
    ["kk" as const, [
      "Белім ауырады", "Кеше", "Белім сыздайды", "10 ұпайдан 4", "Қызу жоқ",
      "Операция болған жоқ", "Қан қысымы жоғары", "Аллергия жоқ", "Дәрі қабылдамаймын",
      "34 жас, әйел, жүктілік жоқ",
    ], ["Бұл қашан басталды?", "Белгіні қай жерден сезесіз және оны қалай сипаттайсыз?"]],
  ])("runs the complete fixed %s sequence with stable answer indexing", (language, answers, firstQuestions) => {
    const messages: ChatMessage[] = [];
    const replies: string[] = [];
    for (let index = 0; index < answers.length; index += 1) {
      messages.push({ role: "user", content: answers[index] });
      const turn = runDeterministicAnamnesisTurn(messages, language);
      if (index < answers.length - 1) {
        expect(turn.done).toBe(false);
        replies.push(turn.reply);
        messages.push({ role: "assistant", content: turn.reply });
      } else {
        expect(turn.done).toBe(true);
      }
    }
    expect(replies.slice(0, 2)).toEqual(firstQuestions);
    expect(assembleDeterministicAnamnesis(messages).chief_complaint).toBe(answers[0]);
    expect(assembleDeterministicAnamnesis(messages).context.age).toBe(34);
  });

  it("assembles explicit negatives and keeps denied separate from not stated", () => {
    const value = assembleDeterministicAnamnesis(FIXED_MESSAGES);

    expect(value).toMatchObject({
      chief_complaint: "Ноющая боль в пояснице",
      symptom: { severity: 4 },
      history_status: {
        past_history: "not_stated",
        chronic: "denied",
        allergies: "denied",
        medications: "denied",
      },
      context: { age: 34, sex: "f", pregnancy: "no" },
    });
    expect(value.negative_findings).toEqual([
      "Температуры нет",
      "ноги не немеют",
      "мочеиспускание не нарушено",
    ]);
  });

  it("classifies history clause-wise, retains positives, and never stores short answers", () => {
    const value = assembleDeterministicAnamnesis(transcript([
      "Болит спина", "Вчера", "Поясница", "4 из 10", "Температуры нет",
      "Гипертония, диабета нет", "Да", "Жоқ", "Иә", "40 лет, мужчина, не курю",
    ]));
    expect(value.past_history).toEqual(["Гипертония"]);
    expect(value.history_status).toMatchObject({
      past_history: "reported",
      chronic: "not_stated",
      allergies: "denied",
      medications: "not_stated",
    });
    expect([...value.past_history, ...value.chronic, ...value.allergies, ...value.medications])
      .not.toEqual(expect.arrayContaining(["Да", "Иә", "Жоқ"]));
    expect(value.context.risk_factors).toEqual([]);

    const smoking = assembleDeterministicAnamnesis(transcript([
      "Болит спина", "Вчера", "Поясница", "4 из 10", "Нет", "Нет", "Нет", "Нет", "Нет",
      "40 лет, мужчина, курю",
    ]));
    expect(smoking.context.risk_factors).toEqual(["курю"]);
  });

  it("calls neither extraction nor ModelPort in deterministic analysis", async () => {
    const llm = { analyze: vi.fn() };
    const model = { predict: vi.fn() };

    const result = await analyze(FIXED_MESSAGES, {
      processingMode: "deterministic",
      llm,
      model,
    });

    expect(llm.analyze).not.toHaveBeenCalled();
    expect(model.predict).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      source: "rules_only",
      processing_mode: "deterministic",
      urgency: "planned",
    });
    expect(result).not.toHaveProperty("model");
  });

  it("checks emergency before selecting a question and never calls the chat port", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    await sessionStore.appendMessage(session.id, { role: "assistant", content: GREETING_RU });
    const runTurn = vi.fn();
    const response = await handleChat(new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        message: "Сильная давящая боль в груди и одышка в покое",
      }),
    }), {
      sessionStore,
      processingMode: "deterministic",
      runTurn,
      doctorSummary: { sendDoctorSummary: async () => undefined },
      schedule: (work) => void work(),
    });
    const body = await response.json();
    const stored = await sessionStore.getSession(session.id);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      done: true,
      closing: { emergency: true },
    });
    expect(body).not.toHaveProperty("result");
    expect(stored?.result).toMatchObject({ urgency: "emergency", processing_mode: "deterministic" });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("stops the KK flow for chest pressure and dyspnea before asking the next question", async () => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token, "kk");
    const runTurn = vi.fn();
    const response = await handleChat(new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        message: "Кеудемді қатты қысады, дем алуым қиындады",
      }),
    }), {
      sessionStore,
      processingMode: "deterministic",
      runTurn,
      doctorSummary: { sendDoctorSummary: async () => undefined },
      schedule: (work) => void work(),
    });
    const body = await response.json();
    const stored = await sessionStore.getSession(session.id);
    const result = stored?.result;
    expect(body.done).toBe(true);
    expect(body.closing.emergency).toBe(true);
    expect(body).not.toHaveProperty("result");
    expect(result?.urgency).toBe("emergency");
    expect(result?.red_flags.map((flag: { code: string }) => flag.code)).toEqual(
      expect.arrayContaining(["chest_pain", "dyspnea_rest"]),
    );
    for (const flag of result?.red_flags ?? []) {
      expect(flag.source_message_index).toBe(0);
      expect("Кеудемді қатты қысады, дем алуым қиындады").toContain(flag.evidence);
    }
    expect(runTurn).not.toHaveBeenCalled();
  });
});

const SCENARIOS: { name: string; messages: ChatMessage[]; emergency: boolean }[] = [
  {
    name: "chest pain",
    messages: [
      { role: "assistant", content: "Что вас беспокоит?" },
      { role: "user", content: "Сильная давящая боль в груди и одышка в покое" },
    ],
    emergency: true,
  },
  { name: "back pain", messages: FIXED_MESSAGES, emergency: false },
  {
    name: "rhinitis",
    messages: [
      { role: "assistant", content: "Что вас беспокоит?" },
      { role: "user", content: "Со вчера насморк и немного чихаю" },
      { role: "assistant", content: "Когда это началось?" },
      { role: "user", content: "Вчера" },
      { role: "assistant", content: "Что ещё?" },
      { role: "user", content: "Температуры нет, горло не болит" },
    ],
    emergency: false,
  },
];

describe("three offline deterministic scenarios", () => {
  it.each(SCENARIOS)("forms one persisted result and one mocked Telegram summary: $name", async ({ messages, emergency }) => {
    const sessionStore = new MemorySessionStore();
    const token = await sessionStore.createDoctorToken();
    const session = await sessionStore.createSession(token);
    for (const message of messages) await sessionStore.appendMessage(session.id, message);
    const summaries: string[] = [];
    const jobs: (() => Promise<void>)[] = [];
    const doctorSummary = {
      sendDoctorSummary: vi.fn(async (current, result) => {
        summaries.push(renderSummary(current, result));
      }),
    };

    const outcome = await finalizeSession(session.id, {
      sessionStore,
      processingMode: "deterministic",
      doctorSummary,
      schedule: (work) => jobs.push(work),
    });
    await Promise.all(jobs.map((work) => work()));

    expect(outcome.result.processing_mode).toBe("deterministic");
    expect(outcome.result.urgency).toBe(emergency ? "emergency" : "planned");
    expect(outcome.result.red_flags.some((flag) => flag.emergency)).toBe(emergency);
    if (emergency) {
      expect(outcome.result.red_flags.map((flag) => flag.code)).toContain("chest_pain");
    }
    expect(doctorSummary.sendDoctorSummary).toHaveBeenCalledOnce();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain(
      "Ответы пациента не передавались внешней языковой модели.",
    );
    expect((await sessionStore.getSession(session.id))?.deliveryStatus).toBe("sent");
  });
});

describe("shared A/B rendering regressions", () => {
  const abstained: TriageResult = {
    anamnesis: {
      chief_complaint: "Старая жалоба",
      symptom: { onset: "", location: "", quality: "", severity: null, modifiers: "", associated: [] },
      past_history: [], chronic: [], allergies: [], medications: [],
      context: { age: null, sex: "unknown", pregnancy: "na", risk_factors: [] },
    },
    red_flags: [], urgency: "planned", urgency_reasons: ["требуется решение врача"], routing: [],
    hypothesis: { text: "Старый ошибочный текст", confidence: 0, disclaimer: DISCLAIMER },
    model: {
      pathologies: [{ code: "hidden", label_ru: "Не показывать", prob: 0.9 }],
      top_contributions: [{ feature: "hidden", label_ru: "Не показывать вклад", contribution: 1 }],
      abstained: true, abstain_reason: "low_confidence", model_version: "legacy",
    },
    source: "llm_fallback",
  };

  it.each([
    ["DoctorPanel", () => renderToStaticMarkup(<DoctorPanel result={abstained} />)],
    ["IntakeSummary", () => renderToStaticMarkup(<IntakeSummary result={abstained} />)],
  ])("normalizes legacy history and renders strict abstain in %s", (_name, render) => {
    const html = render();
    expect(html).toContain(ABSTAIN_HYPOTHESIS);
    expect(html).toContain("Гипотеза не сформирована");
    expect(html).toMatch(/не указано/iu);
    expect(html).not.toMatch(/уверенн/iu);
    expect(html).not.toContain("Не показывать");
    expect(html).not.toContain("Старый ошибочный текст");
  });
});

describe("deterministic presentation", () => {
  it("uses dedicated no-hypothesis wording in interactive and message renderers", async () => {
    const result = await analyze(FIXED_MESSAGES, { processingMode: "deterministic" });
    const doctor = renderToStaticMarkup(<DoctorPanel result={result} />);
    const intake = renderToStaticMarkup(<IntakeSummary result={result} />);
    const telegram = renderSummary({ language: "ru" } as never, result);
    for (const rendered of [doctor, intake, telegram]) {
      expect(rendered).toContain(DETERMINISTIC_HYPOTHESIS);
      expect(rendered).toContain("Гипотеза не формировалась");
      expect(rendered).not.toContain("структурированные признаки недоступны");
      expect(rendered).not.toContain("ПРЕДВАРИТЕЛЬНАЯ ГИПОТЕЗА");
    }
    expect(doctor).not.toContain("Признаки не извлечены");
  });

  it("wires the dedicated deterministic heading into referral and PDF renderers", () => {
    expect(readFileSync("app/workspace/referrals/[id]/page.tsx", "utf8"))
      .toContain("Гипотеза не формировалась");
    expect(readFileSync("lib/pdf.ts", "utf8")).toContain("hypothesisHeading(result)");
  });
});
