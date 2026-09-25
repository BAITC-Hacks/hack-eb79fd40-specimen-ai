import type { Language } from "@/lib/http";
import { PATIENT } from "@/lib/i18n";
import { inferInputWidget } from "@/lib/input-widget";

export function PatientMasthead({
  language,
  canChangeLanguage,
  onLanguage,
}: {
  language: Language;
  canChangeLanguage: boolean;
  onLanguage: (language: Language) => void;
}) {
  return (
    <header className="masthead">
      <div className="brand">
        <span className="mark" aria-hidden />
        Demeu
      </div>
      {canChangeLanguage ? (
        <div className="lang-toggle" role="group" aria-label="Тіл / Язык">
          <button
            type="button"
            className={language === "ru" ? "on" : ""}
            aria-pressed={language === "ru"}
            onClick={() => onLanguage("ru")}
          >
            РУС
          </button>
          <button
            type="button"
            className={language === "kk" ? "on" : ""}
            aria-pressed={language === "kk"}
            onClick={() => onLanguage("kk")}
          >
            ҚАЗ
          </button>
        </div>
      ) : (
        <div className="tagline">{PATIENT[language].tagline}</div>
      )}
    </header>
  );
}

export function ConsentScreen({
  language,
  onConsent,
  disabled = false,
}: {
  language: Language;
  onConsent: () => void;
  disabled?: boolean;
}) {
  const text = PATIENT[language];
  return (
    <section className="consent" aria-labelledby="consent-title">
      <h1 id="consent-title">{text.consentTitle}</h1>
      <p>{text.consentBody}</p>
      <ul>
        {text.consentPoints.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <button type="button" className="btn" onClick={onConsent} disabled={disabled}>
        {text.consentAction}
      </button>
    </section>
  );
}

export function ConsentGate({
  ready,
  language,
  onConsent,
}: {
  ready: boolean;
  language: Language;
  onConsent: () => void;
}) {
  return ready
    ? <ConsentScreen language={language} onConsent={onConsent} />
    : <LoadingState language={language} />;
}

export function LoadingState({ language }: { language: Language }) {
  const text = PATIENT[language];
  return (
    <div className="centerpiece" role="status">
      <span className="typing" aria-label={text.starting}>
        <span className="dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        {text.starting}
      </span>
    </div>
  );
}

export function TerminalState({
  title,
  body,
  action,
  onAction,
  actionDisabled = false,
}: {
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <section className="finale centerpiece" role="alert">
      <h1>{title}</h1>
      <p>{body}</p>
      {action && onAction && (
        <button
          type="button"
          className="btn state-action"
          onClick={onAction}
          disabled={actionDisabled}
        >
          {action}
        </button>
      )}
    </section>
  );
}

export function InputWidgetChoices({
  reply,
  language,
  disabled,
  onChoose,
}: {
  reply: string;
  language: Language;
  disabled: boolean;
  onChoose: (answer: string) => void;
}) {
  const kind = inferInputWidget(reply, language);
  const text = PATIENT[language];
  if (kind === "text") return null;

  if (kind === "scale") {
    return (
      <div className="q-widget" aria-label="0–10">
        <div className="scale">
          {Array.from({ length: 11 }, (_, value) => (
            <button
              type="button"
              key={value}
              disabled={disabled}
              onClick={() => onChoose(String(value))}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="scale-caps">
          <span>{text.scaleLow}</span>
          <span>{text.scaleHigh}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="q-widget">
      <div className="chips">
        {[text.yes, text.no].map((answer) => (
          <button
            type="button"
            className="chip-btn"
            key={answer}
            disabled={disabled}
            onClick={() => onChoose(answer)}
          >
            {answer}
          </button>
        ))}
        <span className="widget-hint">{text.freeText}</span>
      </div>
    </div>
  );
}

export function PatientFinale({
  language,
  emergency,
}: {
  language: Language;
  emergency: boolean;
}) {
  const text = PATIENT[language];
  if (emergency) {
    return (
      <section className="finale em" role="alert">
        <h1>{text.emTitle}</h1>
        <p>{text.emBody}</p>
        <a className="btn danger" href="tel:103">
          {text.emCall}
        </a>
        <p>{text.emEr}</p>
        <p>{text.emCompanion}</p>
        <p className="em-sent">{text.emSent}</p>
        <p className="fine">{text.emDisclaimer}</p>
      </section>
    );
  }

  return (
    <section className="finale centerpiece" role="status">
      <div className="glyph" aria-hidden>
        ✓
      </div>
      <h1>{text.doneTitle}</h1>
      <p>{text.doneBody}</p>
      <p>{text.doneEta}</p>
    </section>
  );
}
