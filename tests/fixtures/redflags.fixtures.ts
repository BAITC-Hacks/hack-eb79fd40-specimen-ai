export interface RedFlagPatternFixture {
  patternId: string;
  code: string;
  utterance: string;
  evidence: string;
}

export const RED_FLAG_PATTERN_FIXTURES: readonly RedFlagPatternFixture[] = [
  { patternId: "chest_pain.ru_pain", code: "chest_pain", utterance: "Со вчера сильная боль в груди, отдаёт в руку", evidence: "боль в груди" },
  { patternId: "chest_pain.ru_pressure", code: "chest_pain", utterance: "Давит в груди, как будто плита", evidence: "Давит в груди" },
  { patternId: "chest_pain.ru_burning", code: "chest_pain", utterance: "Жжение за грудиной после нагрузки", evidence: "Жжение за грудиной" },
  { patternId: "chest_pain.kk_pressure", code: "chest_pain", utterance: "Кеудемді қатты қысады", evidence: "Кеудемді қатты қысады" },
  { patternId: "chest_pain.kk_pain", code: "chest_pain", utterance: "Кеуде қатты ауырады", evidence: "Кеуде қатты ауырады" },
  { patternId: "stroke.ru_face", code: "stroke", utterance: "Внезапно перекосило лицо", evidence: "перекосило лицо" },
  { patternId: "stroke.ru_arm_weakness", code: "stroke", utterance: "Появилась слабость в руке справа", evidence: "слабость в руке" },
  { patternId: "stroke.ru_speech", code: "stroke", utterance: "Речь нарушена, слова путаются", evidence: "Речь нарушена" },
  { patternId: "stroke.ru_numbness", code: "stroke", utterance: "Онемела половина тела слева", evidence: "Онемела половина" },
  { patternId: "stroke.kk_face", code: "stroke", utterance: "Бетім қисайып кетті", evidence: "Бетім қисайып" },
  { patternId: "bleeding.ru_generic", code: "bleeding", utterance: "Началось кровотечение, не останавливается", evidence: "кровотечение" },
  { patternId: "bleeding.ru_vomit", code: "bleeding", utterance: "Сегодня утром была рвота с кровью", evidence: "рвота с кровью" },
  { patternId: "bleeding.ru_stool_with", code: "bleeding", utterance: "Стул с кровью третий день", evidence: "Стул с кровью" },
  { patternId: "bleeding.ru_blood_in_stool", code: "bleeding", utterance: "Заметил кровь в стуле", evidence: "кровь в стуле" },
  { patternId: "bleeding.kk_blood", code: "bleeding", utterance: "Қан құсып жатырмын", evidence: "Қан құсып" },
  { patternId: "thunderclap_headache.ru_strongest", code: "thunderclap_headache", utterance: "Внезапно началась сильнейшая головная боль", evidence: "сильнейшая головная боль" },
  { patternId: "thunderclap_headache.ru_worst", code: "thunderclap_headache", utterance: "Худшая головная боль в моей жизни", evidence: "Худшая головная боль" },
  { patternId: "thunderclap_headache.ru_impact", code: "thunderclap_headache", utterance: "Как удар в голову, за секунду накрыло", evidence: "Как удар в голову" },
  { patternId: "thunderclap_headache.kk_sudden_worst", code: "thunderclap_headache", utterance: "Кенеттен өмірімдегі ең қатты бас ауруы басталды", evidence: "Кенеттен өмірімдегі ең қатты бас ауруы" },
  { patternId: "consciousness.ru_loss", code: "consciousness", utterance: "Вчера потерял сознание на улице", evidence: "потерял сознание" },
  { patternId: "consciousness.ru_seizure", code: "consciousness", utterance: "Были судороги около минуты", evidence: "судороги" },
  { patternId: "consciousness.ru_faint", code: "consciousness", utterance: "Случился обморок в автобусе", evidence: "обморок" },
  { patternId: "consciousness.ru_confusion", code: "consciousness", utterance: "Спутанное сознание, не понимаю где я", evidence: "Спутанное сознание" },
  { patternId: "consciousness.kk_loss", code: "consciousness", utterance: "Есімнен танып қалдым", evidence: "Есімнен танып" },
  { patternId: "dyspnea_rest.ru_rest", code: "dyspnea_rest", utterance: "Одышка в покое, даже лёжа", evidence: "Одышка в покое" },
  { patternId: "dyspnea_rest.ru_unable", code: "dyspnea_rest", utterance: "Не могу дышать нормально", evidence: "Не могу дышать" },
  { patternId: "dyspnea_rest.ru_air_hunger", code: "dyspnea_rest", utterance: "Задыхаюсь, когда сижу", evidence: "Задыхаюсь" },
  { patternId: "dyspnea_rest.kk_difficult", code: "dyspnea_rest", utterance: "Дем алуым қиындады", evidence: "Дем алуым қиындады" },
  { patternId: "dyspnea_rest.kk_air_hunger", code: "dyspnea_rest", utterance: "Демім жетпейді", evidence: "Демім жетпейді" },
  { patternId: "suicidal.ru_term", code: "suicidal", utterance: "Появились суицидальные мысли", evidence: "суицидальные" },
  { patternId: "suicidal.ru_no_life", code: "suicidal", utterance: "Иногда просто не хочу жить", evidence: "не хочу жить" },
  { patternId: "suicidal.ru_end_self", code: "suicidal", utterance: "Думал покончить с собой", evidence: "покончить с собой" },
  { patternId: "suicidal.kk_self_harm", code: "suicidal", utterance: "Өзіме қол жұмсағым келеді", evidence: "Өзіме қол жұмсағым" },
  { patternId: "meningeal.ru_neck", code: "meningeal", utterance: "Температура 39 и ригидность шеи", evidence: "ригидность шеи" },
  { patternId: "meningeal.ru_photophobia", code: "meningeal", utterance: "Светобоязнь, свет режет глаза", evidence: "Светобоязнь" },
  { patternId: "meningeal.ru_cannot_bend", code: "meningeal", utterance: "Не могу наклонить голову к груди", evidence: "Не могу наклонить голову" },
  { patternId: "meningeal.ru_stiff_everyday", code: "meningeal", utterance: "Высокая температура, шея не сгибается, появилась сыпь", evidence: "шея не сгибается" },
  { patternId: "meningeal.kk_neck", code: "meningeal", utterance: "Қызуым көтеріліп, мойным қатайып қалды", evidence: "мойным қатайып" },
  { patternId: "pregnancy_risk.ru_pain_or_blood", code: "pregnancy_risk", utterance: "При беременности болит в животе", evidence: "болит в животе" },
];
