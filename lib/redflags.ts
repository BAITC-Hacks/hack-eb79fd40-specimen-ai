import type { Anamnesis, ChatMessage, RedFlag } from "./types";

interface Rule {
  code: string;
  label: string;
  emergency: boolean;
  patterns: RegExp[];
}

export const RULES: readonly Rule[] = [
  {
    code: "chest_pain",
    label: "Боль в груди с одышкой",
    emergency: true,
    patterns: [
      /(?:бол\p{L}*\s+в\s+груд\p{L}*|бол\p{L}*\s+(?:ли\s+)?(?:у\s+вас\s+)?груд\p{L}*)/iu,
      /давит\p{L}*\s+(?:в\s+)?груд\p{L}*/iu,
      /жжени\p{L}*\s+за\s+грудин\p{L}*/iu,
    ],
  },
  {
    code: "stroke",
    label: "Признаки инсульта",
    emergency: true,
    patterns: [
      /перекос\p{L}*\s+лиц\p{L}*/iu,
      /слабост\p{L}*\s+в\s+рук\p{L}*/iu,
      /(?:наруш\p{L}*\s+реч\p{L}*|реч\p{L}*\s+наруш\p{L}*)/iu,
      /онемел\p{L}*\s+половин\p{L}*/iu,
    ],
  },
  {
    code: "bleeding",
    label: "Кровотечение / кровь в рвоте или стуле",
    emergency: true,
    patterns: [
      /кровотечен\p{L}*/iu,
      /рвот\p{L}*\s+с\s+кров\p{L}*/iu,
      /стул\p{L}*\s+с\s+кров\p{L}*/iu,
      /кров\p{L}*\s+в\s+стул\p{L}*/iu,
    ],
  },
  {
    code: "thunderclap_headache",
    label: "Внезапная сильнейшая головная боль",
    emergency: true,
    patterns: [
      /сильнейш\p{L}*\s+головн\p{L}*\s+бол\p{L}*/iu,
      /худш\p{L}*\s+головн\p{L}*\s+бол\p{L}*/iu,
      /как\s+удар\p{L}*\s+в\s+голов\p{L}*/iu,
    ],
  },
  {
    code: "consciousness",
    label: "Нарушение сознания / судороги",
    emergency: true,
    patterns: [
      /потер\p{L}*\s+сознани\p{L}*/iu,
      /судорог\p{L}*/iu,
      /обморок\p{L}*/iu,
      /спутанн\p{L}*\s+сознани\p{L}*/iu,
    ],
  },
  {
    code: "dyspnea_rest",
    label: "Одышка в покое",
    emergency: true,
    patterns: [
      /одышк\p{L}*\s+в\s+поко\p{L}*/iu,
      /не\s+могу\s+дышать\p{L}*/iu,
      /задыха\p{L}*/iu,
    ],
  },
  {
    code: "suicidal",
    label: "Суицидальные мысли",
    emergency: true,
    patterns: [
      /суицид\p{L}*/iu,
      /не\s+хочу\s+жить\p{L}*/iu,
      /покончить\p{L}*\s+с\s+собой\p{L}*/iu,
    ],
  },
  {
    code: "meningeal",
    label: "Температура + ригидность шеи + светобоязнь",
    emergency: true,
    patterns: [
      /ригидност\p{L}*\s+ше\p{L}*/iu,
      /светобоязн\p{L}*/iu,
      /не\s+могу\s+наклонить\p{L}*\s+голов\p{L}*/iu,
    ],
  },
];

export const CONTEXT_PATTERN_RULES: readonly Rule[] = [
  {
    code: "pregnancy_risk",
    label: "Беременность + боль/кровотечение",
    emergency: false,
    patterns: [/(?:кров\p{L}*|бол\p{L}*\s+в\s+живот\p{L}*)/iu],
  },
];

const CLAUSE_BOUNDARY = /[.,;!?]|\s+(?:и|а|но)\s+/gu;
const NEGATION_BEFORE =
  /(?:^|\s)(?:не|нет|без|отрицаю|отрицает)\s+$/iu;
const NEGATION_AFTER =
  /^\s*(?:[\p{L}\p{N}_-]+\s+){0,2}(?:нет|не\s+было|не\s+бывает|не\s+беспокоит|не\s+болит|отсутствует|не\s+замеча(?:л|ла)|не\s+чувствую|не\s+наблюдается)(?!\p{L})/iu;
const SHORT_AFFIRMATION =
  /^\s*(?:да|ага|угу|есть|бывает|верно|точно|правда|конечно)\s*[,.!]?\s*$/iu;

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

function matchRule(text: string, rule: Rule): string | undefined {
  for (const clause of clauses(text)) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(clause);
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
      const matched = matchRule(elicitedBy ?? message.content, rule);
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
