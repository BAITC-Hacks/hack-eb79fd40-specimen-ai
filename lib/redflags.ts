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
      { id: "chest_pain.ru_pain", regex: /(?:бол\p{L}*\s+в\s+груд\p{L}*|бол\p{L}*\s+(?:ли\s+)?(?:у\s+вас\s+)?груд\p{L}*|груд\p{L}*\s+бол\p{L}*)/iu },
      { id: "chest_pain.ru_pressure", regex: /давит\p{L}*\s+(?:в\s+)?груд\p{L}*/iu },
      { id: "chest_pain.ru_retrosternal_pressure", regex: /давящ\p{L}*\s+бол\p{L}*\s+за\s+грудин\p{L}*/iu },
      { id: "chest_pain.ru_burning", regex: /жжени\p{L}*\s+за\s+грудин\p{L}*/iu },
      { id: "chest_pain.kk_pressure", regex: /кеуд\p{L}*\s+(?:қатты\s+)?қыс(?!пай|пей|бай|бей|май|мей)\p{L}*/iu },
      { id: "chest_pain.kk_pain", regex: /кеуд\p{L}*\s+(?:қатты\s+)?ауыр(?!май|мей)\p{L}*/iu },
      { id: "chest_pain.kk_location_pain", regex: /кеуде\s+тұс\p{L}*\s+(?:қатты\s+)?ауыр\p{L}*/iu },
    ],
  },
  {
    code: "stroke",
    label: "Признаки инсульта",
    emergency: true,
    patterns: [
      { id: "stroke.ru_face", regex: /перекос\p{L}*\s+лиц\p{L}*/iu },
      { id: "stroke.ru_face_reverse", regex: /(?<!\p{L})лиц\p{L}*\s+(?:внезапно\s+)?перекос\p{L}*/iu },
      { id: "stroke.ru_arm_weakness", regex: /слабост\p{L}*\s+в\s+(?:\p{L}+\s+)?рук\p{L}*/iu },
      { id: "stroke.ru_arm_numb", regex: /(?<!\p{L})(?:онемел\p{L}*\s+(?:(?:правая|левая)\s+)?рук\p{L}*|рук\p{L}*\s+онемел\p{L}*)/iu },
      { id: "stroke.ru_speech", regex: /(?:наруш\p{L}*\s+реч\p{L}*|реч\p{L}*\s+наруш\p{L}*)/iu },
      { id: "stroke.ru_slurred_speech", regex: /(?<!\p{L})(?:реч\p{L}*\s+(?:стала\s+)?(?:невнятн\p{L}*|неразборчив\p{L}*)|(?:невнятн\p{L}*|неразборчив\p{L}*)\s+реч\p{L}*)/iu },
      { id: "stroke.ru_numbness", regex: /онемел\p{L}*\s+половин\p{L}*/iu },
      { id: "stroke.kk_face", regex: /бет\p{L}*\s+қиса\p{L}*/iu },
      { id: "stroke.ru_mouth_arm", regex: /(?:угол\s+рта\s+опуст\p{L}*|рук\p{L}*\s+ослаб\p{L}*)/iu },
      { id: "stroke.kk_arm_weakness", regex: /қол\p{L}*(?:\s+кенет)?\s+әлсір\p{L}*/iu },
      { id: "stroke.kk_speech", regex: /сөз\p{L}*\s+түсініксіз\p{L}*/iu },
      { id: "stroke.kk_half_numb", regex: /ден\p{L}*\s+бір\s+жағ\p{L}*\s+ұйы\p{L}*/iu },
      { id: "stroke.kk_mouth", regex: /ау\p{L}*\s+қиса\p{L}*/iu },
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
      { id: "bleeding.ru_flow", regex: /кров\p{L}*\s+(?:ид\p{L}*|теч\p{L}*)/iu },
      { id: "bleeding.kk_vomit_blood", regex: /құс\p{L}*\s+қан\s+бар/iu },
      { id: "bleeding.kk_stool_blood", regex: /дәрет\p{L}*\s+қан\p{L}*/iu },
    ],
  },
  {
    code: "thunderclap_headache",
    label: "Внезапная сильнейшая головная боль",
    emergency: true,
    patterns: [
      { id: "thunderclap_headache.ru_strongest", regex: /сильнейш\p{L}*\s+головн\p{L}*\s+бол\p{L}*/iu },
      { id: "thunderclap_headache.ru_lifetime_worst", regex: /сам\p{L}*\s+сильн\p{L}*\s+головн\p{L}*\s+бол\p{L}*\s+в\s+жизн\p{L}*/iu },
      { id: "thunderclap_headache.ru_worst", regex: /худш\p{L}*\s+головн\p{L}*\s+бол\p{L}*/iu },
      { id: "thunderclap_headache.ru_impact", regex: /(?:как|будто)\s+удар\p{L}*\s+в\s+голов\p{L}*/iu },
      { id: "thunderclap_headache.kk_sudden_worst", regex: /кенет\p{L}*(?:\s+\p{L}+){0,4}\s+ең\s+қатты\s+бас\s+(?:ауру|ауыр)\p{L}*/iu },
      { id: "thunderclap_headache.ru_seconds", regex: /за\s+секунд\p{L}*\s+возник\p{L}*(?:\s+\p{L}+){0,2}\s+головн\p{L}*\s+бол\p{L}*/iu },
      { id: "thunderclap_headache.kk_unprecedented", regex: /кенет\p{L}*\s+бас\p{L}*\s+бұрын-соңды\s+болмағандай\s+қатты\s+ауыр\p{L}*/iu },
      { id: "thunderclap_headache.kk_impact", regex: /бас\p{L}*\s+соққы\s+тигендей(?:\s+\p{L}+){0,2}\s+ауыр\p{L}*/iu },
      { id: "thunderclap_headache.kk_worst_first", regex: /өмір\p{L}*\s+ең\s+қатты\s+бас\s+ауру\p{L}*(?:\s+\p{L}+){0,2}\s+кенет\p{L}*/iu },
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
      { id: "consciousness.ru_blackout", regex: /отключил(?:ся|ась|ось)(?!\s+(?:телефон\p{L}*|интернет\p{L}*|свет\p{L}*))/iu },
      { id: "consciousness.kk_faint", regex: /тал\p{L}*\s+қал\p{L}*/iu },
      { id: "consciousness.kk_seizure", regex: /құрыс\p{L}*\s+қал\p{L}*/iu },
      { id: "consciousness.kk_confusion", regex: /ес\p{L}*\s+шатас\p{L}*/iu },
      { id: "consciousness.kk_loss_reverse", regex: /ес\p{L}*\s+жоғалт\p{L}*/iu },
    ],
  },
  {
    code: "dyspnea_rest",
    label: "Одышка в покое",
    emergency: true,
    patterns: [
      { id: "dyspnea_rest.ru_rest", regex: /одышк\p{L}*\s+в\s+поко\p{L}*/iu },
      { id: "dyspnea_rest.ru_unable", regex: /не\s+могу(?:\s+\p{L}+){0,2}\s+дышать\p{L}*/iu },
      { id: "dyspnea_rest.ru_air_hunger", regex: /задыха\p{L}*/iu },
      { id: "dyspnea_rest.kk_difficult", regex: /дем\s+ал\p{L}*\s+қиын\p{L}*/iu },
      { id: "dyspnea_rest.kk_air_hunger", regex: /дем\p{L}*\s+жетпе\p{L}*/iu },
      { id: "dyspnea_rest.ru_air_lack", regex: /воздух\p{L}*\s+не\s+хвата\p{L}*(?:\s+без\s+нагруз\p{L}*)?/iu },
      { id: "dyspnea_rest.ru_difficult_bed", regex: /тяжел\p{L}*\s+дышать\p{L}*\s+даже\s+в\s+постел\p{L}*/iu },
      { id: "dyspnea_rest.kk_rest_air", regex: /тыныш\p{L}*(?:\s+\p{L}+){0,3}\s+ауа\s+жетпе\p{L}*/iu },
      { id: "dyspnea_rest.kk_lying", regex: /жат\p{L}*\s+тыныс\s+алу\s+қиын\p{L}*/iu },
      { id: "dyspnea_rest.kk_rest_dyspnea", regex: /қимылда\p{L}*\s+да\s+ентіг\p{L}*/iu },
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
      { id: "suicidal.ru_self_harm", regex: /причинить\p{L}*\s+себе\s+вред\p{L}*/iu },
      { id: "suicidal.ru_kill_self", regex: /(?:мысл\p{L}*\s+)?убить\p{L}*\s+себя/iu },
      { id: "suicidal.kk_no_life", regex: /өмір\s+сүрг\p{L}*\s+келмей\p{L}*/iu },
      { id: "suicidal.kk_kill_self", regex: /өзім\p{L}*\s+өлтір\p{L}*(?:\s+туралы\s+ой\p{L}*)?/iu },
      { id: "suicidal.kk_harm", regex: /өзіме\s+зиян\s+келтірг\p{L}*\s+кел(?!мей)\p{L}*/iu },
      { id: "suicidal.kk_farewell", regex: /өмірмен\s+қоштас\p{L}*\s+ойла\p{L}*/iu },
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
      { id: "meningeal.ru_neck_cannot_lower", regex: /ше\p{L}*\s+не\s+могу\s+нагну\p{L}*/iu },
      { id: "meningeal.kk_neck", regex: /мой\p{L}*\s+қатай\p{L}*/iu },
      { id: "meningeal.kk_light", regex: /жарық\p{L}*\s+қарай\s+алмай\p{L}*/iu },
      { id: "meningeal.kk_bend", regex: /мой\p{L}*\s+бүг\p{L}*\s+қиын\p{L}*/iu },
      { id: "meningeal.kk_stiff", regex: /мой\p{L}*\s+сірес\p{L}*/iu },
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

const CLAUSE_BOUNDARY = /[.,;:!?]|\s+(?:и|а|но|және|бірақ|алайда)\s+/gu;
const NEGATION_BEFORE =
  /(?:^|\s)(?:(?:никогда\s+)?не(?:\s+было)?|никогда\s+не\s+\p{L}+|нет|без|отрицаю|отрицает|жоқ|емес)\s+$/iu;
const NEGATION_AFTER =
  /^\s*(?:[\p{L}\p{N}_-]+\s+){0,3}(?:нет|не\s+было|не\s+бывает|не\s+беспокоит|не\s+болит|не\s+случа\p{L}*|отсутствует|не\s+замеча(?:л|ла)|не\s+чувствую|не\s+наблюдается|жоқ\p{L}*|болған\s+жоқ\p{L}*|болмады|емес\p{L}*|келмейді)(?!\p{L})/iu;
// Only a direct correction at the end of this clause. A different noun after
// the dash ("— боли нет", "— нет боли") does not deny the preceding symptom.
const DIRECT_DASH_DENIAL_AFTER =
  /^\s*[—–-]\s*(?:нет|не\s+было|не\s+беспокоит|отсутствует|не\s+наблюдается)\s*$/iu;
const ARM_WEAKNESS = /(?<!\p{L})слабост\p{L}*\s+в\s+(?:\p{L}+\s+)?рук\p{L}*\s*$/iu;
const LEG_WEAKNESS_DENIAL =
  /^\s*(?:в\s+)?(?:(?:прав\p{L}*|лев\p{L}*)\s+)?ног(?:е|ах)\s+(?:нет|не\s+было|не\s+наблюдается|отсутству(?:ет|ют)|не\s+чувствую|не\s+замеча(?:л|ла))(?!\p{L})/iu;
const SHORT_AFFIRMATION =
  /^\s*(?:(?:да|ага|угу|верно|точно|правда|конечно|иә|ия)(?:\s*[,—-]?\s*(?:(?:очень\s+)?сильно|есть|бывает|қатты|бар))?|есть|бывает|бар)\s*[,.!]?\s*$/iu;

// Только явно завершённый эпизод, датированный годами назад.
export const RESOLVED_YEARS_AGO_AFTER =
  /^(?:\s+был(?:а|и|о)?)?\s+(?:(?:[1-9][0-9]*|один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|несколько)\s+)?(?:год|года|лет)\s+назад\s*[,.;!]?\s*(?:прошл[аои]|сейчас\s+ничего\s+не\s+беспокоит)(?=\s*[.!]?\s*$)/iu;

const PAST_CONTEXT =
  /(?:\p{L}+\s+){0,3}(?:год|года|лет|недел\p{L}*)\s+назад|на\s+прошл\p{L}*\s+недел\p{L}*|(?:бұрын|өткен\s+(?:жылы|аптада))/iu;
const RESOLVED_CONTEXT =
  /(?:прошл\p{L}*|прекратил\p{L}*|сейчас\s+(?:вс[её]\s+)?(?:ничего\s+)?(?:нет|не\s+беспокоит|прошл\p{L}*)|қазір(?:\s+\p{L}+){0,3}\s+(?:өт\p{L}*|тоқта\p{L}*|жоқ\p{L}*))/iu;
const ELAPSED_DURATION =
  /прошл\p{L}*\s+(?:[1-9][0-9]*|один|два|три|четыре|пять|несколько)\s+(?:дн\p{L}*|час\p{L}*|недел\p{L}*)/iu;
const CURRENT_AFTER_RESOLUTION =
  /(?:вернул\p{L}*|(?:сейчас|теперь|сегодня|қазір)\s+(?:снова|опять)(?!\p{L})|(?:нет\s*[,;:—-]\s*)?(?:снова|опять)\s*$|(?:сейчас|теперь|сегодня|қазір)(?:\s+\p{L}+){0,4}\s+(?:бол\p{L}*|дав\p{L}*|ауыр\p{L}*|қайта\p{L}*)|(?:но\s+)?сегодня\s+это\s+начал\p{L}*|уже(?:\s+\p{L}+){1,3}\s+так\s+же)/iu;
const CURRENT_RECURRENCE = CURRENT_AFTER_RESOLUTION;
const EXPLICIT_CURRENT_RESOLUTION = /(?:сейчас|теперь)\s+(?:вс[её]\s+)?прошл\p{L}*/iu;
const THIRD_PARTY_CONTEXT =
  /(?:у\s+(?:брата|мамы|жены|мужа|сестры|друга|реб[её]нка)|(?:брат|мам|жен|муж|сестр|друг|реб[её]нок|герой\s+фильм)\p{L}*|(?:әкем|ағам|жұбайым|досым|бала|кейіпкер)\p{L}*)/iu;
const SELF_CLEAR_CONTEXT =
  /(?:у\s+меня|со\s+мной|ко\s+мне)(?:\s+\p{L}+){0,5}\s+(?:нет|ничего\s+не\s+\p{L}+|нормальн\p{L}*|не\s+относится)|(?:а\s+)?я(?:\s+\p{L}+){0,5}\s+(?:нормальн\p{L}*|помощ\p{L}*)|мен(?:де)?(?:\s+\p{L}+){0,5}\s+(?:жоқ\p{L}*|жақсы|қалыпты)/iu;
const QUOTED_DENIAL_CONTEXT =
  /(?:фраза(?:\s+\p{L}+){0,8}\s+книг\p{L}*|фильм\p{L}*(?:\s+\p{L}+){0,4}\s+кейіпкер\p{L}*).*(?:у\s+меня|ко\s+мне|менде).*(?:нет|не\s+\p{L}+|жоқ\p{L}*)/iu;
const SCREENING_DENIAL_CONTEXT =
  /(?:врач\p{L}*\s+спросил\p{L}*|дәрігер\p{L}*(?:\s+\p{L}+){0,4}\s+сұра\p{L}*).*(?:нет|жоқ\p{L}*)/iu;
const NON_REPORT_QUESTION_OR_HYPOTHESIS =
  /^\s*(?:(?:что|почему)\s+(?:такое|значит|будет|начн\p{L}*)|боюсь\s*,?\s*что\s+(?:начн\p{L}*|будет))/iu;
const NASAL_BREATHING_CONTEXT =
  /дышать\s+нос\p{L}*[^.!?]*(?:насморк\p{L}*|залож\p{L}*)/iu;
const MENINGEAL_META_CONTEXT =
  /(?:в\s+(?:статье|выписке|книге)|термин|слово)\p{L}*/iu;
const SELF_REPORT_CLAUSE = /(?:^|\s)(?:у\s+меня|менде)(?!\p{L})/iu;
const CURRENT_CLAUSE_START =
  /^\s*(?:(?:но|а)\s+)?(?:сейчас|теперь|сегодня|қазір)(?!\p{L})/iu;
const META_EXPLANATORY_CLAUSE =
  /(?:счита(?:ется|ются)|обсужда\p{L}*|явля\p{L}*|талқыла\p{L}*|деген\s+белгі)/iu;
const MENINGEAL_BENIGN_CONTEXT =
  /(?:при\s+мигрен\p{L}*[^.!?]*без\s+температур\p{L}*|после\s+сна)/iu;
const MENINGEAL_LEXICAL_PATTERNS = new Set([
  "meningeal.ru_neck",
  "meningeal.ru_photophobia",
]);

function isExplicitCurrentClause(clause: string): boolean {
  return SELF_REPORT_CLAUSE.test(clause) || (
    CURRENT_CLAUSE_START.test(clause) && !META_EXPLANATORY_CLAUSE.test(clause)
  );
}

function isNonCurrentMatch(clause: string, followUp: string): boolean {
  const context = `${clause} ${followUp}`;
  if (
    (PAST_CONTEXT.test(clause) || EXPLICIT_CURRENT_RESOLUTION.test(context)) &&
    RESOLVED_CONTEXT.test(context) &&
    !ELAPSED_DURATION.test(context) &&
    !CURRENT_AFTER_RESOLUTION.test(context)
  ) return true;
  if (THIRD_PARTY_CONTEXT.test(clause) && SELF_CLEAR_CONTEXT.test(context)) return true;
  return SCREENING_DENIAL_CONTEXT.test(context) || QUOTED_DENIAL_CONTEXT.test(context);
}

function isNonEmergencyMeaning(
  clause: string,
  previousClause: string,
  previousContext: string,
  boundaryBefore: string,
  rule: Rule,
  patternId: string,
): boolean {
  if (NON_REPORT_QUESTION_OR_HYPOTHESIS.test(clause)) return true;
  if (rule.code === "dyspnea_rest" && NASAL_BREATHING_CONTEXT.test(clause)) {
    return true;
  }
  if (
    rule.code === "meningeal" &&
    (MENINGEAL_BENIGN_CONTEXT.test(clause) ||
      (/^[:;]$/u.test(boundaryBefore) && MENINGEAL_META_CONTEXT.test(previousClause)) || (
        MENINGEAL_META_CONTEXT.test(previousContext) &&
        META_EXPLANATORY_CLAUSE.test(clause) &&
        !SELF_REPORT_CLAUSE.test(clause)
      ) || (
        MENINGEAL_LEXICAL_PATTERNS.has(patternId) &&
        (MENINGEAL_META_CONTEXT.test(clause) || (
          MENINGEAL_META_CONTEXT.test(previousContext) &&
          !isExplicitCurrentClause(previousClause) &&
          !CURRENT_RECURRENCE.test(clause) &&
          !isExplicitCurrentClause(clause)
        ))
      ))
  ) {
    return true;
  }
  return false;
}

function clauses(text: string): { text: string; boundaryBefore: string }[] {
  const result: { text: string; boundaryBefore: string }[] = [];
  let last = 0;
  let boundaryBefore = "";
  CLAUSE_BOUNDARY.lastIndex = 0;
  let boundary: RegExpExecArray | null;

  while ((boundary = CLAUSE_BOUNDARY.exec(text))) {
    // Shared weakness can name both limbs before its denial: "слабости в
    // руках и ногах нет". Keep that small anatomical list together; an "и"
    // between different symptoms still separates their negation scopes.
    if (
      /^\s+и\s+$/u.test(boundary[0]) &&
      ARM_WEAKNESS.test(text.slice(last, boundary.index)) &&
      LEG_WEAKNESS_DENIAL.test(
        text.slice(boundary.index + boundary[0].length),
      )
    ) continue;
    result.push({ text: text.slice(last, boundary.index), boundaryBefore });
    boundaryBefore = boundary[0];
    last = boundary.index + boundary[0].length;
  }
  result.push({ text: text.slice(last), boundaryBefore });
  return result;
}

function isNegated(clause: string, start: number, end: number): boolean {
  const after = clause.slice(end);
  const conjunction = /^\s+и\s+/u.exec(after);
  // This suffix belongs to the same weakness report even with "и в левой
  // ноге нет" or a plural absence predicate. Do not enlarge the general
  // word window or cross a new leg-pain predicate.
  const coordinatedWeaknessDenial = conjunction !== null &&
    ARM_WEAKNESS.test(clause.slice(start, end)) &&
    LEG_WEAKNESS_DENIAL.test(after.slice(conjunction[0].length));
  // The generic token window admits hyphens in words. Never let a standalone
  // ASCII dash use that window to cross into an independent predicate.
  const suffixDenial = /^\s*[—–-]/u.test(after)
    ? DIRECT_DASH_DENIAL_AFTER.test(after)
    : NEGATION_AFTER.test(after);
  return (
    NEGATION_BEFORE.test(clause.slice(0, start)) ||
    suffixDenial ||
    coordinatedWeaknessDenial
  );
}

function matchRule(
  text: string,
  rule: Rule,
  includeResolvedHistory = false,
): string | undefined {
  const textClauses = clauses(text);
  for (let clauseIndex = 0; clauseIndex < textClauses.length; clauseIndex += 1) {
    const { text: clause, boundaryBefore } = textClauses[clauseIndex];
    const precedingClauses = textClauses
      .slice(0, clauseIndex)
      .map((candidate) => candidate.text)
      .filter((candidate) => candidate.trim().length > 0);
    const previousClause = precedingClauses.at(-1) ?? "";
    const previousContext = precedingClauses
      .slice(-2)
      .join(" ");
    // Resolution/ownership qualifiers often occupy their own short clause. Keep
    // this window local to the matched report so a later, unrelated emergency
    // remains detectable (for example historical chest pain + current dyspnea).
    const followUp = textClauses
      .slice(clauseIndex + 1)
      .map((candidate) => candidate.text)
      .filter((candidate) => candidate.trim().length > 0)
      .slice(0, 2)
      .join(" ");
    for (const { id, regex } of rule.patterns) {
      // A denied first mention must not hide a later positive report using
      // the same pattern. A fresh matcher leaves the exported rules stateless.
      const matcher = new RegExp(regex.source, `${regex.flags}g`);
      for (const match of clause.matchAll(matcher)) {
        const deniedScreeningQuestion = boundaryBefore === ":" &&
          SCREENING_DENIAL_CONTEXT.test(`${previousClause} ${clause} ${followUp}`) &&
          /^\s*(?:я\s+)?(?:ответил\p{L}*|сказал\p{L}*)\s+(?:нет|жоқ\p{L}*)(?!\p{L})/iu.test(followUp);
        if (
          !isNegated(clause, match.index, match.index + match[0].length) &&
          !deniedScreeningQuestion &&
          (includeResolvedHistory || CURRENT_RECURRENCE.test(text) || !isNonCurrentMatch(clause, followUp)) &&
          !isNonEmergencyMeaning(clause, previousClause, previousContext, boundaryBefore, rule, id)
        ) {
          return match[0];
        }
      }
    }
  }
  return undefined;
}

function hasLaterRecurrence(
  messages: readonly ChatMessage[],
  userMessageIndex: number,
  rule: Rule,
): boolean {
  for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (CURRENT_RECURRENCE.test(message.content) || matchRule(message.content, rule) !== undefined) {
      return true;
    }
  }
  return false;
}

function precedingQuestion(
  messages: readonly ChatMessage[],
  userMessageIndex: number,
  rule: Rule,
): string | undefined {
  const answer = messages[userMessageIndex].content;
  if (!SHORT_AFFIRMATION.test(answer)) return undefined;

  const previous = messages[userMessageIndex - 1];
  if (previous?.role !== "assistant") return undefined;
  const matchingCodes = RULES.filter((candidate) =>
    candidate.patterns.some(({ regex }) => regex.test(previous.content)),
  ).map(({ code }) => code);
  return matchingCodes.length === 1 && matchingCodes[0] === rule.code
    ? previous.content
    : undefined;
}

export function detectRedFlags(messages: readonly ChatMessage[]): RedFlag[] {
  const found: RedFlag[] = [];

  for (const rule of RULES) {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "user") continue;

      const elicitedBy = precedingQuestion(messages, index, rule);
      const includeResolvedHistory = Boolean(elicitedBy) || (
        rule.code === "chest_pain" && hasLaterRecurrence(messages, index, rule)
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
