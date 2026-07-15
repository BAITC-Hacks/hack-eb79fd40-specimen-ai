export interface RedFlagPatternFixture {
  patternId: string;
  code: string;
  utterance: string;
  evidence: string;
}

export const RED_FLAG_PATTERN_FIXTURES: readonly RedFlagPatternFixture[] = [
  { patternId: "chest_pain#0", code: "chest_pain", utterance: "Со вчера сильная боль в груди, отдаёт в руку", evidence: "боль в груди" },
  { patternId: "chest_pain#1", code: "chest_pain", utterance: "Давит в груди, как будто плита", evidence: "Давит в груди" },
  { patternId: "chest_pain#2", code: "chest_pain", utterance: "Жжение за грудиной после нагрузки", evidence: "Жжение за грудиной" },
  { patternId: "stroke#0", code: "stroke", utterance: "Внезапно перекосило лицо", evidence: "перекосило лицо" },
  { patternId: "stroke#1", code: "stroke", utterance: "Появилась слабость в руке справа", evidence: "слабость в руке" },
  { patternId: "stroke#2", code: "stroke", utterance: "Речь нарушена, слова путаются", evidence: "Речь нарушена" },
  { patternId: "stroke#3", code: "stroke", utterance: "Онемела половина тела слева", evidence: "Онемела половина" },
  { patternId: "bleeding#0", code: "bleeding", utterance: "Началось кровотечение, не останавливается", evidence: "кровотечение" },
  { patternId: "bleeding#1", code: "bleeding", utterance: "Сегодня утром была рвота с кровью", evidence: "рвота с кровью" },
  { patternId: "bleeding#2", code: "bleeding", utterance: "Стул с кровью третий день", evidence: "Стул с кровью" },
  { patternId: "bleeding#3", code: "bleeding", utterance: "Заметил кровь в стуле", evidence: "кровь в стуле" },
  { patternId: "thunderclap_headache#0", code: "thunderclap_headache", utterance: "Внезапно началась сильнейшая головная боль", evidence: "сильнейшая головная боль" },
  { patternId: "thunderclap_headache#1", code: "thunderclap_headache", utterance: "Худшая головная боль в моей жизни", evidence: "Худшая головная боль" },
  { patternId: "thunderclap_headache#2", code: "thunderclap_headache", utterance: "Как удар в голову, за секунду накрыло", evidence: "Как удар в голову" },
  { patternId: "consciousness#0", code: "consciousness", utterance: "Вчера потерял сознание на улице", evidence: "потерял сознание" },
  { patternId: "consciousness#1", code: "consciousness", utterance: "Были судороги около минуты", evidence: "судороги" },
  { patternId: "consciousness#2", code: "consciousness", utterance: "Случился обморок в автобусе", evidence: "обморок" },
  { patternId: "consciousness#3", code: "consciousness", utterance: "Спутанное сознание, не понимаю где я", evidence: "Спутанное сознание" },
  { patternId: "dyspnea_rest#0", code: "dyspnea_rest", utterance: "Одышка в покое, даже лёжа", evidence: "Одышка в покое" },
  { patternId: "dyspnea_rest#1", code: "dyspnea_rest", utterance: "Не могу дышать нормально", evidence: "Не могу дышать" },
  { patternId: "dyspnea_rest#2", code: "dyspnea_rest", utterance: "Задыхаюсь, когда сижу", evidence: "Задыхаюсь" },
  { patternId: "suicidal#0", code: "suicidal", utterance: "Появились суицидальные мысли", evidence: "суицидальные" },
  { patternId: "suicidal#1", code: "suicidal", utterance: "Иногда просто не хочу жить", evidence: "не хочу жить" },
  { patternId: "suicidal#2", code: "suicidal", utterance: "Думал покончить с собой", evidence: "покончить с собой" },
  { patternId: "meningeal#0", code: "meningeal", utterance: "Температура 39 и ригидность шеи", evidence: "ригидность шеи" },
  { patternId: "meningeal#1", code: "meningeal", utterance: "Светобоязнь, свет режет глаза", evidence: "Светобоязнь" },
  { patternId: "meningeal#2", code: "meningeal", utterance: "Не могу наклонить голову к груди", evidence: "Не могу наклонить голову" },
  { patternId: "pregnancy_risk#0", code: "pregnancy_risk", utterance: "При беременности болит в животе", evidence: "болит в животе" },
];
