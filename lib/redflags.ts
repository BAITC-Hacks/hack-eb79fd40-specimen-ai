import type { Anamnesis, ChatMessage, RedFlag } from "./types";

interface Rule {
  code: string;
  label: string;
  emergency: boolean;
  patterns: readonly { id: string; regex: RegExp }[];
}

export const RULES: readonly Rule[] = [
  {
    code: "chest_pain",
    label: "Боль в груди",
    emergency: true,
    patterns: [
      { id: "chest_pain.ru_pain", regex: /(?:бол\p{L}*\s+в\s+груд\p{L}*|бол\p{L}*\s+(?:ли\s+)?(?:у\s+вас\s+)?груд\p{L}*)/iu },
      { id: "chest_pain.ru_pressure", regex: /давит\p{L}*\s+(?:в\s+)?груд\p{L}*/iu },
      { id: "chest_pain.ru_burning", regex: /жжени\p{L}*\s+за\s+грудин\p{L}*/iu },
      { id: "chest_pain.kk_pressure", regex: /кеуд\p{L}*\s+(?:қатты\s+)?қыс(?!пай|пей|бай|бей|май|мей)\p{L}*/iu },
      { id: "chest_pain.kk_pain", regex: /кеуд\p{L}*\s+(?:қатты\s+)?ауыр(?!май|мей)\p{L}*/iu },
    ],
  },
  {
    code: "stroke",
    label: "Признаки инсульта",
    emergency: true,
    patterns: [
      { id: "stroke.ru_face", regex: /перекос\p{L}*\s+лиц\p{L}*/iu },
      { id: "stroke.ru_arm_weakness", regex: /слабост\p{L}*\s+в\s+рук\p{L}*/iu },
      { id: "stroke.ru_speech", regex: /(?:наруш\p{L}*\s+реч\p{L}*|реч\p{L}*\s+наруш\p{L}*)/iu },
      { id: "stroke.ru_numbness", regex: /онемел\p{L}*\s+половин\p{L}*/iu },
      { id: "stroke.kk_face", regex: /бет\p{L}*\s+қиса\p{L}*/iu },
    ],
  },
  {
    code: "bleeding",
    label: "Кровотечение / кровь в рвоте или стуле",
    emergency: true,
    patterns: [
      { id: "bleeding.ru_generic", regex: /кровотечен\p{L}*/iu },
      { id: "bleeding.ru_vomit", regex: /рвот\p{L}*\s+с\s+кров\p{L}*/iu },
      { id: "bleeding.ru_stool_with", regex: /стул\p{L}*\s+с\s+кров\p{L}*/iu },
      { id: "bleeding.ru_blood_in_stool", regex: /кров\p{L}*\s+в\s+стул\p{L}*/iu },
      { id: "bleeding.kk_blood", regex: /қан\s+(?:құс\p{L}*|кет\p{L}*|ағ\p{L}*)/iu },
    ],
  },
  {
    code: "thunderclap_headache",
    label: "Внезапная сильнейшая головная боль",
    emergency: true,
    patterns: [
      { id: "thunderclap_headache.ru_strongest", regex: /сильнейш\p{L}*\s+головн\p{L}*\s+бол\p{L}*/iu },
      { id: "thunderclap_headache.ru_worst", regex: /худш\p{L}*\s+головн\p{L}*\s+бол\p{L}*/iu },
      { id: "thunderclap_headache.ru_impact", regex: /как\s+удар\p{L}*\s+в\s+голов\p{L}*/iu },
      { id: "thunderclap_headache.kk_sudden_worst", regex: /кенет\p{L}*(?:\s+\p{L}+){0,4}\s+ең\s+қатты\s+бас\s+(?:ауру|ауыр)\p{L}*/iu },
    ],
  },
  {
    code: "consciousness",
    label: "Нарушение сознания / судороги",
    emergency: true,
    patterns: [
      { id: "consciousness.ru_loss", regex: /потер\p{L}*\s+сознани\p{L}*/iu },
      { id: "consciousness.ru_seizure", regex: /судорог\p{L}*/iu },
      { id: "consciousness.ru_faint", regex: /обморок\p{L}*/iu },
      { id: "consciousness.ru_confusion", regex: /спутанн\p{L}*\s+сознани\p{L}*/iu },
      { id: "consciousness.kk_loss", regex: /ес\p{L}*\s+тан\p{L}*/iu },
    ],
  },
  {
    code: "dyspnea_rest",
    label: "Одышка в покое",
    emergency: true,
    patterns: [
      { id: "dyspnea_rest.ru_rest", regex: /одышк\p{L}*\s+в\s+поко\p{L}*/iu },
      { id: "dyspnea_rest.ru_unable", regex: /не\s+могу\s+дышать\p{L}*/iu },
      { id: "dyspnea_rest.ru_air_hunger", regex: /задыха\p{L}*/iu },
      { id: "dyspnea_rest.kk_difficult", regex: /дем\s+ал\p{L}*\s+қиын\p{L}*/iu },
      { id: "dyspnea_rest.kk_air_hunger", regex: /дем\p{L}*\s+жетпе\p{L}*/iu },
    ],
  },
  {
    code: "suicidal",
    label: "Суицидальные мысли",
    emergency: true,
    patterns: [
      { id: "suicidal.ru_term", regex: /суицид\p{L}*/iu },
      { id: "suicidal.ru_no_life", regex: /не\s+хочу\s+жить\p{L}*/iu },
      { id: "suicidal.ru_end_self", regex: /покончить\p{L}*\s+с\s+собой\p{L}*/iu },
      { id: "suicidal.kk_self_harm", regex: /өзіме\s+қол\s+жұмса\p{L}*/iu },
    ],
  },
  {
    code: "meningeal",
    label: "Температура + ригидность шеи + светобоязнь",
    emergency: true,
    patterns: [
      { id: "meningeal.ru_neck", regex: /ригидност\p{L}*\s+ше\p{L}*/iu },
      { id: "meningeal.ru_photophobia", regex: /светобоязн\p{L}*/iu },
      { id: "meningeal.ru_cannot_bend", regex: /не\s+могу\s+наклонить\p{L}*\s+голов\p{L}*/iu },
      { id: "meningeal.ru_stiff_everyday", regex: /(?:ше\p{L}*\s+не\s+сгиба\p{L}*|не\s+(?:могу\s+)?согну\p{L}*\s+ше\p{L}*)/iu },
      { id: "meningeal.kk_neck", regex: /мой\p{L}*\s+қатай\p{L}*/iu },
    ],
  },
];

