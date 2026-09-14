import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LinkRateLimiter, linkClientKey } from "./rate-limit";

export interface WorkspaceActor {
  id: string;
  displayName: string;
  role: "owner" | "doctor" | "analyst";
  organizationId: string;
  telegramChatId?: string;
}

interface WorkspaceAccount extends WorkspaceActor {
  passwordHash: string;
  sessionVersion: number;
}

const AUTH_ERROR_BRAND = Symbol.for("demeu.WorkspaceAuthError");
export class WorkspaceAuthError extends Error {
  readonly [AUTH_ERROR_BRAND] = true;
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = "WorkspaceAuthError";
  }
}

export function isWorkspaceAuthError(error: unknown): error is WorkspaceAuthError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<PropertyKey, unknown>;
  return candidate[AUTH_ERROR_BRAND] === true &&
    typeof candidate.status === "number" && Number.isInteger(candidate.status) && candidate.status >= 400 && candidate.status <= 599 &&
    typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate.code);
}

const SESSION_SECONDS = 8 * 60 * 60;
const BODY_LIMIT = 4_096;
const PASSWORD_LIMIT = 1_024;
const HASH_PATTERN = /^scrypt\$16384\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/u;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const DUMMY_HASH = `scrypt$16384$8$1$${"0".repeat(32)}$${"0".repeat(128)}`;
const globals = globalThis as typeof globalThis & { __demeuWorkspaceLoginLimiter?: LinkRateLimiter };

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashWorkspacePassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password) > PASSWORD_LIMIT) {
    throw new Error("Password must contain at least 12 characters and at most 1024 bytes");
  }
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `scrypt$16384$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = HASH_PATTERN.exec(encoded);
  if (!match) return false;
  const actual = await derivePassword(password, Buffer.from(match[1], "hex"));
  return timingSafeEqual(actual, Buffer.from(match[2], "hex"));
}

export function workspaceEnabled(): boolean {
  return Boolean(process.env.DEMEU_ACCOUNTS_FILE?.trim() && process.env.DEMEU_AUTH_SECRET && process.env.DEMEU_DATA_DIR?.trim());
}

// Existing owned data latches workspace mode even if both auth variables disappear.
// A link is returned only after its ownership binding commits to this snapshot.
export function workspaceConfigured(): boolean {
  if (process.env.DEMEU_ACCOUNTS_FILE !== undefined || process.env.DEMEU_AUTH_SECRET !== undefined) return true;
  const directory = process.env.DEMEU_DATA_DIR?.trim();
  if (!directory) return false;
  try {
    lstatSync(resolve(directory, "referrals.json"));
    return true;
  } catch (error) {
    // Permission/IO errors cannot be interpreted as permission to enter legacy mode.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function secret(): string {
  const value = process.env.DEMEU_AUTH_SECRET;
  if (!value || Buffer.byteLength(value) < 32) throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function accounts(): Promise<WorkspaceAccount[]> {
  try {
    if (!workspaceEnabled()) throw new Error("configuration incomplete");
    secret();
    const filename = process.env.DEMEU_ACCOUNTS_FILE;
    if (!filename?.trim()) throw new Error("configuration unavailable");
    const bytes = await readFile(filename);
    if (bytes.length > 1_048_576) throw new Error("configuration too large");
    const document: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(document) || !Array.isArray(document.accounts) || document.accounts.length === 0) {
      throw new Error("invalid configuration");
    }
    const ids = new Set<string>();
    for (const entry of document.accounts) {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" || !IDENTIFIER.test(entry.id) || ids.has(entry.id) ||
        typeof entry.displayName !== "string" || !entry.displayName.trim() || entry.displayName.length > 120 ||
        typeof entry.role !== "string" || !["owner", "doctor", "analyst"].includes(entry.role) ||
        typeof entry.organizationId !== "string" || !IDENTIFIER.test(entry.organizationId) ||
        typeof entry.passwordHash !== "string" || !HASH_PATTERN.test(entry.passwordHash) ||
        !Number.isSafeInteger(entry.sessionVersion) || Number(entry.sessionVersion) < 1 ||
        (entry.telegramChatId !== undefined &&
          (typeof entry.telegramChatId !== "string" || !/^-?[1-9][0-9]{0,18}$/u.test(entry.telegramChatId)))
      ) throw new Error("invalid account");
      if (entry.telegramChatId !== undefined &&
        (BigInt(entry.telegramChatId as string) < -(2n ** 63n) || BigInt(entry.telegramChatId as string) > 2n ** 63n - 1n)) {
        throw new Error("invalid recipient");
      }
      ids.add(entry.id);
    }
    return document.accounts as WorkspaceAccount[];
  } catch {
    throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
  }
}

function actor(account: WorkspaceAccount): WorkspaceActor {
  return {
    id: account.id,
    displayName: account.displayName,
    role: account.role,
    organizationId: account.organizationId,
    ...(account.telegramChatId === undefined ? {} : { telegramChatId: account.telegramChatId }),
  };
}

// Delivery resolves current membership instead of trusting a stored role snapshot.
export async function currentWorkspaceActor(id: string): Promise<WorkspaceActor | null> {
  if (!workspaceConfigured()) return null;
  const account = (await accounts()).find((entry) => entry.id === id);
  return account ? actor(account) : null;
}

export function workspaceCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-demeu_workspace" : "demeu_workspace";
}

function cookieHeader(value: string, maxAge = SESSION_SECONDS): string {
  return `${workspaceCookieName()}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function issueCookie(account: WorkspaceAccount): string {
  const payload = Buffer.from(JSON.stringify({
    id: account.id,
    exp: Math.floor(Date.now() / 1_000) + SESSION_SECONDS,
    version: account.sessionVersion,
  })).toString("base64url");
  return cookieHeader(`${payload}.${sign(payload)}`);
}

