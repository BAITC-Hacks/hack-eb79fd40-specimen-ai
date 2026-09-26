import { describe, expect, it } from "vitest";

import { detectRedFlags } from "../../lib/redflags";
import type { ChatMessage } from "../../lib/types";

const patientSays = (content: string): ChatMessage[] => [
  { role: "user", content },
];

describe("26.09 production emergency regressions", () => {
  it.each([
    [
      "давящая боль за грудиной, отдаёт в левую руку, холодный пот",
      "chest_pain",
    ],
    [
      "самая сильная головная боль в жизни, как удар по голове",
      "thunderclap_headache",
    ],
    [
      "шею не могу нагнуть, от света больно глазам, температура 39",
      "meningeal",
    ],
  ])("raises emergency for exact production phrase: %s", (phrase, code) => {
    const flags = detectRedFlags(patientSays(phrase));

    expect(flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code, emergency: true }),
      ]),
    );
  });

  it("does not raise emergency for the resolved historical episode", () => {
    const phrase =
      "год назад болело в груди, обследовалась, всё прошло, сейчас насморк";

    expect(detectRedFlags(patientSays(phrase))).toEqual([]);
  });
});

describe("independent safety review regressions", () => {
  it.each([
    "Год назад болело в груди и прошло, сегодня одышка в покое",
    "Врач спросил про боль в груди, я ответил нет, но сейчас задыхаюсь",
    "У брата болит в груди, а у меня всё нормально, но сейчас не могу дышать",
  ])("keeps the unrelated active emergency and suppresses old/reported chest pain: %s", (phrase) => {
    expect(
      detectRedFlags(patientSays(phrase)).map(({ code }) => code),
    ).toEqual(["dyspnea_rest"]);
  });

  it.each([
    ["После сна шея не сгибалась. Сейчас температура 39 и ригидность шеи", "meningeal", "ригидность шеи"],
    ["Светобоязнь при мигрени без температуры раньше, а сейчас температура 39 и шея не сгибается", "meningeal", "шея не сгибается"],
    ["В статье было слово светобоязнь, но сейчас ригидность шеи и температура 39", "meningeal", "ригидность шеи"],
    ["В статье прочитал про менингит. У меня ригидность шеи и температура 39.", "meningeal", "ригидность шеи"],
    ["В выписке было слово светобоязнь. У меня ригидность шеи и высокая температура.", "meningeal", "ригидность шеи"],
    ["В статье написано про светобоязнь. Но у меня ригидность шеи и температура 39.", "meningeal", "ригидность шеи"],
    ["В статье написано про светобоязнь. А ригидность шеи у меня началась сегодня.", "meningeal", "ригидность шеи"],
    ["В статье прочитал про менингит, но сейчас у меня симптомы: ригидность шеи и температура 39.", "meningeal", "ригидность шеи"],
    ["В статье прочитал про менингит. Но у меня сейчас симптомы: ригидность шеи и температура 39.", "meningeal", "ригидность шеи"],
    ["В статье прочитал про менингит, у меня сейчас вот что: ригидность шеи и температура 39.", "meningeal", "ригидность шеи"],
    ["В статье прочитал про менингит. Сейчас считаю что у меня ригидность шеи и температура 39.", "meningeal", "ригидность шеи"],
    ["В статье прочитал про менингит. Я считаю что у меня ригидность шеи и температура 39.", "meningeal", "ригидность шеи"],
    ["Боюсь, что начнётся приступ: сейчас не могу дышать", "dyspnea_rest", "не могу дышать"],
    ["Год назад болело в груди, всё прошло. Снова болит в груди.", "chest_pain", null],
    ["Год назад болело в груди, всё прошло. Опять болит в груди.", "chest_pain", null],
    ["Год назад болело в груди, всё прошло. Сегодня грудь болит.", "chest_pain", null],
  ])("does not let an earlier benign or resolved clause hide a current emergency: %s", (phrase, code, evidence) => {
    const flags = detectRedFlags(patientSays(phrase));
    expect(flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code, emergency: true }),
      ]),
    );
    if (evidence !== null) {
      expect(flags.find((flag) => flag.code === code)?.evidence).toBe(evidence);
    }
  });

  it.each([
    "Я отключил телефон",
    "Отключился интернет",
    "Что такое кровотечение?",
    "Боюсь, что начнётся кровотечение",
    "Не могу нормально дышать носом из-за насморка",
    "В выписке встречается термин ригидность шеи",
    "В статье написано слово светобоязнь",
    "В статье написано: светобоязнь.",
    "В выписке указано: ригидность шеи.",
    "Термин: светобоязнь.",
    "В статье написано. Я читаю определение. Светобоязнь.",
    "В статье написано: светобоязнь сегодня считается важным симптомом.",
    "В книге сказано: ригидность шеи сегодня часто обсуждается врачами.",
    "В статье приведена фраза: у меня ригидность шеи.",
    "В книге написано: у меня светобоязнь.",
    "В статье написано: қазір жарыққа қарай алмайды.",
    "В статье написано; светобоязнь сегодня считается важным симптомом.",
    "В статье написано. Светобоязнь сегодня считается важным симптомом.",
    "В книге сказано. Ригидность шеи сегодня часто обсуждается врачами.",
    "В статье написано. Қазір жарыққа қарай алмайды деген белгі талқыланады.",
    "В статье написано. Сегодня светобоязнь является важным симптомом.",
    "Светобоязнь при мигрени без температуры",
    "После сна шея не сгибается",
  ])("does not turn a non-report or incomplete lexical statement into emergency: %s", (phrase) => {
    expect(detectRedFlags(patientSays(phrase))).toEqual([]);
  });

  it.each([
    ["Отключилась и ничего не помню", "consciousness"],
    ["Температура 39 и ригидность шеи", "meningeal"],
    ["Светобоязнь, свет режет глаза", "meningeal"],
  ])("preserves the intended concrete report: %s", (phrase, code) => {
    expect(detectRedFlags(patientSays(phrase)).map((flag) => flag.code)).toEqual([
      code,
    ]);
  });

  it("does not infer multiple families from an ambiguous short affirmation", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Болит ли грудь или есть одышка в покое?",
      },
      { role: "user", content: "Да" },
    ];

    expect(detectRedFlags(messages)).toEqual([]);
  });

  it("keeps a short affirmation when the question names one family", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Болит ли у вас грудь?" },
      { role: "user", content: "Да" },
    ];

    expect(detectRedFlags(messages).map(({ code }) => code)).toEqual([
      "chest_pain",
    ]);
  });
});
