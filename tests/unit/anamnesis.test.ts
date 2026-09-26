import { describe, expect, it, vi } from "vitest";
import {
  ANAMNESIS_SYSTEM,
  DONE_MARKER,
  GREETING_KK,
  GREETING_RU,
  anamnesisTurnSystem,
  emergencyReplyForLanguage,
  runAnamnesisTurn,
  stripDoneMarker,
  toApiMessages,
  type ChatTurnPort,
} from "../../lib/anamnesis";
import type { ChatMessage } from "../../lib/types";

describe("Anthropic message history", () => {
  it("returns a new array from the first patient message and preserves the rest", () => {
    const transcript: readonly ChatMessage[] = Object.freeze([
      { role: "assistant", content: GREETING_RU },
      { role: "assistant", content: "Служебно повреждённое второе приветствие" },
      { role: "user", content: "Болит голова" },
      { role: "assistant", content: "Как давно?" },
      { role: "user", content: "Со вчера" },
    ]);

    const apiMessages = toApiMessages(transcript);

    expect(apiMessages).toEqual([
      { role: "user", content: "Болит голова" },
      { role: "assistant", content: "Как давно?" },
      { role: "user", content: "Со вчера" },
    ]);
    expect(apiMessages).not.toBe(transcript);
    expect(transcript).toHaveLength(5);
  });

  it("returns a copy when the transcript already starts with the patient", () => {
    const transcript: readonly ChatMessage[] = [
      { role: "user", content: "Болит голова" },
      { role: "assistant", content: "Как давно?" },
    ];

    const apiMessages = toApiMessages(transcript);

    expect(apiMessages).toEqual(transcript);
    expect(apiMessages).not.toBe(transcript);
  });

  it.each([
    [[] as ChatMessage[]],
    [[{ role: "assistant", content: GREETING_RU }] as ChatMessage[]],
  ])(
    "does not produce an invalid assistant-first payload for %j",
    (messages) => {
      expect(toApiMessages(messages)).toEqual([]);
    },
  );

  it.each([
    [[] as ChatMessage[]],
    [[{ role: "assistant", content: GREETING_RU }] as ChatMessage[]],
  ])(
    "does not call the chat port without a patient message for %j",
    async (messages) => {
      const fakeChatTurn = vi.fn<ChatTurnPort>(async () =>
        Promise.resolve("Ответ"),
      );

      await expect(
        runAnamnesisTurn(messages, { chatTurn: fakeChatTurn }),
      ).rejects.toThrow("no patient message");
      expect(fakeChatTurn).not.toHaveBeenCalled();
    },
  );
});

