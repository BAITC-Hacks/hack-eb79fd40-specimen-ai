import type { TriageResult } from "@/lib/types";

const URGENCY_LABEL: Record<TriageResult["urgency"], string> = {
  emergency: "Неотложно",
  urgent: "Срочно",
  planned: "Планово",
  routine: "Рутинно",
};

const SEX_LABEL = { m: "мужской", f: "женский", unknown: "не указан" } as const;

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sourceLabel(result: TriageResult): string {
  if (result.source === "model") return "источник: обученная модель";
  if (result.source === "rules_only") {
    return "источник: только правила — аналитический модуль был недоступен";
  }
  return result.model?.abstained
    ? "источник: модель воздержалась · гипотеза языковой модели"
    : "источник: языковая модель";
}

export default function DoctorPanel({ result }: { result: TriageResult }) {
  const model = result.model;
  const showPrediction = Boolean(model && !model.abstained);
  const anamnesis = result.anamnesis;

  return (
    <section className="demo" aria-label="Сводка для врача (демо)">
      <div className="demo-cap">
        <span>Демо-режим — сводка для врача</span>
        <span>фактический ответ API</span>
      </div>

      <div className="urgency-head">
        <span className={`urgency-badge ${result.urgency}`}>
          {URGENCY_LABEL[result.urgency]}
        </span>
        <span className="source-badge">{sourceLabel(result)}</span>
      </div>

      {result.red_flags.length > 0 && (
        <section>
          <h2>Красные флаги</h2>
          {result.red_flags.map((flag, index) => (
            <div key={`${flag.code}-${index}`} className={`flag ${flag.emergency ? "" : "soft"}`}>
              <b>{flag.label}</b>
              <span className="quote">
                {flag.evidence_kind === "quote" ? `«${flag.evidence}»` : flag.evidence}
              </span>
              <div className="meta">
                {flag.evidence_kind === "quote"
                  ? `дословная цитата пациента, сообщение №${flag.source_message_index}`
                  : "производный признак из анамнеза"}
              </div>
            </div>
          ))}
        </section>
      )}

      <h2>Почему такой приоритет</h2>
      <ul className="reasons">
        {result.urgency_reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <h2>Маршрутизация</h2>
      {result.routing.length === 0 ? (
        <p className="muted">Маршрут не определён.</p>
      ) : (
        result.routing.map((route) => (
          <div key={route.specialty} className="routing-row">
            <span>{route.specialty}</span>
            <span className="bar" aria-hidden>
              <i style={{ width: `${Math.max(4, Math.round(route.confidence * 100))}%` }} />
            </span>
            <span className="pct">{percent(route.confidence)}</span>
          </div>
        ))
      )}

      <h2>Предварительная гипотеза</h2>
      <div className="hypo">
        <div className="text">{result.hypothesis.text}</div>
        {result.source === "model" && (
          <div className="conf">Уверенность модели: {percent(result.hypothesis.confidence)}</div>
        )}
        {result.source === "llm_fallback" && (
          <div className="conf">Уверенность ограничена: гипотеза сформирована языковой моделью.</div>
        )}
        <div className="disclaimer">{result.hypothesis.disclaimer}</div>
      </div>

      {model?.abstained && (
        <div className="abstain">
          Модель воздержалась: {model.abstain_reason === "out_of_label_space"
            ? "случай вне области обучения."
            : "ни один вариант не набрал достаточной уверенности."}
        </div>
      )}

      {result.source === "rules_only" && (
        <div className="abstain">
          Признаки не извлечены. Сводка построена на правилах; врачу доступен полный транскрипт.
        </div>
      )}

      {showPrediction && model && (
        <section>
          <h2>Вероятные состояния</h2>
          {model.pathologies.slice(0, 3).map((pathology) => (
            <div key={pathology.code} className="routing-row">
              <span>{pathology.label_ru}{pathology.icd10 ? ` (${pathology.icd10})` : ""}</span>
              <span className="bar" aria-hidden>
                <i style={{ width: `${Math.max(4, Math.round(pathology.prob * 100))}%` }} />
              </span>
              <span className="pct">{percent(pathology.prob)}</span>
            </div>
          ))}
        </section>
      )}

      <h2>Анамнез</h2>
      <dl className="kv-grid">
        <dt>Жалоба</dt><dd>{anamnesis.chief_complaint || "—"}</dd>
        <dt>Начало</dt><dd>{anamnesis.symptom.onset || "—"}</dd>
        <dt>Локализация</dt><dd>{anamnesis.symptom.location || "—"}</dd>
        <dt>Характер</dt><dd>{anamnesis.symptom.quality || "—"}</dd>
        <dt>Сила</dt><dd>{anamnesis.symptom.severity}/10</dd>
        <dt>Сопутствующее</dt><dd>{anamnesis.symptom.associated.join(", ") || "—"}</dd>
        <dt>Хроника</dt><dd>{anamnesis.chronic.join(", ") || "—"}</dd>
        <dt>Аллергии</dt><dd>{anamnesis.allergies.join(", ") || "—"}</dd>
        <dt>Препараты</dt><dd>{anamnesis.medications.join(", ") || "—"}</dd>
        <dt>Возраст / пол</dt>
        <dd>{anamnesis.context.age ?? "—"} / {SEX_LABEL[anamnesis.context.sex]}</dd>
      </dl>
    </section>
  );
}
