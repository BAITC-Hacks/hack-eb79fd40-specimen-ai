"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { PatientPackage } from "@/lib/referrals/types";
import Preparation, { preparationRequest } from "../Preparation";

export default function PreparationLink() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PatientPackage | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setFailed(false);
    const byId = /^[a-f0-9-]{36}$/u.test(token);
    void preparationRequest(byId ? `/api/patient/${encodeURIComponent(token)}/package` : "/api/patient/access", byId ? undefined : { token })
      .then((next) => {
        if (disposed) return;
        // The bearer token is removed from address/history after cookie exchange.
        window.history.replaceState(null, "", `/p/${next.accessId}`);
        setData(next);
      }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [token, attempt]);
  return <main className="wrap">{data ? <Preparation key={data.accessId} accessId={data.accessId} initialPackage={data} /> : <section className="card" role={failed ? "alert" : "status"}>
    <h1>Demeu · Подготовка / Дайындық</h1><p>{failed ? "Ссылка недоступна. Уточните у врача новую ссылку. / Сілтеме қолжетімсіз. Дәрігерден жаңа сілтеме сұраңыз." : "Открываем список… / Тізім ашылуда…"}</p>
    {failed && <button className="btn" onClick={() => setAttempt((value) => value + 1)}>Повторить / Қайталау</button>}
  </section>}</main>;
}
