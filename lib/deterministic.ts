import {
  completionReplyForLanguage,
  type TurnResult,
} from "./anamnesis";
import type {
  ChatMessage,
  HistoryStatusValue,
  NormalizedAnamnesis,
  Session,
} from "./types";

type Language = Session["language"];

const QUESTIONS: Record<Language, readonly string[]> = {
  ru: [
    "Когда это началось?",
    "Где вы чувствуете симптом и как его опишете?",
    "Насколько сильно это беспокоит по шкале от 0 до 10?",
    "Есть ли другие симптомы, и какие важные симптомы вы явно отрицаете?",
    "Какие заболевания, операции или травмы вы переносили раньше?",
    "Есть ли у вас хронические состояния?",
    "Есть ли у вас аллергии?",
    "Какие лекарства вы принимаете постоянно?",
    "Укажите возраст, пол и значимые факторы риска, например курение; если применимо, сообщите о возможной беременности.",
  ],
  kk: [
    "Бұл қашан басталды?",
    "Белгіні қай жерден сезесіз және оны қалай сипаттайсыз?",
    "Бұл 0-ден 10-ға дейінгі шкала бойынша қаншалықты қатты мазалайды?",
    "Басқа белгілер бар ма және қандай маңызды белгілердің жоқ екенін нақты айта аласыз?",
    "Бұрын қандай аурулар, операциялар немесе жарақаттар болды?",
    "Созылмалы жағдайларыңыз бар ма?",
    "Аллергияңыз бар ма?",
    "Қандай дәрілерді тұрақты қабылдайсыз?",
    "Жасыңызды, жынысыңызды және темекі шегу сияқты маңызды қауіп факторларын көрсетіңіз; қажет болса, жүктілік мүмкіндігін айтыңыз.",
  ],
};

const UNKNOWN_RE = /(?:не\s+знаю|не\s+помню|не\s+указ|білмеймін|есімде\s+жоқ)/iu;
const NEGATIVE_RE = /(?:^|[^\p{L}])(?:нет|не|жоқ|емес|болма)(?!\p{L})/iu;
const SHORT_YES_RE = /^(?:да|иә|ия)$/iu;
const SHORT_NO_RE = /^(?:нет|жоқ)$/iu;
const DENIED_CLAUSE_RE = /(?:^|[^\p{L}])(?:нет|не\s+было|не\s+перенос\p{L}*|не\s+принима\p{L}*|отрица\p{L}*|жоқ|болған\s+жоқ|қабылдамаймын|болмады)(?!\p{L})/iu;

function patientAnswers(messages: readonly ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
}

export function runDeterministicAnamnesisTurn(
  messages: readonly ChatMessage[],
  language: Language,
): TurnResult {
  const answerCount = patientAnswers(messages).length;
  if (answerCount < 1) {
    throw new Error("Conversation history has no patient message");
  }
  const nextQuestion = QUESTIONS[language][answerCount - 1];
  return nextQuestion
    ? { reply: nextQuestion, done: false }
    : { reply: completionReplyForLanguage(language), done: true };
}

function splitClauses(value: string): string[] {
  return value
    .split(/[,.!?;\n]+|\s+(?:но|бірақ|алайда)\s+/iu)
    .map((item) => item.trim())
    .filter(Boolean);
}

function history(
  value: string | undefined,
): { values: string[]; status: HistoryStatusValue } {
  const normalized = value?.trim() ?? "";
  if (!normalized || UNKNOWN_RE.test(normalized)) {
    return { values: [], status: "not_stated" };
  }
  if (SHORT_YES_RE.test(normalized)) return { values: [], status: "not_stated" };
  if (SHORT_NO_RE.test(normalized)) return { values: [], status: "denied" };

  const clauses = splitClauses(normalized);
  const values = clauses.filter((clause) =>
    !UNKNOWN_RE.test(clause) &&
    !SHORT_YES_RE.test(clause) &&
    !SHORT_NO_RE.test(clause) &&
    !DENIED_CLAUSE_RE.test(clause),
  );
  if (values.length > 0) return { values, status: "reported" };
  if (clauses.some((clause) => SHORT_NO_RE.test(clause) || DENIED_CLAUSE_RE.test(clause))) {
    return { values: [], status: "denied" };
  }
  return { values: [], status: "not_stated" };
}

function severity(value: string | undefined): number | null {
  const match = value?.match(/(?:^|[^0-9])(10|[0-9])(?:\s*(?:из|\/|балл|ұпай))/iu)
    ?? value?.match(/(?:^|[^0-9])(10|[0-9])(?:[^0-9]|$)/u);
  return match ? Number(match[1]) : null;
}

function sex(value: string): "m" | "f" | "unknown" {
  if (/(?:мужчин|мужской|ер\s+адам|еркек)/iu.test(value)) return "m";
  if (/(?:женщин|женский|әйел)/iu.test(value)) return "f";
  return "unknown";
}

function pregnancy(value: string): "yes" | "no" | "na" {
  if (/(?:не\s+беременна|беременности\s+нет|жүктілік\s+жоқ)/iu.test(value)) {
    return "no";
  }
  if (/(?:беременна|жүктімін|жүктілік\s+бар)/iu.test(value)) return "yes";
  return "na";
}

export function assembleDeterministicAnamnesis(
  messages: readonly ChatMessage[],
): NormalizedAnamnesis {
  const answers = patientAnswers(messages);
  const allAnswers = answers.join(". ");
  const associated = splitClauses(answers[4] ?? "");
  const negativeFindings = associated.filter((item) =>
    !SHORT_NO_RE.test(item) && NEGATIVE_RE.test(item),
  );
  const positiveAssociated = associated.filter((item) =>
    !SHORT_YES_RE.test(item) && !SHORT_NO_RE.test(item) && !NEGATIVE_RE.test(item),
  );
  const past = history(answers[5]);
  const chronic = history(answers[6]);
  const allergies = history(answers[7]);
  const medications = history(answers[8]);
  const context = allAnswers;
  const ageMatch = context.match(/(?:^|[^0-9])(1[01][0-9]|120|[1-9]?[0-9])\s*(?:лет|года?|жас)(?!\p{L})/iu);
  const riskFactors = splitClauses(answers[9] ?? "").filter((item) =>
    /(?:кур|табак|темекі|вейп|алкогол)/iu.test(item) && !NEGATIVE_RE.test(item),
  );

  return {
    chief_complaint: answers[0] ?? "",
    symptom: {
      onset: answers[1] ?? "",
      location: answers[2] ?? "",
      quality: answers[2] ?? "",
      severity: severity(answers[3]) ?? severity(answers[0]),
      modifiers: "",
      associated: positiveAssociated,
    },
    past_history: past.values,
    chronic: chronic.values,
    allergies: allergies.values,
    medications: medications.values,
    history_status: {
      past_history: past.status,
      chronic: chronic.status,
      allergies: allergies.status,
      medications: medications.status,
    },
    negative_findings: [...new Set(negativeFindings)],
    context: {
      age: ageMatch ? Number(ageMatch[1]) : null,
      sex: sex(context),
      pregnancy: pregnancy(context),
      risk_factors: riskFactors,
    },
  };
}
