import type { Language } from "@/lib/http";

export type InputWidget = "scale" | "yes_no" | "text";

const SCALE_RU =
  /(?:0\s*(?:—|-|до)\s*10|по\s+шкале|насколько\s+(?:сильно|выраженн)|сила\s+(?:боли|симптом))/iu;
const SCALE_KK =
  /(?:0\s*(?:—|-)\s*ден\s+10\s*(?:—|-)?\s*ға|0\s*(?:—|-|ден)\s*10|10\s*(?:балл|ұпай)|қаншалықты\s+(?:қатты|күшті))/iu;

const OPEN_RU =
  /(?:^|[^\p{L}])(?:что|как\p{L}*|когда|где|почему|сколько|перечисл\p{L}*|расскаж\p{L}*|опиш\p{L}*)(?!\p{L})/iu;
const OPEN_KK =
  /(?:^|[^\p{L}])(?:қандай|қалай|қашан|қайда|неге|неше|айтып|сипатта\p{L}*)(?!\p{L})/iu;

const CLOSED_RU =
  /(?:(?:есть|бывает|появляется|сохраняется|усиливается|принимаете|можете|чувствуете)\s+ли(?!\p{L})|^.*(?:есть|бывает|появляется|сохраняется|усиливается|принимаете|можете|чувствуете).*\?\s*$|да\s+или\s+нет)/iu;
const CLOSED_KK =
  /(?:(?:бар|жоқ)\s+(?:ма|ме|ба|бе|па|пе)(?!\p{L})|(?:бола|қабылдай)\p{L}*\s+(?:ма|ме|ба|бе|па|пе)(?!\p{L}))/iu;

export function inferInputWidget(reply: string, language: Language): InputWidget {
  const normalized = reply.trim();
  if (!normalized) return "text";
  if ((language === "ru" ? SCALE_RU : SCALE_KK).test(normalized)) return "scale";
  if ((language === "ru" ? OPEN_RU : OPEN_KK).test(normalized)) return "text";
  if ((language === "ru" ? CLOSED_RU : CLOSED_KK).test(normalized)) return "yes_no";
  return "text";
}
