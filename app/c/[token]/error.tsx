"use client";

import { PATIENT } from "@/lib/i18n";

export default function PatientErrorBoundary({ reset }: { reset: () => void }) {
  const text = PATIENT.ru;
  return (
    <div className="wrap">
      <div className="brand"><span className="mark" aria-hidden />Demeu</div>
      <div className="panel finale" role="alert">
        <h1>{text.startErrorTitle}</h1>
        <p>{text.serviceError}</p>
        <button type="button" className="btn state-action" onClick={reset}>
          {text.retry}
        </button>
      </div>
    </div>
  );
}
