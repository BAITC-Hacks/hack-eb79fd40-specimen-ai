import { describe, expect, it } from "vitest";

import { detectRedFlags } from "../../lib/redflags";
import type { ChatMessage } from "../../lib/types";

function patientSays(content: string): ChatMessage[] {
  return [
    { role: "assistant", content: "Расскажите, что вас беспокоит." },
    { role: "user", content },
  ];
}

describe("red flag negation and role filtering", () => {
  it("does not treat an assistant screening question and patient denial as evidence", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Болит ли грудь или есть одышка в покое?" },
      { role: "user", content: "Нет" },
    ];

    expect(detectRedFlags(messages)).toEqual([]);
  });

  it.each([
    "Боли в груди нет",
    "Нет боли в груди, только кашель",
    "В груди не болит",
    "Судорог не было",
    "Не задыхаюсь",
    "Без кровотечения, просто слабость",
  ])("suppresses a locally negated symptom: %s", (utterance) => {
    expect(detectRedFlags(patientSays(utterance))).toEqual([]);
  });

  it("does not suppress a persistent chest symptom", () => {
    const flags = detectRedFlags(patientSays("Боль в груди не проходит"));

    expect(flags.some(({ code }) => code === "chest_pain")).toBe(true);
  });

  it("keeps an emergency phrase whose negation is part of the rule", () => {
    const flags = detectRedFlags(patientSays("Не могу дышать"));

    expect(flags.some(({ code }) => code === "dyspnea_rest")).toBe(true);
  });
});
