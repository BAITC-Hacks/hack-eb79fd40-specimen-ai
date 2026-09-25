import {
  normalizeAnamnesis,
  type HistoryStatusValue,
  type TriageResult,
} from "@/lib/types";
import {
  displayedHypothesis,
  hypothesisHeading,
  processingModeNotice,
} from "@/lib/clinical-copy";
import { intakePresentation } from "../data";
import s from "../dashboard.module.css";

const URGENCY = { emergency: "Неотложно", urgent: "Срочно", planned: "Планово", routine: "Рутинно" };

function historyValue(values: readonly string[], status: HistoryStatusValue) {
  if (status === "denied") return "Отрицает";
  if (status === "not_stated") return "Не указано";
  return values.join(", ") || "Не указано";
}

export function IntakeSummary({ result }: { result: TriageResult }) {
  const a = normalizeAnamnesis(result.anamnesis);
  const model = result.model;
  const presentation = intakePresentation(result);
  return <div className={s.details}>
    <div className={s.row}><h3>Сводка для врача</h3><span className={s.tag + (result.urgency === "emergency" ? " " + s.warning : "")}>{URGENCY[result.urgency]}</span></div>
    <p className={s.small}>Источник: {result.processing_mode === "deterministic" ? "детерминированный опросник и правила безопасности" : result.source === "rules_only" ? "только правила; аналитический модуль был недоступен" : result.source === "model" ? "обученная модель" : model?.abstained ? "модель воздержалась; гипотеза не сформирована" : "языковая модель"}</p>
    <p className={s.small}>{processingModeNotice(result.processing_mode)}</p>
    <h3>Жалоба и описание</h3><p>{a.chief_complaint || "Жалоба не указана"}</p>
    <dl><dt>Начало</dt><dd>{a.symptom.onset || "Не указано"}</dd><dt>Локализация / характер</dt><dd>{[a.symptom.location, a.symptom.quality].filter(Boolean).join(" · ") || "Не указаны"}</dd><dt>Выраженность</dt><dd>{presentation.severityLabel}</dd><dt>Что влияет на симптом</dt><dd>{a.symptom.modifiers || "Не указано"}</dd><dt>Сопутствующее</dt><dd>{a.symptom.associated.join(", ") || "Не указано"}</dd></dl>
    <h3>Красные флаги</h3>{result.red_flags.length ? <ul>{result.red_flags.map((flag, index) => <li key={flag.code + index}><strong>{flag.label}</strong> — {flag.evidence_kind === "quote" ? "«" + flag.evidence + "»" : flag.evidence}{flag.elicited_by && <p className={s.small}>В ответ на вопрос: {flag.elicited_by}</p>}</li>)}</ul> : <p>В сводке нет выявленных красных флагов. Это не исключает риски и не заменяет оценку врача.</p>}
    <h3>Основания приоритета</h3><ul>{result.urgency_reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    <h3>Маршрутизация</h3>{presentation.routing.length ? <ul>{presentation.routing.map((route) => <li key={route.specialty}>{route.specialty}{route.confidenceLabel ? " · " + route.confidenceLabel : ""}</li>)}</ul> : <p>Не определена</p>}{presentation.routingHint && <p className={s.small}>{presentation.routingHint}</p>}
    <h3>{hypothesisHeading(result)}</h3><p>{displayedHypothesis(result)}</p><p className={s.notice}>{result.hypothesis.disclaimer}</p>
    <h3>Анамнез и контекст</h3><dl>{[["Перенесённое", a.past_history, a.history_status.past_history], ["Хронические состояния", a.chronic, a.history_status.chronic], ["Аллергии", a.allergies, a.history_status.allergies], ["Лекарства", a.medications, a.history_status.medications]].map(([label, values, status]) => <div key={String(label)}><dt>{label}</dt><dd>{historyValue(values as string[], status as HistoryStatusValue)}</dd></div>)}<div><dt>Факторы риска</dt><dd>{a.context.risk_factors.join(", ") || "Не указано"}</dd></div>{a.negative_findings.length > 0 && <div><dt>Явно отрицает</dt><dd>{a.negative_findings.join(", ")}</dd></div>}</dl>
    <p>Возраст: {a.context.age ?? "не указан"} · Пол: {{ m: "мужской", f: "женский", unknown: "не указан" }[a.context.sex]} · Беременность: {{ yes: "указана", no: "отрицается", na: "не применимо" }[a.context.pregnancy]}</p>
    {model && <><h3>Модель</h3><p className={s.small}>Версия: {model.model_version}{model.abstained ? " · воздержалась: " + (model.abstain_reason === "low_confidence" ? "порог надёжности не пройден" : "вне области обучения") : ""}</p>{!model.abstained && <><ul>{model.pathologies.slice(0, 3).map((item) => <li key={item.code}>{item.label_ru} · {Math.round(item.prob * 100)}%{item.icd10 ? " · " + item.icd10 : ""}</li>)}</ul><h3>Вклад признаков</h3><ul>{model.top_contributions.map((item) => <li key={item.feature}>{item.label_ru}: {item.contribution >= 0 ? "+" : ""}{item.contribution.toFixed(3)}</li>)}</ul></>}</>}
  </div>;
}
