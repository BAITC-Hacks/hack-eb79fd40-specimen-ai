import type { Session, TriageResult } from "./types";

export interface PatientClosing {
  emergency: boolean;
  text: string;
}

const CLOSING_TEXT: Record<Session["language"], string> = {
  ru: "Спасибо. Ваши ответы переданы врачу. Дальнейшие шаги врач обсудит с вами отдельно.",
  kk: "Рақмет. Жауаптарыңыз дәрігерге жіберілді. Келесі қадамдарды дәрігер сізбен бөлек талқылайды.",
};

/**
 * The terminal response exposed to the patient. Clinical details remain in
 * the authenticated doctor workspace and the configured delivery channel.
 */
export function patientClosing(
  result: TriageResult,
  language: Session["language"],
): PatientClosing {
  return {
    emergency: result.red_flags.some((flag) => flag.emergency),
    text: CLOSING_TEXT[language],
  };
}

export async function patientSafeResumeResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;

  const payload = await response.json() as Record<string, unknown>;
  const result = payload.result;
  delete payload.result;
  if (
    payload.status === "completed" &&
    (payload.language === "ru" || payload.language === "kk") &&
    result && typeof result === "object"
  ) {
    payload.closing = patientClosing(result as TriageResult, payload.language);
  }
  return Response.json(payload, {
    status: response.status,
    headers: { "Cache-Control": "no-store" },
  });
}
