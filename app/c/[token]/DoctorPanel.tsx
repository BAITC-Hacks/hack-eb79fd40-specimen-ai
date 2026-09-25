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

const URGENCY_LABEL: Record<TriageResult["urgency"], string> = {
  emergency: "Неотложно",
  urgent: "Срочно",
  planned: "Планово",
  routine: "Рутинно",
};

const SEX_LABEL = { m: "мужской", f: "женский", unknown: "не указан" } as const;

export const SYNTHETIC_DEMO_RESULT: TriageResult = {
  anamnesis: {
    chief_complaint: "Учебный пример: боль в пояснице",
    symptom: {
      onset: "две недели назад",
      location: "поясница",
      quality: "ноющая",
      severity: 4,
      modifiers: "сильнее к вечеру",
      associated: [],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: {
      age: 34,
      sex: "f",
      pregnancy: "no",
      risk_factors: [],
    },
  },
  red_flags: [],
  urgency: "planned",
  urgency_reasons: ["Синтетический пример без признаков неотложности."],
  routing: [{ specialty: "неврология", confidence: 1 }],
  hypothesis: {
    text: "Учебная предварительная гипотеза для демонстрации интерфейса врачу.",
    confidence: 0,
    disclaimer: "Это не диагноз. Финальное решение принимает врач.",
  },
  source: "rules_only",
  processing_mode: "deterministic",
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sourceLabel(result: TriageResult): string {
  if (result.processing_mode === "deterministic") {
    return "источник: детерминированный опросник и правила";
  }
  if (result.source === "model") return "источник: обученная модель";
  if (result.source === "rules_only") {
    return "источник: только правила — аналитический модуль был недоступен";
  }
  return result.model?.abstained
    ? "источник: модель воздержалась · гипотеза не сформирована"
    : "источник: языковая модель";
}

function historyValue(
  values: readonly string[],
  status: HistoryStatusValue,
): string {
  if (status === "denied") return "отрицает";
  if (status === "not_stated") return "не указано";
  return values.join(", ") || "не указано";
}

export default function DoctorPanel({ result }: { result: TriageResult }) {
  const model = result.model;
  const showPrediction = Boolean(model && !model.abstained);
  const anamnesis = normalizeAnamnesis(result.anamnesis);

  return (
    <section className="demo" aria-label="Сводка для врача (демо)">
      <div className="demo-cap">
        <span>Локальное демо — сводка для врача</span>
        <span>только вымышленные данные</span>
      </div>

      <div className="urgency-head">
        <span className={`urgency-badge ${result.urgency}`}>
          {URGENCY_LABEL[result.urgency]}
        </span>
        <span className="source-badge">{sourceLabel(result)}</span>
      </div>
      <p className="muted">{processingModeNotice(result.processing_mode)}</p>

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
      {result.source === "model" && result.routing.length > 0 ? (
        result.routing.map((route) => (
          <div key={route.specialty} className="routing-row">
            <span>{route.specialty}</span>
            <span className="bar" aria-hidden>
              <i style={{ width: `${Math.max(4, Math.round(route.confidence * 100))}%` }} />
            </span>
            <span className="pct">{percent(route.confidence)}</span>
          </div>
        ))
      ) : result.source === "llm_fallback" && result.routing.length > 0 ? (
        <div>
          <ul className="reasons">
            {result.routing.map((route) => (
              <li key={route.specialty}>{route.specialty}</li>
            ))}
          </ul>
          <p className="muted">Ориентировочный маршрут, без числовой оценки</p>
        </div>
      ) : (
        <p className="muted">Маршрут не определён.</p>
      )}

      <h2>{hypothesisHeading(result)}</h2>
      <div className="hypo">
        <div className="text">{displayedHypothesis(result)}</div>
        {result.source === "model" && (
          <div className="conf">Уверенность модели: {percent(result.hypothesis.confidence)}</div>
        )}
        {result.source === "llm_fallback" && !model?.abstained && (
          <div className="conf">Уверенность ограничена: гипотеза сформирована языковой моделью.</div>
        )}
        <div className="disclaimer">{result.hypothesis.disclaimer}</div>
      </div>

      {model?.abstained && (
        <div className="abstain">
          Модель воздержалась: {model.abstain_reason === "out_of_label_space"
            ? "случай вне области обучения."
            : "порог модели не пройден."}
        </div>
      )}

      {result.source === "rules_only" && result.processing_mode !== "deterministic" && (
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
        <dt>Сила</dt>
        <dd>
          {anamnesis.symptom.severity === null
            ? "—"
            : `${anamnesis.symptom.severity}/10`}
        </dd>
        <dt>Сопутствующее</dt><dd>{anamnesis.symptom.associated.join(", ") || "—"}</dd>
        <dt>Хроника</dt><dd>{historyValue(anamnesis.chronic, anamnesis.history_status.chronic)}</dd>
        <dt>Аллергии</dt><dd>{historyValue(anamnesis.allergies, anamnesis.history_status.allergies)}</dd>
        <dt>Препараты</dt><dd>{historyValue(anamnesis.medications, anamnesis.history_status.medications)}</dd>
        {anamnesis.negative_findings.length > 0 && (
          <>
            <dt>Явно отрицает</dt>
            <dd>{anamnesis.negative_findings.join(", ")}</dd>
          </>
        )}
        <dt>Возраст / пол</dt>
        <dd>{anamnesis.context.age ?? "—"} / {SEX_LABEL[anamnesis.context.sex]}</dd>
      </dl>
    </section>
  );
}
