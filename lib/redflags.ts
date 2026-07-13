import type { Anamnesis, RedFlag } from "./types";

// Rule-based детекция красных флагов.
// Сознательно НЕ на «чёрном ящике»: каждый флаг объясним и опирается на
// конкретный фрагмент текста — это закрывает критерий explainability.
//
// ВАЖНО (MVP): список согласуется с практикующими врачами (задача валидации
// в ClickUp). Здесь — разумный базовый набор для демо, не клинический стандарт.

interface Rule {
  code: string;
  label: string;
  emergency: boolean;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    code: "chest_pain",
    label: "Боль в груди с одышкой",
    emergency: true,
    patterns: [/бол\w*\s+в\s+груд/i, /давит\w*\s+груд/i, /жжени\w*\s+за\s+грудин/i],
  },
  {
    code: "stroke",
    label: "Признаки инсульта",
    emergency: true,
    patterns: [
      /перекос\w*\s+лиц/i,
      /слабост\w*\s+в\s+рук/i,
      /наруш\w*\s+реч/i,
      /онемел\w*\s+половин/i,
    ],
  },
  {
    code: "bleeding",
    label: "Кровотечение / кровь в рвоте или стуле",
    emergency: true,
    patterns: [/кровотечен/i, /рвот\w*\s+с\s+кров/i, /стул\w*\s+с\s+кров/i, /кров\w*\s+в\s+стул/i],
  },
  {
    code: "thunderclap_headache",
    label: "Внезапная сильнейшая головная боль",
    emergency: true,
    patterns: [/сильнейш\w*\s+головн\w*\s+бол/i, /худш\w*\s+головн\w*\s+бол/i, /как\s+удар\w*\s+в\s+голов/i],
  },
  {
    code: "consciousness",
    label: "Нарушение сознания / судороги",
    emergency: true,
    patterns: [/потер\w*\s+сознани/i, /судорог/i, /обморок/i, /спутанн\w*\s+сознани/i],
  },
  {
    code: "dyspnea_rest",
    label: "Одышка в покое",
    emergency: true,
    patterns: [/одышк\w*\s+в\s+поко/i, /не\s+могу\s+дышать/i, /задыха\w+/i],
  },
  {
    code: "suicidal",
    label: "Суицидальные мысли",
    emergency: true,
    patterns: [/суицид/i, /не\s+хочу\s+жить/i, /покончить\s+с\s+собой/i],
  },
  {
    code: "meningeal",
    label: "Температура + ригидность шеи + светобоязнь",
    emergency: true,
    patterns: [/ригидност\w*\s+ше/i, /светобоязн/i, /не\s+могу\s+наклонить\s+голов/i],
  },
];

// Дополнительные факторы риска из структуры (не 103, но повышают приоритет).
function contextFlags(a: Anamnesis): RedFlag[] {
  const flags: RedFlag[] = [];
  if (a.context.pregnancy === "yes") {
    const bleed = /кров|бол\w*\s+в\s+живот/i.test(
      a.chief_complaint + " " + a.symptom.associated.join(" ")
    );
    if (bleed) {
      flags.push({
        code: "pregnancy_risk",
        label: "Беременность + боль/кровотечение",
        evidence: "беременность в анамнезе + жалоба на боль/кровотечение",
        emergency: false,
      });
    }
  }
  if (a.context.age !== null && a.context.age >= 65 && a.symptom.severity >= 7) {
    flags.push({
      code: "elderly_severe",
      label: "Пожилой возраст + выраженная симптоматика",
      evidence: `возраст ${a.context.age}, сила ${a.symptom.severity}/10`,
      emergency: false,
    });
  }
  return flags;
}

// transcript — весь текст диалога пациента; anamnesis — структурированный разбор.
export function detectRedFlags(transcript: string, a: Anamnesis): RedFlag[] {
  const found: RedFlag[] = [];
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      const m = transcript.match(p);
      if (m) {
        found.push({
          code: rule.code,
          label: rule.label,
          evidence: `в тексте: «${m[0]}»`,
          emergency: rule.emergency,
        });
        break;
      }
    }
  }
  return [...found, ...contextFlags(a)];
}