export const CONTEXT_PATTERN_RULES: readonly Rule[] = [
  {
    code: "pregnancy_risk",
    label: "Беременность + боль/кровотечение",
    emergency: false,
    patterns: [{ id: "pregnancy_risk.ru_pain_or_blood", regex: /(?:кров\p{L}*|бол\p{L}*\s+в\s+живот\p{L}*)/iu }],
  },
];

const CLAUSE_BOUNDARY = /[.,;!?]|\s+(?:и|а|но|және|бірақ|алайда)\s+/gu;
const NEGATION_BEFORE =
  /(?:^|\s)(?:(?:никогда\s+)?не(?:\s+было)?|нет|без|отрицаю|отрицает|жоқ|емес)\s+$/iu;
const NEGATION_AFTER =
  /^\s*(?:[\p{L}\p{N}_-]+\s+){0,2}(?:нет|не\s+было|не\s+бывает|не\s+беспокоит|не\s+болит|отсутствует|не\s+замеча(?:л|ла)|не\s+чувствую|не\s+наблюдается|жоқ\p{L}*|болған\s+жоқ\p{L}*|болмады|емес|келмейді)(?!\p{L})/iu;
const SHORT_AFFIRMATION =
  /^\s*(?:(?:да|ага|угу|верно|точно|правда|конечно|иә|ия)(?:\s*[,—-]?\s*(?:(?:очень\s+)?сильно|есть|бывает|қатты|бар))?|есть|бывает|бар)\s*[,.!]?\s*$/iu;

// Только явно завершённый эпизод, датированный годами назад.
export const RESOLVED_YEARS_AGO_AFTER =
  /^(?:\s+был(?:а|и|о)?)?\s+(?:(?:[1-9][0-9]*|один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|несколько)\s+)?(?:год|года|лет)\s+назад\s*[,.;!]?\s*(?:прошл[аои]|сейчас\s+ничего\s+не\s+беспокоит)(?=\s*[.!]?\s*$)/iu;

export const RESOLVED_CHEST_HISTORY_AFTER =
  /^\s*(?:был(?:а|и|о)?\s*)?[,;]?\s*(?:(?:(?:[1-9][0-9]*|один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|несколько)\s+)?(?:год|года|лет)\s+назад\s*[,;.!]?\s*(?:прошл[аои]?|сейчас\s+ничего\s+не\s+беспокоит)|на\s+прошл\p{L}*\s+недел\p{L}*\s*[,;.!]?\s*прошл[аои]?|(?:сейчас|теперь)\s+прошл[аои]?)\s*[.!]?\s*$/iu;

const CURRENT_RECURRENCE =
  /(?:сейчас|теперь|сегодня)\s+(?:снова|опять|болит\p{L}*|давит\p{L}*|это\s+начал\p{L}*)|уже(?:\s+\p{L}+){1,3}\s+так\s+же/iu;

