"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useParams } from "next/navigation";
import { MAX_MESSAGE_LEN } from "@/lib/config";
import { decodePatientToken } from "@/lib/doctor-ui";
import {
  finalizeChat,
  resumeChat,
  sendChat,
  startChat,
  type ApiFailure,
  type Language,
} from "@/lib/http";
import { PATIENT } from "@/lib/i18n";
import {
  isSessionCompleted,
  isSessionMissing,
  isStartInvalid,
  patientFailureText,
} from "@/lib/patient-state";
import type { PatientClosing } from "@/lib/patient-response";
import DoctorPanel, { SYNTHETIC_DEMO_RESULT } from "./DoctorPanel";
import Preparation, { preparationRequest } from "../../p/Preparation";
import {
  ConsentGate,
  InputWidgetChoices,
  LoadingState,
  PatientFinale,
  PatientMasthead,
  TerminalState,
} from "./patient-components";

type Phase =
  | "consent"
  | "restoring"
  | "restore_error"
  | "starting"
  | "invalid"
  | "start_error"
  | "chat"
  | "expired"
  | "replaying"
  | "replay_failed"
  | "finalizing"
  | "done"
  | "preparation";

interface UiMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  state?: "sending" | "failed";
  failure?: ApiFailure;
}

export default function PatientChat() {
  const params = useParams<{ token: string }>();
  const token = decodePatientToken(() => {
    const token = decodeURIComponent(params.token);
    return token;
  });
  const [language, setLanguage] = useState<Language>("ru");
  const [demo, setDemo] = useState(false);
  const [preparationId, setPreparationId] = useState<string | null>(null);
  const [preparationPending, setPreparationPending] = useState(false);
  const [queryReady, setQueryReady] = useState(false);
  const [phase, setPhase] = useState<Phase>(token === null ? "invalid" : "consent");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turnsLeft, setTurnsLeft] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [finalizeFailure, setFinalizeFailure] = useState<ApiFailure | null>(null);
  const [startFailure, setStartFailure] = useState<ApiFailure | null>(null);
  const [closing, setClosing] = useState<PatientClosing | null>(null);
  const [autoFinalized, setAutoFinalized] = useState(false);
  const [waitLine, setWaitLine] = useState(0);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const nextMessageId = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const startAttempt = useRef(0);
  const startInFlight = useRef(false);
  const turnInFlight = useRef(false);
  const text = PATIENT[language];

  useEffect(() => {
    let disposed = false;
    const query = new URLSearchParams(window.location.search);
    setLanguage(query.get("lang") === "kk" ? "kk" : "ru");
    const localDemo = document.querySelector(
      '[data-demeu-local-demo="synthetic"]',
    ) !== null;
    setDemo(localDemo && query.get("demo") === "1");
    const key = token === null ? null : `demeu:session:${token}`;
    const preparationKey = token === null ? null : `demeu:preparation:${token}`;
    let saved: string | null = null;
    let savedPreparation: string | null = null;
    try {
      if (key) saved = window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key);
      if (preparationKey) savedPreparation = window.localStorage.getItem(preparationKey);
    } catch { /* Storage can be disabled. */ }
    if (token === null) { setPhase("invalid"); setQueryReady(true); return; }
    setPhase("restoring"); setQueryReady(false);
    void (async () => {
      if (!savedPreparation) {
        try {
          const discovered = await preparationRequest("/api/patient/discover", { token });
          if (disposed) return;
          savedPreparation = discovered.accessId; setPreparationId(discovered.accessId);
          try { if (preparationKey) window.localStorage.setItem(preparationKey, discovered.accessId); } catch { /* Cookie discovery works without browser storage. */ }
          if (discovered.state !== "awaiting_referral" || !saved) { setQueryReady(true); setPhase("preparation"); return; }
        } catch { /* A fresh link has no preparation cookie yet. */ }
      }
      if (!saved && !savedPreparation) { if (!disposed) { setQueryReady(true); setPhase("consent"); } return; }
      if (savedPreparation) {
        setPreparationId(savedPreparation);
        try {
          const prepared = await preparationRequest(`/api/patient/${encodeURIComponent(savedPreparation)}/package`);
          if (disposed) return;
          if (prepared.state !== "awaiting_referral" || !saved) { setQueryReady(true); setPhase("preparation"); return; }
        } catch { /* Chat capability may still allow recovery or a doctor can reissue. */ }
      }
      if (!saved) { if (!disposed) { setQueryReady(true); setPhase("preparation"); } return; }
      if (!savedPreparation) {
        try {
          const grantResponse = await fetch("/api/chat/preparation", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: saved }), signal: AbortSignal.timeout(10000), referrerPolicy: "no-referrer" });
          const grant = grantResponse.ok ? await grantResponse.json() : null;
          if (!disposed && typeof grant?.preparationId === "string") {
            savedPreparation = grant.preparationId; setPreparationId(grant.preparationId);
            try { if (preparationKey) window.localStorage.setItem(preparationKey, grant.preparationId); } catch { /* Cookie still protects this browser. */ }
          }
        } catch { /* Continue the existing questionnaire independently. */ }
      }
      const response = await resumeChat(saved, token);
      if (disposed) return;
      setQueryReady(true);
      if (!response.ok) {
        if (response.failure.kind === "http" && [401, 404].includes(response.failure.status)) {
          if (savedPreparation) { setPhase("preparation"); return; }
          setSessionId(null); setPhase("expired");
        } else { setStartFailure(response.failure); setPhase("restore_error"); }
        return;
      }
      const restored = response.data;
      setSessionId(restored.sessionId); setLanguage(restored.language);
      setMessages(restored.messages.map((message) => ({ ...message, id: nextMessageId.current++ })));
      setTurnsLeft(restored.turnsLeft); setClosing(restored.closing ?? null);
      setPhase(restored.status === "aborted" ? "expired" : restored.status === "completed" ? "done" : "chat");
    })();
    return () => { disposed = true; };
  }, [token, restoreAttempt]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, phase, confirming]);

  useEffect(() => {
    if (phase !== "finalizing") return;
    setWaitLine(0);
    const interval = window.setInterval(
      () => setWaitLine((current) => (current + 1) % text.finalizing.length),
      6_000,
    );
    return () => window.clearInterval(interval);
  }, [phase, text.finalizing.length]);

  function respectRetryDelay(failure: ApiFailure) {
    const delay = failure.kind === "http" ? failure.retryAfterMs : undefined;
    if (!delay || delay <= 0) {
      setRetryBlocked(false);
      return;
    }
    setRetryBlocked(true);
    window.setTimeout(() => setRetryBlocked(false), delay);
  }

  async function openSession() {
    if (startInFlight.current) return;
    if (token === null) {
      setPhase("invalid");
      return;
    }
    startInFlight.current = true;
    const attempt = ++startAttempt.current;
    setPhase("starting");
    setStartFailure(null);
    setFinalizeFailure(null);
    setSessionId(null);
    setMessages([]);
    setTurnsLeft(null);
    setClosing(null);
    setConfirming(false);
    setAutoFinalized(false);

    try {
      const response = await startChat(token, language);
      if (attempt !== startAttempt.current) return;
      if (!response.ok) {
        setStartFailure(response.failure);
        respectRetryDelay(response.failure);
        setPhase(isStartInvalid(response.failure) ? "invalid" : "start_error");
        return;
      }

      setSessionId(response.data.sessionId);
      try { window.sessionStorage.setItem(`demeu:session:${token}`, response.data.sessionId); if (response.data.preparationId || response.data.preparationPending) window.localStorage.setItem(`demeu:session:${token}`, response.data.sessionId); } catch { /* Resume is optional when browser storage is disabled. */ }
      if (response.data.preparationId) {
        setPreparationId(response.data.preparationId);
        try { window.localStorage.setItem(`demeu:preparation:${token}`, response.data.preparationId); } catch { /* Optional storage. */ }
      }
      setPreparationPending(!response.data.preparationId);
      setTurnsLeft(response.data.turnsLeft);
      setMessages([
        {
          id: nextMessageId.current++,
          role: "assistant",
          content: response.data.reply,
        },
      ]);
      setPhase("chat");
    } finally {
      if (attempt === startAttempt.current) startInFlight.current = false;
    }
  }

  function finish(nextResult: PatientClosing, nextTurnsLeft?: number) {
    setClosing(nextResult);
    if (nextTurnsLeft !== undefined) setTurnsLeft(nextTurnsLeft);
    setConfirming(false);
    setFinalizeFailure(null);
    setPhase("done");
  }

  async function replayResult() {
    if (!sessionId) return;
    setPhase("replaying");
    setFinalizeFailure(null);
    const response = await finalizeChat(sessionId);
    if (!response.ok) {
      if (isSessionMissing(response.failure)) {
        setPhase("expired");
        return;
      }
      setFinalizeFailure(response.failure);
      respectRetryDelay(response.failure);
      setPhase("replay_failed");
      return;
    }
    finish(response.data.closing);
  }

  async function sendTurn(content: string, existingId?: number) {
    const message = content.trim();
    if (!message || !sessionId || phase !== "chat" || retryBlocked || turnInFlight.current) return;
    turnInFlight.current = true;

    const messageId = existingId ?? nextMessageId.current++;
    setMessages((current) => {
      if (existingId !== undefined) {
        return current.map((item) =>
          item.id === existingId
            ? { ...item, state: "sending", failure: undefined }
            : item,
        );
      }
      return [...current, { id: messageId, role: "user", content: message, state: "sending" }];
    });

    const response = await sendChat(sessionId, message);
    turnInFlight.current = false;
    if (!response.ok) {
      if (isSessionCompleted(response.failure)) {
        setMessages((current) =>
          current.map((item) =>
            item.id === messageId ? { ...item, state: undefined } : item,
          ),
        );
        await replayResult();
        return;
      }
      if (isSessionMissing(response.failure)) {
        setPhase("expired");
        return;
      }
      respectRetryDelay(response.failure);
      setMessages((current) =>
        current.map((item) =>
          item.id === messageId
            ? { ...item, state: "failed", failure: response.failure }
            : item,
        ),
      );
      return;
    }

    setMessages((current) => {
      const delivered = current.map((item) =>
        item.id === messageId ? { ...item, state: undefined, failure: undefined } : item,
      );
      return response.data.reply
        ? [
            ...delivered,
            {
              id: nextMessageId.current++,
              role: "assistant" as const,
              content: response.data.reply,
            },
          ]
        : delivered;
    });
    setInput("");
    if (textAreaRef.current) textAreaRef.current.style.height = "auto";
    setTurnsLeft(response.data.turnsLeft);
    if (response.data.done && response.data.closing) {
      setAutoFinalized(response.data.turnsLeft === 0);
      finish(response.data.closing, response.data.turnsLeft);
    }
  }

  async function finalize() {
    if (!sessionId || phase !== "chat") return;
    setConfirming(false);
    setFinalizeFailure(null);
    setPhase("finalizing");
    const response = await finalizeChat(sessionId);
    if (!response.ok) {
      if (isSessionMissing(response.failure)) {
        setPhase("expired");
        return;
      }
      setFinalizeFailure(response.failure);
      respectRetryDelay(response.failure);
      setPhase("chat");
      return;
    }
    finish(response.data.closing);
  }

  function submitInput() {
    const message = input.trim();
    if (!message) return;
    void sendTurn(message);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitInput();
    }
  }

  function autoGrow(event: ChangeEvent<HTMLTextAreaElement>) {
    setInput(event.target.value);
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 132)}px`;
  }

  const sending = messages.some((message) => message.state === "sending");
  const userTurns = messages.filter(
    (message) => message.role === "user" && message.state !== "failed",
  ).length;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const charsLeft = MAX_MESSAGE_LEN - input.length;
  const emergency = closing?.emergency ?? false;
  const showConversation = [
    "chat",
    "replaying",
    "replay_failed",
    "finalizing",
    "done",
  ].includes(phase);

  return (
    <main className="wrap chat-shell">
      <PatientMasthead
        language={language}
        canChangeLanguage={phase === "consent"}
        onLanguage={setLanguage}
      />

      {phase === "preparation" && preparationId && <Preparation key={preparationId} accessId={preparationId} language={language} />}
      {phase === "consent" && <ConsentGate ready={queryReady} language={language} onConsent={() => void openSession()} />}
      {(phase === "starting" || phase === "restoring") && <LoadingState language={language} />}
      {phase === "restore_error" && (
        <TerminalState
          title={text.startErrorTitle}
          body={startFailure ? patientFailureText(startFailure, language) : text.startErrorBody}
          action={text.retry}
          onAction={() => setRestoreAttempt((value) => value + 1)}
        />
      )}
      {phase === "invalid" && (
        <TerminalState title={text.invalidTitle} body={text.invalidBody} />
      )}
      {phase === "start_error" && (
        <TerminalState
          title={text.startErrorTitle}
          body={startFailure ? patientFailureText(startFailure, language) : text.startErrorBody}
          action={text.retry}
          actionDisabled={retryBlocked}
          onAction={() => void openSession()}
        />
      )}
      {phase === "expired" && (
        <TerminalState
          title={text.expiredTitle}
          body={text.expiredBody}
          action={text.restart}
          onAction={() => void openSession()}
        />
      )}

      {showConversation && (
        <div className="chat-scroll">
          <div className="chat" role="log" aria-live="polite" aria-relevant="additions text">
            {messages.map((message) => (
              <Fragment key={message.id}>
                <div
                  className={
                    message.role === "assistant"
                      ? "msg-bot"
                      : `msg-user ${message.state === "failed" ? "failed" : ""}`
                  }
                >
                  {message.content}
                </div>
                {message.state === "failed" && message.failure && (
                  <div className="failbar" role="alert">
                    <span>{patientFailureText(message.failure, language)}</span>
                    <button
                      type="button"
                      className="btn subtle"
                      disabled={retryBlocked || sending}
                      onClick={() => void sendTurn(message.content, message.id)}
                    >
                      {text.resend}
                    </button>
                  </div>
                )}
              </Fragment>
            ))}

            {sending && (
              <div className="typing" role="status" aria-label={text.typing}>
                <span className="dots" aria-hidden><i /><i /><i /></span>
                {text.typing}
              </div>
            )}

            {phase === "chat" && !sending && turnsLeft !== null && turnsLeft <= 3 && (
              <div className="sysnote">{text.almostDone}</div>
            )}

            {phase === "chat" && lastAssistant && !sending && !confirming && (
              <InputWidgetChoices
                reply={lastAssistant.content}
                language={language}
                disabled={retryBlocked}
                onChoose={(answer) => void sendTurn(answer)}
              />
            )}

            {finalizeFailure && phase === "chat" && (
              <div className="failbar" role="alert">
                <span>{patientFailureText(finalizeFailure, language)}</span>
                <button
                  type="button"
                  className="btn subtle"
                  disabled={retryBlocked}
                  onClick={() => void finalize()}
                >
                  {text.retry}
                </button>
              </div>
            )}

            {confirming && phase === "chat" && (
              <div className="confirm-inline">
                <p>{text.confirmFinish}</p>
                <div className="row">
                  <button type="button" className="btn" onClick={() => void finalize()}>
                    {text.confirmYes}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
                    {text.confirmNo}
                  </button>
                </div>
              </div>
            )}

            {(phase === "replaying" || phase === "finalizing") && (
              <div className="longwait" role="status">
                <div className="line">{text.finalizing[waitLine]}</div>
                <div className="track" aria-hidden><i /></div>
              </div>
            )}

            {phase === "replay_failed" && finalizeFailure && (
              <div className="confirm-inline" role="alert">
                <p>{text.replayFailed}</p>
                <button
                  type="button"
                  className="btn"
                  disabled={retryBlocked}
                  onClick={() => void replayResult()}
                >
                  {text.retry}
                </button>
              </div>
            )}

            {phase === "done" && autoFinalized && (
              <div className="sysnote">{text.autoFinalized}</div>
            )}
            {phase === "done" && closing && (
              <PatientFinale language={language} emergency={emergency} />
            )}
            {phase === "done" && preparationId && <Preparation key={preparationId} accessId={preparationId} language={language} />}
            {phase === "done" && preparationPending && !preparationId && <div className="confirm-inline"><p>{language === "kk" ? "Дайындық тізімі уақытша қолжетімсіз. Қайта ашып көріңіз." : "Список подготовки временно недоступен. Попробуйте открыть ещё раз."}</p><button type="button" className="btn subtle" onClick={() => setRestoreAttempt((value) => value + 1)}>{text.retry}</button></div>}
            {phase === "done" && demo && closing && (
              <DoctorPanel result={SYNTHETIC_DEMO_RESULT} />
            )}
            <div ref={endRef} />
          </div>
        </div>
      )}

      {phase === "chat" && (
        <div className="composer">
          <div className="composer-inner">
            <textarea
              ref={textAreaRef}
              rows={1}
              value={input}
              maxLength={MAX_MESSAGE_LEN}
              placeholder={text.inputPlaceholder}
              aria-label={text.inputPlaceholder}
              onChange={autoGrow}
              onKeyDown={onKeyDown}
              disabled={sending || retryBlocked}
            />
            <button
              type="button"
              className="send"
              aria-label={text.send}
              disabled={sending || retryBlocked || !input.trim()}
              onClick={submitInput}
            >
              <span aria-hidden>→</span>
            </button>
          </div>
          <div className="composer-meta">
            <span>
              {userTurns >= 2 && !confirming && !sending && (
                <button
                  type="button"
                  className={turnsLeft !== null && turnsLeft <= 4 ? "btn ghost" : "btn subtle"}
                  onClick={() => setConfirming(true)}
                >
                  {text.finishBtn}
                </button>
              )}
            </span>
            <span className={charsLeft <= 200 ? "warn" : ""}>
              {charsLeft <= 200 ? text.charLimit(charsLeft) : ""}
            </span>
          </div>
        </div>
      )}
      {phase === "chat" && <p className="footnote">{text.privacyNote}</p>}
    </main>
  );
}