export async function getWorkspaceActor(req: Request): Promise<WorkspaceActor | null> {
  if (!workspaceConfigured()) return null;
  const configured = await accounts();
  const candidates = (req.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${workspaceCookieName()}=`));
  if (candidates.length !== 1) return null;
  const value = candidates[0].slice(workspaceCookieName().length + 1);
  if (value.length > 2_048) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(value);
  if (!match) return null;
  const expected = Buffer.from(sign(match[1]));
  const supplied = Buffer.from(match[2]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    if (
      !isRecord(payload) || Object.keys(payload).sort().join(",") !== "exp,id,version" ||
      typeof payload.id !== "string" || !Number.isSafeInteger(payload.exp) ||
      Number(payload.exp) <= Math.floor(Date.now() / 1_000) ||
      !Number.isSafeInteger(payload.version)
    ) return null;
    const account = configured.find((entry) => entry.id === payload.id && entry.sessionVersion === payload.version);
    return account ? actor(account) : null;
  } catch {
    return null;
  }
}

export async function requireWorkspaceActor(req: Request): Promise<WorkspaceActor> {
  if (!workspaceEnabled()) throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
  const result = await getWorkspaceActor(req);
  if (!result) throw new WorkspaceAuthError(401, "UNAUTHORIZED");
  return result;
}

export function assertSameOrigin(req: Request): void {
  let expected: string;
  try {
    const configured = process.env.APP_BASE_URL;
    if (!configured && process.env.NODE_ENV === "production") throw new Error("origin unavailable");
    const base = new URL(configured || req.url);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("invalid origin");
    expected = base.origin;
  } catch {
    throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
  }
  if (req.headers.get("origin") !== expected) throw new WorkspaceAuthError(403, "FORBIDDEN");
}

async function loginBody(req: Request): Promise<{ id: string; password: string }> {
  if (Number(req.headers.get("content-length")) > BODY_LIMIT) throw new WorkspaceAuthError(413, "BODY_TOO_LARGE");
  if (req.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
    throw new WorkspaceAuthError(400, "BAD_REQUEST");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new WorkspaceAuthError(400, "BAD_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        throw new WorkspaceAuthError(413, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(body) || Object.keys(body).sort().join(",") !== "id,password" ||
      typeof body.id !== "string" || !IDENTIFIER.test(body.id) ||
      typeof body.password !== "string" || Buffer.byteLength(body.password) > PASSWORD_LIMIT) {
      throw new WorkspaceAuthError(400, "BAD_REQUEST");
    }
    return { id: body.id, password: body.password };
  } catch (error) {
    if (isWorkspaceAuthError(error)) throw error;
    throw new WorkspaceAuthError(400, "BAD_REQUEST");
  } finally {
    reader.releaseLock();
  }
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export async function handleWorkspaceAuth(req: Request): Promise<Response> {
  try {
    if (req.method === "GET") return json({ enabled: workspaceEnabled(), actor: await getWorkspaceActor(req) });
    assertSameOrigin(req);
    if (req.method === "DELETE") return json({ ok: true }, 200, { "Set-Cookie": cookieHeader("", 0) });
    if (req.method !== "POST") return json({ error: "Метод недоступен", code: "METHOD_NOT_ALLOWED" }, 405);
    if (!workspaceEnabled()) throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
    const limiter = (globals.__demeuWorkspaceLoginLimiter ??= new LinkRateLimiter());
    const delay = limiter.consume(linkClientKey(req.headers));
    if (delay) return json({ error: "Слишком много запросов", code: "RATE_LIMITED", retry_after_ms: delay }, 429, {
      "Retry-After": String(Math.ceil(delay / 1_000)),
    });
    const body = await loginBody(req);
    const configured = await accounts();
    const account = configured.find((entry) => entry.id === body.id);
    const valid = await verifyPassword(body.password, account?.passwordHash ?? DUMMY_HASH);
    if (!account || !valid) throw new WorkspaceAuthError(401, "UNAUTHORIZED");
    return json({ actor: actor(account) }, 200, { "Set-Cookie": issueCookie(account) });
  } catch (error) {
    const known = isWorkspaceAuthError(error);
    const status = known ? error.status : 500;
    const code = known ? error.code : "INTERNAL";
    return json({ error: status === 401 ? "Неверные учетные данные" : "Запрос недоступен", code }, status);
  }
}
