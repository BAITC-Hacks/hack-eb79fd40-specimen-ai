"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { ChatMessage, TriageResult } from "@/lib/types";

const URGENCY_LABEL: Record<string, string> = {
  routine: "Рутинно",
  planned: "Планово",
  urgent: "Срочно",
  emergency: "Неотложно",
};

export default function PatientChat() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TriageResult | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      setBusy(true);
      const res = await fetch("/api/chat/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      setSessionId(data.sessionId);
      setMessages([{ role: "assistant", content: data.reply }]);
      setBusy(false);
    })();
  }, [token]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, result]);

  async function send() {
    const text = input.trim();
    if (!text || busy || !sessionId || result) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setBusy(true);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: text }),
    });
    const data = await res.json();
    setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
    if (data.done && data.result) setResult(data.result);
    setBusy(false);
  }

  return (
    <div className="wrap">
      <div className="brand">
        Demeu <small>подготовка к приёму</small>
      </div>

      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="msg assistant">…</div>}
      </div>

      {!result && (
        <div className="composer">
          <input
            value={input}
            placeholder="Ваш ответ…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            disabled={busy || !sessionId}
          />
          <button onClick={send} disabled={busy || !sessionId}>
            Отправить
          </button>
        </div>
      )}

      {result && <Summary result={result} />}
      <div ref={endRef} />
    </div>
  );
}

// Демо-панель «что видит врач». В проде уходит в Telegram врача.
function Summary({ result }: { result: TriageResult }) {
  const a = result.anamnesis;
  return (
    <div className="card">
      <h2>
        Сводка для врача{" "}
        <span className={`badge ${result.urgency}`}>
          {URGENCY_LABEL[result.urgency] ?? result.urgency}
        </span>
      </h2>

      {result.red_flags.length > 0 && (
        <>
          <h3>Красные флаги</h3>
          {result.red_flags.map((f, i) => (
            <div key={i} className={`flag ${f.emergency ? "" : "soft"}`}>
              <b>{f.label}</b> — {f.evidence}
            </div>
          ))}
        </>
      )}

      <h3>Почему такой приоритет</h3>
      <ul style={{ paddingLeft: 18, fontSize: 14 }}>
        {result.urgency_reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>

      <h3>Маршрутизация</h3>
      <div style={{ fontSize: 14 }}>
        {result.routing.map((r, i) => (
          <span key={i} className="badge routine" style={{ marginRight: 6 }}>
            {r.specialty} · {Math.round(r.confidence * 100)}%
          </span>
        ))}
      </div>

      <h3>Предварительная гипотеза</h3>
      <div className="kv">
        {result.hypothesis.text} · уверенность {Math.round(result.hypothesis.confidence * 100)}%
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        {result.hypothesis.disclaimer}
      </p>

      <h3>Анамнез</h3>
      <div className="kv"><b>Жалоба:</b> {a.chief_complaint}</div>
      <div className="kv"><b>Симптом:</b> начало {a.symptom.onset || "—"}, характер {a.symptom.quality || "—"}, сила {a.symptom.severity}/10</div>
      <div className="kv"><b>Хроника:</b> {a.chronic.join(", ") || "—"}</div>
      <div className="kv"><b>Аллергии:</b> {a.allergies.join(", ") || "—"}</div>
      <div className="kv"><b>Препараты:</b> {a.medications.join(", ") || "—"}</div>
      <div className="kv"><b>Контекст:</b> возраст {a.context.age ?? "—"}, пол {a.context.sex}</div>
    </div>
  );
}
