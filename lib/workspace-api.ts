import { isReferralError, type ReferralService } from "./referrals/service";
import type { CreateReferralInput, RecordExaminationInput, ReferralSourceSession, UpdateReferralInput } from "./referrals/types";
import { linkClientKey, linkRateLimiter, type LinkRateLimiter } from "./rate-limit";
import { store, type SessionStore } from "./store";
import type { ReadonlySession } from "./types";
import { assertSameOrigin, requireWorkspaceActor, WorkspaceAuthError, isWorkspaceAuthError, type WorkspaceActor } from "./workspace-auth";
import { workspace } from "./workspace";

type IntakeStore = Pick<SessionStore, "getSession" | "createDoctorToken"> & { listSessions(): Promise<ReadonlySession[]> };
export interface WorkspaceApiDeps {
  actor?: (req: Request) => Promise<WorkspaceActor>;
  referrals?: Pick<ReferralService, "list" | "detail" | "create" | "replayCreate" | "update" | "examination" | "memo" | "aggregates" | "bindLink" | "ownerForToken">;
  sessions?: IntakeStore;
  limiter?: Pick<LinkRateLimiter, "consume">;
}

const BODY_LIMIT = 16_384;
const noStore = { "Cache-Control": "no-store" };
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...noStore, ...headers } });
}
function failure(status: number, code: string): never { throw new WorkspaceAuthError(status, code); }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) failure(400, "BAD_REQUEST");
}

async function body(req: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length")) > BODY_LIMIT) failure(413, "BODY_TOO_LARGE");
  if (req.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") failure(400, "BAD_REQUEST");
  const reader = req.body?.getReader();
  if (!reader) return failure(400, "BAD_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        failure(413, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(result)) return failure(400, "BAD_REQUEST");
    onlyFields(result, fields);
    return result;
  } catch (error) {
    if (isWorkspaceAuthError(error)) throw error;
    return failure(400, "BAD_REQUEST");
  } finally {
    reader.releaseLock();
  }
}

const messages: Record<string, string> = {
  UNAUTHORIZED: "Требуется вход",
  FORBIDDEN: "Нет доступа",
  NOT_FOUND: "Запись не найдена",
  WORKSPACE_UNAVAILABLE: "Рабочее пространство недоступно",
  REASON_REQUIRED: "Укажите причину исправления",
  REVISION_CONFLICT: "Запись изменилась, обновите карточку",
  IDEMPOTENCY_CONFLICT: "Запрос уже использован для другого изменения",
  SOURCE_SESSION_NOT_COMPLETED: "Опрос ещё не завершён",
  DELIVERY_UNCONFIRMED: "Доставка не подтверждена. Проверьте сообщения у врача перед повторной отправкой",
  DELIVERY_RECIPIENT_UNAVAILABLE: "Получатель не настроен или больше не имеет доступа",
  BODY_TOO_LARGE: "Запрос слишком большой",
  METHOD_NOT_ALLOWED: "Метод недоступен",
};
async function boundary(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); }
  catch (error) {
    const known = isWorkspaceAuthError(error) || isReferralError(error);
    const status = known ? error.status : 500;
    const code = known ? error.code : "INTERNAL";
    return json({ code, error: messages[code] ?? (status < 500 ? "Некорректный запрос" : "Внутренняя ошибка") }, status);
  }
}
async function authorized(req: Request, deps: WorkspaceApiDeps): Promise<WorkspaceActor> {
  const actor = await (deps.actor ?? requireWorkspaceActor)(req);
  if (req.method !== "GET") assertSameOrigin(req);
  return actor;
}
function service(deps: WorkspaceApiDeps) { return deps.referrals ?? workspace(); }
function sessions(deps: WorkspaceApiDeps): IntakeStore { return deps.sessions ?? store(); }
function method(req: Request, expected: string): void {
  if (req.method !== expected) failure(405, "METHOD_NOT_ALLOWED");
}
function writer(actor: WorkspaceActor): void {
  if (actor.role === "analyst") failure(403, "FORBIDDEN");
}
function visibleOwner(owner: WorkspaceActor | null, actor: WorkspaceActor): boolean {
  return Boolean(owner && owner.organizationId === actor.organizationId && (actor.role === "owner" || owner.id === actor.id));
}

