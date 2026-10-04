import { createHmac } from "node:crypto";
import { isReferralError, type ReferralService } from "./referrals/service";
import type { PatientPackage, PatientReportInput, ReferralActor } from "./referrals/types";
import { PREPARATION_TTL_MS, validPreparationToken, preparationCookieName } from "./referrals/patient";
export { preparationCookieName } from "./referrals/patient";
import { readSessionBody, RequestBodyError } from "./request-body";
import { workspace } from "./workspace";
import { assertSameOrigin, isWorkspaceAuthError, requireWorkspaceActor, WorkspaceAuthError } from "./workspace-auth";
import { renderPatientTextPdf } from "./patient-memo";

type PreparationService = Pick<ReferralService, "preparation" | "discoverPreparation" | "reportPreparation" | "managePreparation" | "preparationStatus" | "confirmPatientReport" | "issuePreparation" | "ownerForToken">;
export interface PreparationDeps { service?: PreparationService; actor?: (req: Request) => Promise<ReferralActor> }
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Vary": "Cookie" };
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
const service = (deps: PreparationDeps) => deps.service ?? workspace();
export function preparationCookie(id: string, token: string, expiresAt: number, now = Date.now()) {
  if (!validPreparationToken(token)) throw new Error("Invalid preparation capability");
  const seconds = Math.max(0, Math.min(Math.floor((expiresAt - now) / 1000), PREPARATION_TTL_MS / 1000));
  return `${preparationCookieName(id)}=${token}; Path=/api/patient; HttpOnly; SameSite=Strict; Max-Age=${seconds}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
function cookie(req: Request, id: string): string {
  const prefix = `${preparationCookieName(id)}=`;
  const values = (req.headers.get("cookie") ?? "").split(";").map((entry) => entry.trim()).filter((entry) => entry.startsWith(prefix));
  const token = values.length === 1 ? values[0].slice(prefix.length) : "";
  if (!validPreparationToken(token)) throw new WorkspaceAuthError(401, "UNAUTHORIZED");
  return token;
}
async function boundary(run: () => Promise<Response>) {
  try { return await run(); }
  catch (error) {
    const known = isReferralError(error) || isWorkspaceAuthError(error);
    const bodyError = error instanceof RequestBodyError;
    return json({ code: known ? error.code : bodyError ? error.status === 413 ? "BODY_TOO_LARGE" : "BAD_REQUEST" : "INTERNAL",
      error: known && error.status < 500 ? error.message : "Запрос временно недоступен" }, known ? error.status : bodyError ? error.status : 503, known && error.status === 429 ? { "Retry-After": "60" } : {});
  }
}
function only(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new WorkspaceAuthError(400, "BAD_REQUEST");
}
function hasQuery(req: Request) {
  return [...new URL(req.url).searchParams].length > 0;
}
function rejectQuery(req: Request) {
  if (hasQuery(req)) throw new WorkspaceAuthError(400, "BAD_REQUEST");
}
function packageQuery(req: Request): { format: "json" | "pdf"; lang: "ru" | "kk" } {
  const query = new URL(req.url).searchParams;
  if ([...query.keys()].some((key) => key !== "format" && key !== "lang")
    || query.getAll("format").length > 1 || query.getAll("lang").length > 1) {
    throw new WorkspaceAuthError(400, "BAD_REQUEST");
  }
  if ([...query].length === 0) return { format: "json", lang: "ru" };
  if (query.get("format") !== "pdf") throw new WorkspaceAuthError(400, "BAD_REQUEST");
  const lang = query.get("lang") ?? "ru";
  if (lang !== "ru" && lang !== "kk") throw new WorkspaceAuthError(400, "BAD_REQUEST");
  return { format: "pdf", lang };
}
export async function attachStartedPreparation(response: Response, doctorToken: string, deps: PreparationDeps = {}): Promise<Response> {
  if (!response.ok) return response;
  try {
    const started = await response.clone().json();
    const owner = await service(deps).ownerForToken(doctorToken);
    if (!owner) throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
    const secret = process.env.DEMEU_AUTH_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
    const retryToken = createHmac("sha256", secret).update("demeu:initial-preparation:v1\0").update(started.sessionId).digest("base64url");
    const grant = await service(deps).issuePreparation(started.sessionId, owner, doctorToken, retryToken);
    const next = json({ ...started, preparationId: grant.accessId, preparationUrl: `/p/${grant.token}` });
    for (const value of response.headers.getSetCookie()) next.headers.append("Set-Cookie", value);
    next.headers.append("Set-Cookie", preparationCookie(grant.accessId, grant.token, grant.expiresAt));
    return next;
  } catch {
    // Chat/session consumption succeeded independently. Keep the cookie and
    // session response; a protected retry can persist the grant without a
    // second questionnaire or plaintext capability storage.
    const started = await response.clone().json();
    const next = json({ ...started, preparationPending: true });
    for (const value of response.headers.getSetCookie()) next.headers.append("Set-Cookie", value);
    return next;
  }
}
export function handlePreparationAccess(req: Request, deps: PreparationDeps = {}) {
  return boundary(async () => {
    assertSameOrigin(req);
    const input = await readSessionBody(req);
    only(input, ["token"]);
    if (!validPreparationToken(input.token)) throw new WorkspaceAuthError(401, "UNAUTHORIZED");
    const result = await service(deps).preparation(input.token);
    rejectQuery(req);
    return json({ package: result }, 200, { "Set-Cookie": preparationCookie(result.accessId, input.token, result.expiresAt) });
  });
}
export function handleDiscoverPreparation(req: Request, deps: PreparationDeps = {}) {
  return boundary(async () => {
    assertSameOrigin(req);
    const input = await readSessionBody(req);
    only(input, ["token"]);
    if (typeof input.token !== "string") throw new WorkspaceAuthError(400, "BAD_REQUEST");
    const result = await service(deps).discoverPreparation(input.token, req.headers.get("cookie") ?? "");
    rejectQuery(req);
    return json({ package: result });
  });
}
export function handlePreparation(req: Request, id: string, deps: PreparationDeps = {}) {
  return boundary(async () => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) throw new WorkspaceAuthError(401, "UNAUTHORIZED");
    const token = cookie(req, id);
    if (req.method === "POST") {
      assertSameOrigin(req);
      if (hasQuery(req)) await service(deps).preparation(token, id);
      rejectQuery(req);
      const input = await readSessionBody(req);
      only(input, ["requirementId", "performedOn", "resultAvailable", "expectedRevision", "idempotencyKey"]);
      return json({ package: await service(deps).reportPreparation(token, id, input as unknown as PatientReportInput) });
    }
    if (req.method !== "GET") throw new WorkspaceAuthError(405, "METHOD_NOT_ALLOWED");
    if (req.headers.get("sec-fetch-site") === "cross-site") throw new WorkspaceAuthError(403, "FORBIDDEN");
    const result = await service(deps).preparation(token, id);
    const query = packageQuery(req);
    if (query.format === "json") return json({ package: result });
    const pdf = await renderPatientTextPdf(renderPreparationText(result, query.lang));
    return new Response(Uint8Array.from(pdf).buffer, { headers: { ...headers, "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="demeu-preparation.pdf"' } });
  });
}
export function handleManagePreparation(req: Request, id: string, deps: PreparationDeps = {}) {
  return boundary(async () => {
    const actor = await (deps.actor ?? requireWorkspaceActor)(req);
    if (req.method === "GET") return json(await service(deps).preparationStatus(actor, id));
    assertSameOrigin(req);
    if (hasQuery(req)) {
      if (actor.role === "analyst") throw new WorkspaceAuthError(403, "FORBIDDEN");
      await service(deps).preparationStatus(actor, id);
    }
    rejectQuery(req);
    const input = await readSessionBody(req);
    only(input, ["action", "expectedAccessRevision", "idempotencyKey"]);
    if (input.action !== "reissue" && input.action !== "revoke") throw new WorkspaceAuthError(400, "BAD_REQUEST");
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) throw new WorkspaceAuthError(400, "BAD_REQUEST");
    const secret = process.env.DEMEU_AUTH_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
    const retryToken = createHmac("sha256", secret).update("demeu:reissue-preparation:v1\0").update(JSON.stringify([actor.id, actor.organizationId, id, input.idempotencyKey])).digest("base64url");
    const grant = await service(deps).managePreparation(actor, id, input.action, { expectedAccessRevision: input.expectedAccessRevision as number, idempotencyKey: input.idempotencyKey }, retryToken);
    return json({ preparationUrl: grant ? `/p/${grant.token}` : null, expiresAt: grant?.expiresAt ?? null });
  });
}
export function handleConfirmPreparation(req: Request, id: string, deps: PreparationDeps = {}) {
  return boundary(async () => {
    assertSameOrigin(req);
    const actor = await (deps.actor ?? requireWorkspaceActor)(req);
    if (hasQuery(req)) {
      if (actor.role !== "doctor") throw new WorkspaceAuthError(403, "FORBIDDEN");
      await service(deps).preparationStatus(actor, id);
    }
    rejectQuery(req);
    const input = await readSessionBody(req);
    only(input, ["reportId", "expectedRevision", "expectedReportRevision", "idempotencyKey"]);
    const confirmed = await service(deps).confirmPatientReport(actor, id, input as Parameters<ReferralService["confirmPatientReport"]>[2]);
    return json({ referral: confirmed });
  });
}
export function renderPreparationText(value: PatientPackage, lang: "ru" | "kk" = "ru") {
  const kk = lang === "kk";
  const status = kk ? { present: "нәтиже бар", missing: "нәтиже жоқ", expired: "мерзімі өткен", unknown: "дәрігерден нақтылау", not_applicable: "дәрігер шешімі бойынша қажет емес" }
    : { present: "результат есть", missing: "результата нет", expired: "срок истёк", unknown: "уточнить у врача", not_applicable: "не требуется по решению врача" };
  return [kk ? "Demeu · Тексерулерге дайындық" : "Demeu · Подготовка обследований", value.patientLabel ?? "",
    value.destinationOrganization ?? (kk ? "Ұйымды дәрігерден нақтылаңыз" : "Организацию уточните у врача"),
    `${kk ? "Госпитализация күні" : "Дата госпитализации"}: ${value.scheduledDate ?? (kk ? "белгіленбеген" : "не назначена")}`,
    !value.catalogueValidated ? kk ? "Тізімді аурухана дәрігері әлі тексерген жоқ. Дайындық расталмаған." : "Перечень ещё не проверен врачом больницы. Готовность не подтверждена." : "",
    `${kk ? "Тізім нұсқасы" : "Версия перечня"}: ${value.catalogueVersion ?? "—"}`,
    ...value.items.map((item, index) => `${index + 1}. ${item.label} — ${status[item.preparationStatus]}; ${kk ? "жарамды" : "действует до"}: ${item.expiresOn ?? "—"}${item.selfReport ? `; ${item.selfReport.confirmed ? kk ? "дәрігер растаған" : "подтверждено врачом" : kk ? "пациент белгісі, дәрігер тексеруі керек" : "со слов пациента, требует проверки врача"}; ${item.selfReport.performedOn}` : ""}${item.conditional ? `; ${kk ? "көрсетілім бойынша" : "по показаниям"}` : ""}`),
    kk ? "Белгілер медициналық нәтижелерді тексеруді алмастырмайды. Соңғы тізім мен дайындықты дәрігер растайды." : "Отметки не заменяют проверку медицинских результатов. Окончательный состав и готовность подтверждает врач.",
  ].filter(Boolean).join("\n");
}
