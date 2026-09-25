import type { TriageResult } from "./types";

export const DISCLAIMER =
  "Это предварительная гипотеза, это не диагноз, решает врач.";
export const ABSTAIN_HYPOTHESIS =
  "Модель воздержалась — гипотеза не сформирована, решение за врачом.";
export const RULES_ONLY_HYPOTHESIS =
  "Гипотеза не сформирована: структурированные признаки недоступны, решение за врачом.";
export const DETERMINISTIC_HYPOTHESIS =
  "Гипотеза не формировалась: ответы фиксированного опроса и срабатывания правил безопасности переданы врачу.";

export function displayedHypothesis(result: TriageResult): string {
  if (result.processing_mode === "deterministic") return DETERMINISTIC_HYPOTHESIS;
  return result.model?.abstained ? ABSTAIN_HYPOTHESIS : result.hypothesis.text;
}

export function hypothesisHeading(result: Pick<TriageResult, "model" | "processing_mode">): string {
  if (result.processing_mode === "deterministic") return "Гипотеза не формировалась";
  return result.model?.abstained ? "Гипотеза не сформирована" : "Предварительная гипотеза";
}

export function processingModeNotice(
  mode: TriageResult["processing_mode"],
): string {
  if (mode === "deterministic") {
    return "Режим обработки: детерминированный. Ответы пациента не передавались внешней языковой модели.";
  }
  if (mode === "external_llm") {
    return "Режим обработки: внешняя языковая модель. Ответы пациента передавались внешней языковой модели для обработки.";
  }
  return "Режим обработки не зафиксирован: сводка создана до добавления этого поля.";
}
