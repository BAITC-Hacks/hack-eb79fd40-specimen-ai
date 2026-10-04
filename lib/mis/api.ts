import { authorizeMis, type MisAuthOptions } from "./auth";
import { isMisError, MisError } from "./errors";
import type { MisService } from "./service";
import { MIS_ACK_SCOPE, MIS_PULL_SCOPE } from "./types";
import { misWorkspace } from "../workspace";

const BODY_LIMIT = 16_384;
const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...responseHeaders, ...headers } });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length")) > BODY_LIMIT) throw new MisError(413, "BODY_TOO_LARGE");
  if (req.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new MisError(400, "BAD_REQUEST");
  const reader = req.body?.getReader();
  if (!reader) throw new MisError(400, "BAD_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new MisError(413, "BODY_TOO_LARGE"); }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MisError(400, "BAD_REQUEST");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isMisError(error)) throw error;
    throw new MisError(400, "BAD_REQUEST");
  } finally { reader.releaseLock(); }
}

export interface MisRateLimiter {
  consume(key: string, now: number): boolean;
}
class ProcessMisRateLimiter implements MisRateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();
  consume(key: string, now: number): boolean {
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= 60) return false;
    current.count += 1;
    return true;
  }
}
const limiter = new ProcessMisRateLimiter();

export interface MisApiDeps {
  auth?: MisAuthOptions;
  service?: MisService;
  limiter?: MisRateLimiter;
  now?: () => number;
}

async function boundary(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); }
  catch (error) {
    const known = isMisError(error);
    const status = known ? error.status : 503;
    const code = known ? error.code : "MIS_UNAVAILABLE";
    return json({ code, error: status < 500 ? "Запрос интеграции отклонён" : "Контур интеграции недоступен" }, status,
      status === 401 ? { "WWW-Authenticate": 'Bearer realm="demeu-mis"' } : {});
  }
}

function service(deps: MisApiDeps): MisService { return deps.service ?? misWorkspace(); }
function assertRequest(req: Request): void {
  if (req.method !== "POST") throw new MisError(405, "METHOD_NOT_ALLOWED");
  if (new URL(req.url).search) throw new MisError(400, "BAD_REQUEST");
}
function rateLimit(deps: MisApiDeps, key: string): void {
  if (!(deps.limiter ?? limiter).consume(key, (deps.now ?? Date.now)())) throw new MisError(429, "RATE_LIMITED");
}

export function handleMisPull(req: Request, deps: MisApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const principal = await authorizeMis(req, MIS_PULL_SCOPE, deps.auth);
    assertRequest(req);
    rateLimit(deps, `${principal.credentialId}:pull`);
    const input = await body(req);
    if (Object.keys(input).some((key) => key !== "limit")) throw new MisError(400, "BAD_REQUEST");
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new MisError(400, "BAD_REQUEST");
    return json(await service(deps).pull(principal, Number(limit)));
  });
}

export function handleMisAck(req: Request, eventId: string, deps: MisApiDeps = {}): Promise<Response> {
  return boundary(async () => {
    const principal = await authorizeMis(req, MIS_ACK_SCOPE, deps.auth);
    assertRequest(req);
    rateLimit(deps, `${principal.credentialId}:ack`);
    const input = await body(req);
    if (Object.keys(input).length !== 2 || Object.keys(input).some((key) => key !== "deliveryId" && key !== "idempotencyKey")
      || typeof input.deliveryId !== "string" || typeof input.idempotencyKey !== "string") throw new MisError(400, "BAD_REQUEST");
    return json(await service(deps).ack(principal, eventId,
      { deliveryId: input.deliveryId, idempotencyKey: input.idempotencyKey }));
  });
}
