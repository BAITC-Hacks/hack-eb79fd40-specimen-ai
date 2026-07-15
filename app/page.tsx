"use client";

import { useEffect, useRef, useState } from "react";
import { buildPatientLink, isDoctorUnauthorized } from "@/lib/doctor-ui";
import { createLink, type ApiFailure } from "@/lib/http";
import { DOCTOR as text } from "@/lib/i18n";

type Phase = "idle" | "generating" | "ready";
type CopyState = "idle" | "copied" | "manual";

function doctorFailureText(failure: ApiFailure): string {
  if (failure.kind === "network") return text.networkError;
  if (failure.kind === "timeout") return text.timeoutError;
  if (isDoctorUnauthorized(failure)) return text.wrongCode;
  if (failure.kind === "http" && failure.status === 429) return text.rateLimited;
  return text.serverError;
}

export default function DoctorHome() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [token, setToken] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [doctorCode, setDoctorCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [retryBlocked, setRetryBlocked] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2_500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  function respectRetryDelay(nextFailure: ApiFailure) {
    const delay = nextFailure.kind === "http" ? nextFailure.retryAfterMs : undefined;
    if (!delay || delay <= 0) return;
    setRetryBlocked(true);
    window.setTimeout(() => setRetryBlocked(false), delay);
  }

  async function generate() {
    setPhase("generating");
    setFailure(null);
    setCopyState("idle");
    const response = await createLink(doctorCode.trim() || undefined);
    if (!response.ok) {
      setFailure(response.failure);
      setShowCode(isDoctorUnauthorized(response.failure));
      respectRetryDelay(response.failure);
      setPhase(token ? "ready" : "idle");
      return;
    }
    setToken(response.data.token);
    setShowCode(false);
    setPhase("ready");
  }

  const link = token
    ? buildPatientLink(
        typeof window === "undefined" ? "" : window.location.origin,
        token,
      )
    : "";
  const spokenToken = token
    ? (token.toUpperCase().match(/.{1,2}/g) ?? [token.toUpperCase()]).join(" ")
    : "";

  async function copyLink() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(link);
      setCopyState("copied");
    } catch {
      linkRef.current?.focus();
      linkRef.current?.select();
      setCopyState("manual");
    }
  }

  return (
    <main className="wrap">
      <header className="masthead">
        <div className="brand"><span className="mark" aria-hidden />Demeu</div>
        <div className="tagline">{text.tagline}</div>
      </header>

      <section className="hero">
        <h1>{text.title}</h1>
        <p className="lead">{text.lead}</p>
        <span className="law">{text.law}</span>
      </section>

      <section className="steps" aria-label="Как это работает">
        {text.steps.map(([number, title, description]) => (
          <div key={number}>
            <div className="n">{number}</div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        ))}
      </section>

      <section className="panel">
        <button
          type="button"
          className="btn"
          onClick={() => void generate()}
          disabled={phase === "generating" || retryBlocked}
        >
          {phase === "generating" ? text.generating : text.generate}
        </button>

        {showCode && (
          <div className="code-field">
            <label className="sr-only" htmlFor="doctor-code">{text.codeLabel}</label>
            <input
              id="doctor-code"
              value={doctorCode}
              onChange={(event) => setDoctorCode(event.target.value)}
              placeholder={text.codePlaceholder}
              autoComplete="off"
            />
          </div>
        )}

        {failure && (
          <div className={failure.kind === "http" && failure.status === 429 ? "alert" : "alert error"} role="alert">
            <span>{doctorFailureText(failure)}</span>
            <button
              type="button"
              className="btn subtle"
              disabled={phase === "generating" || retryBlocked}
              onClick={() => void generate()}
            >
              {text.retry}
            </button>
          </div>
        )}

        {phase === "ready" && token && (
          <div className="link-ready">
            <div className="token-aloud"><div className="label">{text.linkReady}</div></div>
            <div className="linkrow">
              <input ref={linkRef} readOnly value={link} aria-label={text.linkReady} />
              <button type="button" className="btn ghost" onClick={() => void copyLink()}>
                {copyState === "copied" ? text.copied : text.copy}
              </button>
            </div>
            {copyState === "manual" && <p className="alert" role="status">{text.copyManual}</p>}
            <div className="token-aloud">
              <div className="label">{text.readAloud}</div>
              <div className="digits">{spokenToken}</div>
            </div>
            <p className="muted one-link">{text.oneLink}</p>
            <a className="btn subtle open-patient" href={link} target="_blank" rel="noreferrer">
              Открыть как пациент
            </a>
          </div>
        )}
      </section>

      <p className="footnote">{text.openHint}</p>
    </main>
  );
}
