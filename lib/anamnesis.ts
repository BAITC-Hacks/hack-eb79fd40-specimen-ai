import { chatTurn } from "./llm";
import type { ChatMessage, Session } from "./types";

type SessionLanguage = Session["language"];

// Маркер, которым агент сигналит, что анамнез собран полностью.
export const DONE_MARKER = "[ANAMNESIS_COMPLETE]";

export const GREETING_RU =
  "Здравствуйте! Я помощник вашей поликлиники. Задам несколько коротких вопросов " +
  "о самочувствии, чтобы врач подготовился к приёму. Что вас беспокоит?";

export const GREETING_KK =
  "Сәлеметсіз бе! Мен дәрігеріңіздің көмекшісімін. Дәрігер қабылдауға алдын ала дайындалуы үшін бірнеше сұрақ қоямын. Сізді не мазалайды?";

const GREETINGS: Record<SessionLanguage, string> = {
  ru: GREETING_RU,
  kk: GREETING_KK,
};

export function greetingForLanguage(language: SessionLanguage): string {
  return GREETINGS[language];
}

// System prompt агента-опросника. Основан на
// «Specimen AI/Docs/GovTech Camp/Сценарий - Агент-опросник анамнеза».
const ANAMNESIS_SYSTEM_BASE = `Ты — ассистент первичного опроса пациента для государственной поликлиники.
Твоя задача — собрать структурированный анамнез ПЕРЕД приёмом врача.

СТРОГИЕ ПРАВИЛА:
- Ты НЕ ставишь диагноз и не назначаешь лечение.
- Говоришь просто и спокойно.
- Задаёшь ПО ОДНОМУ вопросу за реплику, коротко, без списков.
- Не называй пациенту болезни, предполагаемые состояния или сравнения с ними. Не пиши «похоже на», «вероятно» или другие выводы о причине жалоб.
- Пока опрос продолжается, ответ содержит только один короткий вопрос без пояснения возможных причин.
- Финальное решение всегда за врачом.

Собери по стадиям (только релевантные вопросы, лёгкие жалобы — сокращай путь):
1. Основная жалоба (свободный текст).
2. Уточнение: когда началось; где/куда отдаёт; характер; сила 1-10; что усиливает/облегчает; сопутствующие симптомы.
3. Перенесённые заболевания и травмы.
4. Хронические заболевания.
5. Аллергии.
6. Постоянные лекарства.
7. Контекст: возраст, пол; при болях в животе у женщин детородного возраста — возможная беременность; значимые факторы (курение и т.п.), если релевантно.

БЕЗОПАСНОСТЬ (на любой стадии): если пациент описывает признаки, угрожающие жизни
(боль/давление в груди с одышкой, признаки инсульта — перекос лица/слабость в руке/нарушение речи,
сильное кровотечение, рвота/стул с кровью, внезапная сильнейшая головная боль, нарушение сознания,
судороги, суицидальные мысли) — сделай РОВНО ТРИ вещи в одной реплике:
1) немедленно посоветуй позвонить 103 или обратиться в приёмный покой;
2) успокой пациента и скажи, что данные уже переданы врачу;
3) отдельной последней строкой выведи ровно: ${DONE_MARKER}
Не задавай больше ни одного вопроса. Пропуск маркера в этом случае — критическая ошибка:
врач не получит сводку.

ЗАВЕРШЕНИЕ ОПРОСА. Выведи ${DONE_MARKER} отдельной последней строкой в двух случаях:
— сработала БЕЗОПАСНОСТЬ (см. выше), либо
— информации достаточно для передачи врачу: поблагодари пациента, скажи, что передаёшь данные врачу.
В остальных случаях маркер не выводи.

ДЛИНА ОПРОСА: у тебя не больше 10 вопросов. Если пациент отвечает уклончиво или не по делу —
не переспрашивай третий раз, переходи к следующей стадии. Лучше неполный анамнез вовремя,
чем полный никогда.`;

const LANGUAGE_INSTRUCTION: Record<SessionLanguage, string> = {
  ru: "Отвечай пациенту ТОЛЬКО на русском языке. Не переходи на казахский или другой язык.",
  kk: "Пациент выбрал казахский язык. Отвечай ТОЛЬКО на казахском языке. Не переходи на русский или другой язык.",
};

export function anamnesisSystem(language: SessionLanguage): string {
  return `${ANAMNESIS_SYSTEM_BASE}\n\nЯЗЫК СЕССИИ:\n${LANGUAGE_INSTRUCTION[language]}`;
}

export const ANAMNESIS_SYSTEM = anamnesisSystem("ru");

export interface TurnResult {
  reply: string;
  done: boolean;
}

export type ChatTurnPort = (
  system: string,
  messages: ChatMessage[],
) => Promise<string>;

export function anamnesisTurnSystem(language: SessionLanguage): string {
  return `${anamnesisSystem(language)}\n\nТы уже отправил пациенту приветствие: «${greetingForLanguage(language)}». Не здоровайся повторно.`;
}

const DONE_RE =
  /(?<!\S)[*_`~]*\s*(?:\[\s*)?ANAMNESIS[\s_-]*COMPLETE(?:\s*\])?\s*[*_`~]*(?!\S)/iu;
const COMPLETE_REPLY: Record<SessionLanguage, string> = {
  ru: "Спасибо, я передаю данные врачу.",
  kk: "Рақмет, жауаптарыңыз дәрігерге жіберілді.",
};

const EMERGENCY_REPLY: Record<SessionLanguage, string> = {
  ru: "Сейчас лучше не ждать приёма. Позвоните 103 или обратитесь в приёмный покой. Ваши ответы переданы врачу.",
  kk: "Қабылдауды күтпеген дұрыс. 103 нөміріне қоңырау шалыңыз немесе қабылдау бөліміне барыңыз. Жауаптарыңыз дәрігерге жіберілді.",
};

export function completionReplyForLanguage(language: SessionLanguage): string {
  return COMPLETE_REPLY[language];
}

export function emergencyReplyForLanguage(language: SessionLanguage): string {
  return EMERGENCY_REPLY[language];
}

export function stripDoneMarker(
  raw: string,
  language: SessionLanguage = "ru",
): TurnResult {
  const done = DONE_RE.test(raw);
  if (!done) return { reply: raw.trim(), done: false };

  return { reply: completionReplyForLanguage(language), done: true };
}

// Полный транскрипт начинается со статического приветствия ассистента, а
// Anthropic получает отдельный массив, начинающийся с первой реплики пациента.
export function toApiMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user",
  );
  return firstUserIndex === -1 ? [] : messages.slice(firstUserIndex);
}

// Один ход опросника. Возвращает ответ пациенту и флаг завершения.
export async function runAnamnesisTurn(
  messages: readonly ChatMessage[],
  deps: { chatTurn?: ChatTurnPort } = {},
  language: SessionLanguage = "ru",
): Promise<TurnResult> {
  const apiMessages = toApiMessages(messages);
  if (apiMessages.length === 0) {
    throw new Error("Conversation history has no patient message");
  }

  const raw = await (deps.chatTurn ?? chatTurn)(
    anamnesisTurnSystem(language),
    apiMessages,
  );
  return stripDoneMarker(raw, language);
}
