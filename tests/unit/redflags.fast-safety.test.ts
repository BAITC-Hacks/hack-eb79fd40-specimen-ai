import { describe, expect, it } from "vitest";
import { detectRedFlags } from "../../lib/redflags";
import type { ChatMessage } from "../../lib/types";

export const FAST_REPORT = "онемела правая рука, речь стала невнятной, лицо перекосило";
export const DENIED_FAST_REPORT = "болит голова… Слабости в руках и ногах нет, речь нормальная";

function patient(content: string): ChatMessage[] {
  return [{ role: "assistant", content: "Что вас беспокоит?" }, { role: "user", content }];
}

describe("FAST production acceptance regression", () => {
  it.each([
    [FAST_REPORT, "онемела правая рука"],
    ["Онемела правая рука", "Онемела правая рука"],
    ["Онемела левая рука", "Онемела левая рука"],
    ["Правая рука онемела", "рука онемела"],
    ["Речь стала невнятной", "Речь стала невнятной"],
    ["Речь невнятная", "Речь невнятная"],
    ["Речь стала неразборчивой", "Речь стала неразборчивой"],
    ["Невнятная речь", "Невнятная речь"],
    ["Лицо перекосило", "Лицо перекосило"],
    ["Лицо внезапно перекосило", "Лицо внезапно перекосило"],
    ["Слабости в руках нет сейчас слабость в руках появилась", "слабость в руках"],
    ["Речь стала невнятной нет сейчас речь стала невнятной", "речь стала невнятной"],
  ])("recognizes current FAST report and keeps literal evidence: %s", (content, evidence) => {
    const messages = patient(content);
    const flags = detectRedFlags(messages);
    expect(flags).toEqual([expect.objectContaining({
      code: "stroke", emergency: true, evidence, evidence_kind: "quote", source_message_index: 1,
    })]);
    expect(messages[flags[0].source_message_index].content).toContain(flags[0].evidence);
    expect(flags[0].evidence.at(-1)).toMatch(/\p{L}/u);
  });

  it.each([
    DENIED_FAST_REPORT,
    "Слабости в руках и ногах нет",
    "Слабости в правой руке и ноге нет",
    "Слабости в правой руке и левой ноге нет",
    "Слабости в руках и в ногах нет",
    "Слабости в руках и ногах отсутствуют",
    "Слабости в руках и в левой ноге нет",
    "Слабости в руках и в правой ноге нет",
    "Нет слабости в руках и ногах",
    "Речь стала невнятной не было",
    "Речь невнятная отсутствует",
    "Онемела правая рука — нет, этого не было",
    "Не онемела правая рука",
    "Лицо перекосило не было",
    "Не перекосило лицо",
    "Врач спросил: перекосило лицо? Я ответил нет",
  ])("does not promote denied FAST symptoms: %s", (content) => {
    expect(detectRedFlags(patient(content))).toEqual([]);
  });

  it.each([
    ["Боль в груди и одышки нет", "chest_pain"],
    ["Слабости в руках и ногах нет, лицо перекосило", "stroke"],
    ["Онемела правая рука, слабости в руках и ногах нет", "stroke"],
    ["Онемела правая рука и нога не болит", "stroke"],
    ["Онемела правая рука и в ноге боли нет", "stroke"],
    ["Слабость в руке и нога не болит", "stroke"],
    ["Слабость в руке и в ноге боль отсутствует", "stroke"],
    ["Онемела правая рука — слабости нет", "stroke"],
    ["Лицо перекосило — боли нет", "stroke"],
    ["Речь стала невнятной — слабости в руках нет", "stroke"],
    ["Перекосило лицо — боли нет", "stroke"],
    ["Слабость в руке — боли нет", "stroke"],
    ["Онемела правая рука — нет боли в груди", "stroke"],
    ["Слабости в руках нет, речь стала невнятной", "stroke"],
    ["Врач спросил: перекосило лицо? Я ответил нет. Сейчас лицо перекосило", "stroke"],
  ])("preserves an independent positive report: %s", (content, code) => {
    expect(detectRedFlags(patient(content)).map((flag) => flag.code)).toEqual([code]);
  });

  it("does not convert an assistant's FAST screening and patient denial into evidence", () => {
    expect(detectRedFlags([
      { role: "assistant", content: FAST_REPORT + "?" }, { role: "user", content: "Нет, речь нормальная" },
    ])).toEqual([]);
  });

  it.each(["—", "–", "-"])("keeps separate predicates across %s and accepts only a direct correction", (dash) => {
    for (const content of [
      `Онемела правая рука ${dash} слабости нет`,
      `Лицо перекосило ${dash} боли нет`,
      `Речь стала невнятной ${dash} слабости в руках нет`,
      `Перекосило лицо ${dash} боли нет`,
      `Слабость в руке ${dash} боли нет`,
      `Онемела правая рука ${dash} нет боли в груди`,
    ]) {
      expect(detectRedFlags(patient(content)).map((flag) => flag.code), content).toEqual(["stroke"]);
    }
    expect(detectRedFlags(patient(`Онемела правая рука ${dash} нет, этого не было`))).toEqual([]);
  });

  it.each(["—", "–", "-"])("preserves closed absence denials across %s without denying a FAST symptom's pain property", (dash) => {
    for (const content of [
      `Слабость в руке ${dash} не беспокоит`,
      `Слабости в руках ${dash} отсутствует`,
      `Слабость в руке ${dash} не наблюдается`,
    ]) {
      expect(detectRedFlags(patient(content)), content).toEqual([]);
    }
    for (const content of [
      `Онемела правая рука ${dash} не болит`,
      `Перекосило лицо ${dash} не болит`,
    ]) {
      expect(detectRedFlags(patient(content)).map((flag) => flag.code), content).toEqual(["stroke"]);
    }
  });

  it("accepts a short confirmation only after a relevant FAST question", () => {
    const question = "Речь стала невнятной?";
    expect(detectRedFlags([{ role: "assistant", content: question }, { role: "user", content: "Да" }]))
      .toEqual([expect.objectContaining({ code: "stroke", evidence: "Да", source_message_index: 1, elicited_by: question })]);
    expect(detectRedFlags([{ role: "assistant", content: "Вы уже записались?" }, { role: "user", content: "Да" }])).toEqual([]);
  });
});