describe("DONE marker", () => {
  it.each([
    "[ANAMNESIS_COMPLETE]",
    "**[ANAMNESIS_COMPLETE]**",
    "[ ANAMNESIS_COMPLETE ]",
    "[ANAMNESIS COMPLETE]",
    "ANAMNESIS_COMPLETE",
    "`[anamnesis_complete]`",
    "** [ ANAMNESIS_COMPLETE ] **",
    "` [ anamnesis complete ] `",
  ])("detects and removes tolerant form %s", (marker) => {
    const parsed = stripDoneMarker(`Передаю данные врачу.\n${marker}`);

    expect(parsed).toEqual({
      reply: "Спасибо, я передаю данные врачу.",
      done: true,
    });
    expect(parsed.reply).not.toMatch(/ANAMNESIS/iu);
  });

  it("uses a non-empty closing reply when the model returns only the marker", () => {
    expect(stripDoneMarker(DONE_MARKER)).toEqual({
      reply: "Спасибо, я передаю данные врачу.",
      done: true,
    });
  });

  it("replaces a patient-facing conclusion with the server-owned closing", () => {
    const turn = stripDoneMarker(
      `Похоже на обычную простуду лёгкого течения.\n${DONE_MARKER}`,
    );

    expect(turn).toEqual({
      reply: "Спасибо, я передаю данные врачу.",
      done: true,
    });
    expect(turn.reply).not.toMatch(/похоже|простуд/iu);
  });

  it("uses the accepted Kazakh closing when the model returns only the marker", () => {
    const turn = stripDoneMarker(DONE_MARKER, "kk");

    expect(turn).toEqual({
      reply: "Рақмет, жауаптарыңыз дәрігерге жіберілді.",
      done: true,
    });
    expect(turn.reply).not.toMatch(/Спасибо|передаю|врачу/iu);
  });

  it.each([
    "XANAMNESIS_COMPLETEY",
    "ANAMNESIS_COMPLETE_PENDING",
    "ANAMNESIS_COMPLETELY",
    "ANAMNESIS_COMPLETE_123",
    "ANAMNESIS_COMPLETE-REPORT",
    "prefix-ANAMNESIS_COMPLETE",
    "ANAMNESIS_COMPLETE.v2",
    "123_ANAMNESIS_COMPLETE",
  ])("does not treat embedded text as a completion marker: %s", (text) => {
    expect(stripDoneMarker(text)).toEqual({ reply: text, done: false });
  });

  it("requires the safety branch to finish with the marker", async () => {
    expect(ANAMNESIS_SYSTEM).toContain("позвонить 103");
    expect(ANAMNESIS_SYSTEM).toContain(
      `отдельной последней строкой выведи ровно: ${DONE_MARKER}`,
    );

    const fakeChatTurn = vi.fn<ChatTurnPort>(async () =>
      Promise.resolve(
        `Немедленно позвоните 103. Данные переданы врачу.\n**${DONE_MARKER}**`,
      ),
    );
    const turn = await runAnamnesisTurn(
      [{ role: "user", content: "Сильно давит в груди и трудно дышать" }],
      { chatTurn: fakeChatTurn },
    );

    expect(turn).toEqual({
      reply: "Спасибо, я передаю данные врачу.",
      done: true,
    });
    expect(fakeChatTurn).toHaveBeenCalledWith(
      expect.stringContaining(ANAMNESIS_SYSTEM),
      expect.any(Array),
    );
    expect(fakeChatTurn.mock.calls[0]?.[0]).toContain(GREETING_RU);
  });

  it("provides a deterministic server-owned emergency reply", () => {
    expect(emergencyReplyForLanguage("ru")).toBe(
      "Сейчас лучше не ждать приёма. Позвоните 103 или обратитесь в приёмный покой. Ваши ответы переданы врачу.",
    );
    expect(emergencyReplyForLanguage("ru")).not.toMatch(/похоже|вероятно/iu);
  });

  it("forbids patient-facing condition labels and compound explanations", () => {
    expect(ANAMNESIS_SYSTEM).toContain("Не называй пациенту болезни");
    expect(ANAMNESIS_SYSTEM).toContain("только один короткий вопрос");
    expect(ANAMNESIS_SYSTEM).toContain("Не пиши «похоже на»");
  });

  it("builds a strict Kazakh turn prompt with the exact accepted greeting", () => {
    const system = anamnesisTurnSystem("kk");

    expect(system).toContain(`«${GREETING_KK}»`);
    expect(system).toContain("Отвечай ТОЛЬКО на казахском языке");
    expect(system).not.toContain(`«${GREETING_RU}»`);
  });

  it("uses genuine Kazakh copy for the first patient message", () => {
    expect(GREETING_KK).toBe(
      "Сәлеметсіз бе! Мен дәрігеріңіздің көмекшісімін. Дәрігер қабылдауға алдын ала дайындалуы үшін бірнеше сұрақ қоямын. Сізді не мазалайды?",
    );
    expect(GREETING_KK).toMatch(/[әіңғүұқөһ]/iu);
    expect(GREETING_KK).not.toMatch(/здравствуйте|что вас беспокоит|спасибо/iu);
  });
});