function isResolvedChestHistory(text: string, rule: Rule): boolean {
  for (const { regex } of rule.patterns) {
    const match = regex.exec(text);
    if (
      match &&
      !CURRENT_RECURRENCE.test(text.slice(0, match.index)) &&
      RESOLVED_CHEST_HISTORY_AFTER.test(text.slice(match.index + match[0].length))
    ) {
      return true;
    }
  }
  return false;
}

function clauses(text: string): string[] {
  const result: string[] = [];
  let last = 0;
  CLAUSE_BOUNDARY.lastIndex = 0;
  let boundary: RegExpExecArray | null;

  while ((boundary = CLAUSE_BOUNDARY.exec(text))) {
    result.push(text.slice(last, boundary.index));
    last = boundary.index + boundary[0].length;
  }
  result.push(text.slice(last));
  return result;
}

function isNegated(clause: string, start: number, end: number): boolean {
  return (
    NEGATION_BEFORE.test(clause.slice(0, start)) ||
    NEGATION_AFTER.test(clause.slice(end))
  );
}

function matchRule(
  text: string,
  rule: Rule,
  includeResolvedHistory = false,
): string | undefined {
  if (
    !includeResolvedHistory &&
    rule.code === "chest_pain" &&
    isResolvedChestHistory(text, rule)
  ) {
    return undefined;
  }
  for (const clause of clauses(text)) {
    for (const { regex } of rule.patterns) {
      const match = regex.exec(clause);
      if (
        match?.index !== undefined &&
        !isNegated(clause, match.index, match.index + match[0].length)
      ) {
        return match[0];
      }
    }
  }
  return undefined;
}

function hasLaterChestRecurrence(
  messages: readonly ChatMessage[],
  userMessageIndex: number,
  rule: Rule,
): boolean {
  for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (
      CURRENT_RECURRENCE.test(message.content) ||
      matchRule(message.content, rule, true) !== undefined
    ) {
      return true;
    }
  }
  return false;
}

function precedingQuestion(
  messages: readonly ChatMessage[],
  userMessageIndex: number
): string | undefined {
  const answer = messages[userMessageIndex].content;
  if (!SHORT_AFFIRMATION.test(answer)) return undefined;

  const previous = messages[userMessageIndex - 1];
  return previous?.role === "assistant" ? previous.content : undefined;
}

export function detectRedFlags(messages: readonly ChatMessage[]): RedFlag[] {
  const found: RedFlag[] = [];

  for (const rule of RULES) {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "user") continue;

      const elicitedBy = precedingQuestion(messages, index);
      const includeResolvedHistory = Boolean(elicitedBy) || (
        rule.code === "chest_pain" &&
        hasLaterChestRecurrence(messages, index, rule)
      );
      const matched = matchRule(
        elicitedBy ?? message.content,
        rule,
        includeResolvedHistory,
      );
      if (!matched) continue;

      found.push({
        code: rule.code,
        label: rule.label,
        evidence: elicitedBy ? message.content : matched,
        evidence_kind: "quote",
        emergency: rule.emergency,
        source_message_index: index,
        ...(elicitedBy ? { elicited_by: elicitedBy } : {}),
      });
      break;
    }
  }

  const chestPain = found.find(({ code }) => code === "chest_pain");
  if (chestPain && found.some(({ code }) => code === "dyspnea_rest")) {
    chestPain.label = "Боль в груди с одышкой";
  }

  return found;
}

export function contextFlags(
  anamnesis: Anamnesis,
  _messages: readonly ChatMessage[]
): RedFlag[] {
  void _messages;
  const found: RedFlag[] = [];

  if (anamnesis.context.pregnancy === "yes") {
    const complaint = [
      anamnesis.chief_complaint,
      ...anamnesis.symptom.associated,
    ].join(" ");
    const rule = CONTEXT_PATTERN_RULES[0];
    if (matchRule(complaint, rule)) {
      found.push({
        code: rule.code,
        label: rule.label,
        evidence: "беременность + жалоба на боль/кровотечение",
        evidence_kind: "derived",
        emergency: rule.emergency,
        source_message_index: -1,
      });
    }
  }

  if (
    anamnesis.context.age !== null &&
    anamnesis.context.age >= 65 &&
    anamnesis.symptom.severity !== null &&
    anamnesis.symptom.severity >= 7
  ) {
    found.push({
      code: "elderly_severe",
      label: "Пожилой возраст + выраженная симптоматика",
      evidence: `возраст ${anamnesis.context.age}, сила ${anamnesis.symptom.severity}/10`,
      evidence_kind: "derived",
      emergency: false,
      source_message_index: -1,
    });
  }

  return found;
}
