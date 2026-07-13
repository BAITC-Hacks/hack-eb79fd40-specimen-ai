"use client";

import { useState } from "react";

// Сторона врача: генерация персональной ссылки для пациента.
export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setLoading(true);
    const res = await fetch("/api/link", { method: "POST" });
    const data = await res.json();
    setToken(data.token);
    setLoading(false);
  }

  const link = token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/c/${token}`
    : "";

  return (
    <div className="wrap">
      <div className="brand">
        Demeu <small>первичный триаж для госполиклиник</small>
      </div>

      <div className="card">
        <h2>Кабинет врача</h2>
        <p className="muted">
          Сгенерируйте ссылку и отправьте пациенту. Он пройдёт опрос, а вам придёт
          структурированная сводка: анамнез, приоритет срочности, красные флаги,
          маршрутизация и предварительная гипотеза. Финальное решение — за вами.
        </p>
        <div style={{ marginTop: 14 }}>
          <button onClick={generate} disabled={loading}>
            {loading ? "Генерирую…" : "Сгенерировать ссылку"}
          </button>
        </div>
        {token && (
          <div className="linkbox">
            <code>{link}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? "Скопировано" : "Копировать"}
            </button>
          </div>
        )}
      </div>

      <p className="muted" style={{ marginTop: 16 }}>
        В проде уведомление врачу приходит в Telegram (Hermes-агент). Здесь ссылку
        можно открыть в новой вкладке, чтобы пройти путь пациента.
      </p>
    </div>
  );
}
