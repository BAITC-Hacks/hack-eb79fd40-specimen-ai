import type { Session, TriageResult } from "./types";

// Доставка сводки врачу. Интеграцию врача в Hermes/Telegram ведёт Ардан —
// здесь чётко обозначенная точка стыка. Если HERMES_WEBHOOK_URL задан,
// POST-им сводку туда; иначе просто логируем (для демо).
export async function notifyDoctor(session: Session, result: TriageResult): Promise<void> {
  const payload = {
    sessionId: session.id,
    doctorToken: session.doctorToken,
    urgency: result.urgency,
    urgency_reasons: result.urgency_reasons,
    red_flags: result.red_flags,
    routing: result.routing,
    hypothesis: result.hypothesis,
    anamnesis: result.anamnesis,
  };

  const url = process.env.HERMES_WEBHOOK_URL;
  if (!url) {
    console.log("[hermes] webhook не задан; сводка:\n", JSON.stringify(payload, null, 2));
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[hermes] доставка не удалась:", e);
  }
}
