import { describe, expect, it } from "vitest";

import { detectRedFlags, RULES } from "../../lib/redflags";
import type { ChatMessage } from "../../lib/types";

const patientSays = (content: string): ChatMessage[] => [
  { role: "assistant", content: "Что вас беспокоит?" },
  { role: "user", content },
];

describe("red flag review 25.09", () => {
  it("keeps all eight emergency triggers covered in Russian and Kazakh", () => {
    const cases = [
      ["chest_pain", "Боль в груди", "Кеуде қатты ауырады"],
      ["stroke", "Перекосило лицо", "Бетім қисайып кетті"],
      ["bleeding", "Началось кровотечение", "Қан құсып жатырмын"],
      ["thunderclap_headache", "Сильнейшая головная боль", "Кенеттен өмірімдегі ең қатты бас ауруы басталды"],
      ["consciousness", "Потерял сознание", "Есімнен танып қалдым"],
      ["dyspnea_rest", "Одышка в покое", "Демім жетпейді"],
      ["suicidal", "Появились суицидальные мысли", "Өзіме қол жұмсағым келеді"],
      ["meningeal", "Светобоязнь", "Мойным қатайып қалды"],
    ] as const;

    expect(RULES).toHaveLength(8);
    for (const [code, ru, kk] of cases) {
      expect(detectRedFlags(patientSays(ru)).some((flag) => flag.code === code), `${code}: ru`).toBe(true);
      expect(detectRedFlags(patientSays(kk)).some((flag) => flag.code === code), `${code}: kk`).toBe(true);
    }
  });

  it("recognizes an everyday description of neck stiffness", () => {
    const flags = detectRedFlags(patientSays(
      "Высокая температура, шея не сгибается, появилась сыпь",
    ));

    expect(flags.some(({ code }) => code === "meningeal")).toBe(true);
  });

  it.each([
    ["Болит ли у вас грудь?", "Да, сильно"],
    ["Кеудеңіз қатты ауыра ма?", "Иә, қатты"],
  ])("uses a contextual affirmative answer: %s → %s", (question, answer) => {
    const flag = detectRedFlags([
      { role: "assistant", content: question },
      { role: "user", content: answer },
    ]).find(({ code }) => code === "chest_pain");

    expect(flag).toMatchObject({
      evidence: answer,
      elicited_by: question,
      source_message_index: 1,
    });
  });

  it("does not treat a previous absence of bleeding as current bleeding", () => {
    expect(detectRedFlags(patientSays("Не было кровотечения"))).toEqual([]);
  });

  it.each([
    "Боль в груди год назад прошла",
    "Боль в груди была на прошлой неделе, прошла",
    "Боль в груди была, сейчас прошло",
  ])("does not revive a resolved chest symptom after a later answer: %s", (history) => {
    expect(detectRedFlags([
      { role: "user", content: history },
      { role: "assistant", content: "Сколько вам лет?" },
      { role: "user", content: "30" },
    ])).toEqual([]);
  });

  it("mentions dyspnea in the chest-pain label only when dyspnea is present", () => {
    const chestOnly = detectRedFlags(patientSays("Боль в груди"));
    const combined = detectRedFlags(patientSays("Боль в груди, одышка в покое"));

    expect(chestOnly.find(({ code }) => code === "chest_pain")?.label).toBe("Боль в груди");
    expect(combined.find(({ code }) => code === "chest_pain")?.label).toBe("Боль в груди с одышкой");
  });
});