export function handleReferrals(req: Request, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    writer(actor);
    const referrals = service(deps);
    if (req.method === "GET") return json({ referrals: await referrals.list(actor) });
    method(req, "POST");
    const input = await body(req, ["patientLabel", "profile", "icd10Code", "destinationOrganization", "sourceSessionId", "idempotencyKey"]);
    // A completed create command remains replayable after its source intake TTL.
    const replay = await referrals.replayCreate(actor, input as unknown as CreateReferralInput);
    if (replay) return json({ referral: replay });
    let source: ReferralSourceSession | undefined;
    if (input.sourceSessionId !== undefined && input.sourceSessionId !== null) {
      if (typeof input.sourceSessionId !== "string" || !input.sourceSessionId.trim() || input.sourceSessionId.length > 200) failure(400, "BAD_REQUEST");
      const intake = await sessions(deps).getSession(input.sourceSessionId as string);
      if (!intake || !visibleOwner(await referrals.ownerForToken(intake.doctorToken), actor)) failure(404, "NOT_FOUND");
      if (intake!.status !== "completed" || !intake!.result) failure(409, "SOURCE_SESSION_NOT_COMPLETED");
      source = { sessionId: intake!.id, doctorToken: intake!.doctorToken, result: intake!.result! };
    }
    return json({ referral: await referrals.create(actor, input as unknown as CreateReferralInput, source) });
  });
}

export function handleReferral(req: Request, id: string, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    writer(actor);
    method(req, "GET");
    return json({ referral: await service(deps).detail(actor, id) });
  });
}

export function handleReferralEvents(req: Request, id: string, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    writer(actor);
    method(req, "POST");
    const input = await body(req, ["expectedRevision", "idempotencyKey", "patch", "reason", "occurredAt"]);
    return json({ referral: await service(deps).update(actor, id, input as unknown as UpdateReferralInput) });
  });
}

export function handleReferralExaminations(req: Request, id: string, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    writer(actor);
    method(req, "POST");
    const input = await body(req, ["expectedRevision", "idempotencyKey", "record", "reason", "occurredAt"]);
    if (object(input.record)) onlyFields(input.record, ["id", "requirementId", "label", "resultAvailable", "performedOn", "expiresOn", "applicability"]);
    return json({ referral: await service(deps).examination(actor, id, input as unknown as RecordExaminationInput) });
  });
}

export function handlePatientMemo(req: Request, id: string, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    writer(actor);
    method(req, "GET");
    return json({ memo: await service(deps).memo(actor, id) });
  });
}

export function handleWorkspaceAggregates(req: Request, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    method(req, "GET");
    // No arbitrary analyst filters: small-group suppression is server-owned.
    if (new URL(req.url).search) failure(400, "BAD_REQUEST");
    return json({ aggregates: await service(deps).aggregates(actor) });
  });
}

export function handleWorkspaceIntakes(req: Request, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    writer(actor);
    method(req, "GET");
    const referrals = service(deps);
    const linkedReferrals = new Map(
      (await referrals.list(actor))
        .filter((referral) => referral.sourceSessionId !== null)
        .map((referral) => [referral.sourceSessionId as string, referral.id]),
    );
    const all = await sessions(deps).listSessions();
    const intakes = [];
    for (const intake of all) {
      if (!visibleOwner(await referrals.ownerForToken(intake.doctorToken), actor)) continue;
      intakes.push({
        sessionId: intake.id,
        createdAt: intake.createdAt,
        status: intake.status,
        deliveryStatus: intake.deliveryStatus,
        referralId: linkedReferrals.get(intake.id) ?? null,
        ...(intake.result ? { result: intake.result } : {}),
      });
    }
    intakes.sort((left, right) => right.createdAt - left.createdAt);
    return json({ intakes });
  });
}

export function handleWorkspaceIntake(req: Request, id: string, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    method(req, "GET");
    // Keep every authenticated principal outside the intake scope on the same
    // response contract. In particular, analysts cannot probe session IDs.
    if (actor.role === "analyst") failure(404, "NOT_FOUND");
    const referrals = service(deps);
    const intake = await sessions(deps).getSession(id);
    if (!intake || !visibleOwner(await referrals.ownerForToken(intake.doctorToken), actor)) failure(404, "NOT_FOUND");
    const referral = (await referrals.list(actor)).find((entry) => entry.sourceSessionId === intake.id);
    return json({
      intake: {
        sessionId: intake.id,
        createdAt: intake.createdAt,
        status: intake.status,
        deliveryStatus: intake.deliveryStatus,
        referralId: referral?.id ?? null,
        ...(intake.result ? { result: intake.result } : {}),
      },
    });
  });
}

export function handleWorkspaceLink(req: Request, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await authorized(req, deps);
    writer(actor);
    method(req, "POST");
    const delay = (deps.limiter ?? linkRateLimiter()).consume(linkClientKey(req.headers));
    if (delay) return json({ code: "RATE_LIMITED", error: "Слишком много запросов", retry_after_ms: delay }, 429, {
      "Retry-After": String(Math.ceil(delay / 1_000)),
    });
    const referrals = service(deps);
    const token = await sessions(deps).createDoctorToken();
    // A failed bind leaves an unreturned orphan token; no unowned URL is issued.
    await referrals.bindLink(token, actor);
    return json({ token });
  });
}

export { body as readWorkspaceBody, boundary as workspaceBoundary };
