import { describe, expect, it } from "vitest";
import { detectRedFlags, RESOLVED_YEARS_AGO_AFTER } from "../../lib/redflags";
import { analyze } from "../../lib/triage";
import type { ChatMessage } from "../../lib/types";
import { failingLlm, fakeModel } from "../fixtures/triage.ports";

const history = "Боль в груди была пять лет назад, сейчас ничего не беспокоит";

describe("явно завершённая давняя боль в груди", () => {
  it.each([
    [" была пять лет назад, сейчас ничего не беспокоит", " была пять лет назад, сейчас ничего не беспокоит"],
    [" год назад, прошло.", " год назад, прошло"],
    [" была 2 года назад; прошла!", " была 2 года назад; прошла"],
    [" было один год назад. Прошло.", " было один год назад. Прошло"],
    [" были несколько лет назад, прошли", " были несколько лет назад, прошли"],
  ])("точная граница контекста: %s", (text, evidence) => {
    expect(RESOLVED_YEARS_AGO_AFTER.exec(text)?.[0]).toBe(evidence);
    expect(RESOLVED_YEARS_AGO_AFTER.flags).toContain("u");
    expect(RESOLVED_YEARS_AGO_AFTER.source).not.toMatch(/\\[wWbB]/);
  });

  it.each([
    history,
    "болело в груди год назад, прошло",
    "Боль в груди была 2 года назад; прошла.",
    "Боль в груди была десять лет назад. Сейчас ничего не беспокоит.",
    "Жжение за грудиной было три года назад, прошло.",
  ])("не считает завершённую историю текущим флагом: %s", (content) => {
    expect(detectRedFlags([{ role: "user", content }])).toEqual([]);
  });

  it.each([
    ["Боль в груди была, сейчас нет", "Боль в груди"],
    ["Боль в груди была вчера, сейчас ничего не беспокоит", "Боль в груди"],
    ["Боль в груди была два дня назад, прошло", "Боль в груди"],
    ["Боль в груди была месяц назад, прошло", "Боль в груди"],
    ["Боль в груди была год назад", "Боль в груди"],
    ["Боль в груди была пять лет назад, не проходит", "Боль в груди"],
    ["Боль в груди была пять лет назад, прошло три дня", "Боль в груди"],
    ["Боль в груди была пять лет назад, сейчас ничего не беспокоит кроме боли в груди", "Боль в груди"],
    ["Боль в груди была пять лет назад, кашель прошёл", "Боль в груди"],
    ["Боль в груди не проходит", "Боль в груди"],
    [`${history}. Сейчас снова`, "Боль в груди"],
    [`Сейчас опять. ${history}`, "Боль в груди"],
    ["Боль в груди была год назад, прошло, но вернулось", "Боль в груди"],
    [`${history}? Нет, снова`, "Боль в груди"],
    [`${history}. Но сегодня это началось.`, "Боль в груди"],
    [`${history}. Уже два часа так же.`, "Боль в груди"],
    [`Уже два часа так же. ${history}`, "Боль в груди"],
    [`${history}, но сегодня болит в груди`, "Боль в груди"],
    [`${history}. Сегодня давит в груди`, "Боль в груди"],
    ["болело в груди год назад, прошло; теперь болит грудь", "болело в груди"],
  ])("сохраняет текущий или неоднозначный эпизод: %s", (content, evidence) => {
    const flag = detectRedFlags([{ role: "user", content }]).find((item) => item.code === "chest_pain");
    expect(flag?.evidence).toBe(evidence);
    expect(flag?.emergency).toBe(true);
    expect(flag?.source_message_index).toBe(0);
    expect(flag?.evidence_kind).toBe("quote");
    expect(content).toContain(flag?.evidence);
  });

  it("не гасит другой симптом в том же сообщении", () => {
    const flags = detectRedFlags([{ role: "user", content: `${history}. Сейчас одышка в покое.` }]);
    expect(flags.map((flag) => flag.code)).toEqual(["chest_pain", "dyspnea_rest"]);
    expect(flags[1].evidence).toBe("одышка в покое");
  });

  it("новое сообщение сохраняет прежний флаг при неоднозначной истории", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: history },
      { role: "assistant", content: "Что сейчас?" },
      { role: "user", content: "Теперь болит в груди" },
    ];
    const [flag] = detectRedFlags(messages);
    expect(flag.evidence).toBe("Боль в груди");
    expect(flag.source_message_index).toBe(0);
  });

  it("не использует отдельную реплику о разрешении для снятия флага", () => {
    const [flag] = detectRedFlags([
      { role: "user", content: "Боль в груди была пять лет назад" },
      { role: "user", content: "Сейчас ничего не беспокоит" },
    ]);
    expect(flag.evidence).toBe("Боль в груди");
    expect(flag.source_message_index).toBe(0);
  });

  it.each(["Сейчас снова", "Но сегодня это началось", "Уже два часа так же"])("отдельное продолжение не теряет прежний флаг: %s", (content) => {
    const [flag] = detectRedFlags([
      { role: "user", content: history },
      { role: "assistant", content: "А сейчас?" },
      { role: "user", content },
    ]);
    expect(flag.evidence).toBe("Боль в груди");
    expect(flag.source_message_index).toBe(0);
    expect(flag.emergency).toBe(true);
  });

  it("вопрос о повторе не является сообщением пациента о повторе", () => {
    expect(detectRedFlags([
      { role: "user", content: history },
      { role: "assistant", content: "Сейчас снова болит в груди?" },
    ])).toEqual([]);
  });

  it("вопрос бота не подавляет подтверждение пациента", () => {
    const [flag] = detectRedFlags([
      { role: "assistant", content: `${history}?` },
      { role: "user", content: "Да" },
    ]);
    expect(flag.evidence).toBe("Да");
    expect(flag.source_message_index).toBe(1);
    expect(flag.elicited_by).toBe(`${history}?`);
    expect(detectRedFlags([{ role: "assistant", content: history }])).toEqual([]);
  });

  it.each([false, true])("работает без LLM, текущая одышка: %s", async (current) => {
    const modelCalls = { calls: 0 };
    const result = await analyze([{ role: "user", content: history + (current ? ". Одышка в покое" : "") }], {
      llm: failingLlm({ calls: 0 }),
      model: fakeModel(modelCalls, "success"),
    });
    expect(result.source).toBe("rules_only");
    expect(result.red_flags.map((flag) => flag.code)).toEqual(current ? ["chest_pain", "dyspnea_rest"] : []);
    expect(result.urgency === "emergency").toBe(current);
    expect(modelCalls.calls).toBe(0);
    expect(result.model).toBeUndefined();
  });
});
