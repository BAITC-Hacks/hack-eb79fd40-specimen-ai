import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HARD_TURN_CAP, RETENTION_MS, SESSION_TTL_MS } from "./config";
import type { SessionStore } from "./store";
import type { ReadonlySession } from "./types";
import { readSessionBody, RequestBodyError } from "./request-body";
import { assertSameOrigin, isWorkspaceAuthError, WorkspaceAuthError, workspaceConfigured, workspaceEnabled } from "./workspace-auth";

const CAPABILITY_SECONDS = Math.ceil((SESSION_TTL_MS + RETENTION_MS) / 1_000);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function secret(): string {
  const value = process.env.DEMEU_AUTH_SECRET;
  if (!workspaceEnabled() || !value || Buffer.byteLength(value) < 32) {
    throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
  }
  return value;
}

export function patientCookieName(sessionId: string): string {
  const suffix = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return `${process.env.NODE_ENV === "production" ? "__Secure-" : ""}demeu_patient_${suffix}`;
}

function signature(payload: string): string {
  return createHmac("sha256", secret()).update("demeu:patient-capability:v1\0").update(payload).digest("base64url");
}

export function issuePatientCookie(sessionId: string, now = Date.now()): string {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session identifier");
  const payload = Buffer.from(JSON.stringify({ id: sessionId, exp: Math.floor(now / 1_000) + CAPABILITY_SECONDS })).toString("base64url");
  return `${patientCookieName(sessionId)}=${payload}.${signature(payload)}; Path=/api/chat; HttpOnly; SameSite=Strict; Max-Age=${CAPABILITY_SECONDS}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function hasPatientCapability(req: Request, sessionId: string, now = Date.now()): boolean {
  secret();
  if (!SESSION_ID.test(sessionId)) return false;
  const name = `${patientCookieName(sessionId)}=`;
  const matches = (req.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(name));
  if (matches.length !== 1) return false;
  const cookie = matches[0].slice(name.length);
  if (cookie.length > 1_024) return false;
  const match = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]{43})$/u.exec(cookie);
  if (!match) return false;
  const expected = Buffer.from(signature(match[1]));
  const supplied = Buffer.from(match[2]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
  try {
    const data = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    return data && Object.keys(data).sort().join(",") === "exp,id" &&
      data.id === sessionId && Number.isSafeInteger(data.exp) && data.exp > Math.floor(now / 1_000);
  } catch {
    return false;
  }
}

function errorResponse(error: unknown): Response {
  const known = isWorkspaceAuthError(error);
  return Response.json({ error: "Запрос недоступен", code: known ? error.code : "INTERNAL" }, {
    status: known ? error.status : 500, headers: { "Cache-Control": "no-store" },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return await readSessionBody(req);
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) {
      throw new WorkspaceAuthError(413, "BODY_TOO_LARGE");
    }
    throw new WorkspaceAuthError(400, "BAD_REQUEST");
  }
}

function checkConfigured(req: Request): void {
  secret();
  assertSameOrigin(req);
}

async function authorizedSession(req: Request, state: SessionStore): Promise<{ session: ReadonlySession; input: Record<string, unknown> }> {
  checkConfigured(req);
  const input = await body(req);
  if (typeof input.sessionId !== "string" || !hasPatientCapability(req, input.sessionId)) {
    throw new WorkspaceAuthError(401, "UNAUTHORIZED");
  }
  const session = await state.getSession(input.sessionId);
  if (!session || (session.status === "collecting"
    ? Date.now() - session.createdAt > SESSION_TTL_MS
    : Date.now() - (session.completedAt ?? session.createdAt) > RETENTION_MS)) {
    throw new WorkspaceAuthError(404, "SESSION_NOT_FOUND");
  }
  return { session, input };
}

export async function protectPatientStart(req: Request, run: () => Promise<Response>): Promise<Response> {
  if (!workspaceConfigured()) return run();
  try {
    checkConfigured(req);
    await body(req);
    const response = await run();
    response.headers.set("Cache-Control", "no-store");
    if (response.ok) {
      const started = await response.clone().json();
      response.headers.append("Set-Cookie", issuePatientCookie(started.sessionId));
    }
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function protectPatientAction(req: Request, state: SessionStore, run: () => Promise<Response>): Promise<Response> {
  if (!workspaceConfigured()) return run();
  try {
    await authorizedSession(req, state);
    const response = await run();
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function resumePatientSession(req: Request, state: SessionStore): Promise<Response> {
  if (!workspaceConfigured()) return errorResponse(new WorkspaceAuthError(404, "NOT_FOUND"));
  try {
    const { session, input } = await authorizedSession(req, state);
    if (typeof input.token !== "string" || input.token !== session.doctorToken) {
      throw new WorkspaceAuthError(401, "UNAUTHORIZED");
    }
    return Response.json({
      sessionId: session.id, language: session.language, messages: session.messages,
      turnsLeft: Math.max(0, HARD_TURN_CAP - session.turnCount), status: session.status,
      ...(session.status === "completed" ? { result: session.result } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
