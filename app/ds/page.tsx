import { PATIENT_STATES } from "@/lib/patient-state";

const TOKENS = [
  ["Бумага", "#f6f3ec"],
  ["Карточка", "#fdfcf8"],
  ["Хвоя", "#16604a"],
  ["Неотложно", "#a83326"],
  ["Срочно", "#96590a"],
  ["Планово", "#75681b"],
  ["Рутинно", "#2c7154"],
] as const;

export default function DesignSystemPage() {
  return (
    <main className="ds-page">
      <header className="masthead">
        <div className="brand"><span className="mark" aria-hidden />Demeu</div>
        <div className="tagline">дизайн-система v0</div>
      </header>
      <section className="hero">
        <h1>Тихая амбулатория</h1>
        <p className="lead">Тёплая бумага, хвойный акцент, спокойная иерархия и одно главное действие на экран.</p>
      </section>

      <section className="ds-section">
        <h2>Палитра</h2>
        <div className="token-grid">
          {TOKENS.map(([label, color]) => (
            <div className="token-card" key={color}>
              <span className="token-swatch" style={{ background: color }} />
              <b>{label}</b><code>{color}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="ds-section">
        <h2>Компоненты</h2>
        <div className="component-row">
          <button type="button" className="btn">Главное действие</button>
          <button type="button" className="btn ghost">Вторичное</button>
          <a className="btn danger" href="tel:103">Позвонить 103</a>
        </div>
        <div className="component-row">
          {(["emergency", "urgent", "planned", "routine"] as const).map((urgency) => (
            <span className={`urgency-badge ${urgency}`} key={urgency}>{urgency}</span>
          ))}
        </div>
      </section>

      <section className="ds-section">
        <h2>Состояния пациента</h2>
        <ol className="state-grid">
          {PATIENT_STATES.map((state) => <li key={state}><code>{state}</code></li>)}
        </ol>
        <p className="muted">Перед этими 15 состояниями отдельно показывается согласие — до создания сессии. Поверхность не делает сетевых запросов.</p>
      </section>
    </main>
  );
}
