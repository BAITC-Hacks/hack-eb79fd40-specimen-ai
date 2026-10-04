import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { misFail } from "./errors";
import type { MisPrincipal, MisScope } from "./types";

interface CredentialKey {
  credentialId: string;
  secretHash: string;
  enabled: boolean;
  scopes: MisScope[];
  expiresAt: number | null;
}
interface Integration {
  integrationId: string;
  organizationId: string;
  enabled: boolean;
  keys: CredentialKey[];
}
interface CredentialFile { schemaVersion: 1; integrations: Integration[] }

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value);

export function hashMisSecret(secret: string): string {
  return `sha256$${createHash("sha256").update(`demeu:mis:credential:v1\0${secret}`).digest("hex")}`;
}

function validateCredentialFile(value: unknown): CredentialFile {
  if (!object(value) || !exact(value, ["schemaVersion", "integrations"]) || value.schemaVersion !== 1 || !Array.isArray(value.integrations)) {
    return misFail(503, "MIS_UNAVAILABLE");
  }
  const integrations: Integration[] = [];
  const integrationIds = new Set<string>();
  const credentialIds = new Set<string>();
  const enabledOrganizations = new Set<string>();
  for (const raw of value.integrations) {
    if (!object(raw) || !exact(raw, ["integrationId", "organizationId", "enabled", "keys"])
      || !identifier(raw.integrationId) || integrationIds.has(raw.integrationId) || !identifier(raw.organizationId)
      || typeof raw.enabled !== "boolean" || !Array.isArray(raw.keys) || raw.keys.length === 0) return misFail(503, "MIS_UNAVAILABLE");
    if (raw.enabled && enabledOrganizations.has(raw.organizationId)) return misFail(503, "MIS_UNAVAILABLE");
    const keys: CredentialKey[] = [];
    for (const candidate of raw.keys) {
      if (!object(candidate) || !exact(candidate, ["credentialId", "secretHash", "enabled", "scopes", "expiresAt"])
        || !identifier(candidate.credentialId) || credentialIds.has(candidate.credentialId)
        || !/^sha256\$[a-f0-9]{64}$/u.test(String(candidate.secretHash)) || typeof candidate.enabled !== "boolean"
        || !Array.isArray(candidate.scopes) || candidate.scopes.length === 0
        || new Set(candidate.scopes).size !== candidate.scopes.length
        || !candidate.scopes.every((scope) => scope === "events:pull" || scope === "events:ack" || scope === "events:research")
        || !(candidate.expiresAt === null || Number.isSafeInteger(candidate.expiresAt) && Number(candidate.expiresAt) >= 0)) {
        return misFail(503, "MIS_UNAVAILABLE");
      }
      credentialIds.add(candidate.credentialId);
      keys.push(candidate as unknown as CredentialKey);
    }
    integrationIds.add(raw.integrationId);
    if (raw.enabled) enabledOrganizations.add(raw.organizationId);
    integrations.push({ integrationId: raw.integrationId, organizationId: raw.organizationId, enabled: raw.enabled, keys });
  }
  return { schemaVersion: 1, integrations };
}

async function loadCredentials(path: string, production: boolean): Promise<CredentialFile> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1_000_000
      || production && (stat.mode & 0o077) !== 0) return misFail(503, "MIS_UNAVAILABLE");
    return validateCredentialFile(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    return misFail(503, "MIS_UNAVAILABLE");
  }
}

function equalHash(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface MisAuthOptions {
  path?: string;
  now?: () => number;
  production?: boolean;
}

export async function authorizeMis(req: Request, scope: MisScope, options: MisAuthOptions = {}): Promise<MisPrincipal> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{1,100})\.([A-Za-z0-9_-]{43})$/u.exec(header);
  if (!match) return misFail(401, "MIS_UNAUTHORIZED");
  const configured = options.path ?? process.env.DEMEU_MIS_CREDENTIALS_FILE;
  if (!configured) return misFail(503, "MIS_UNAVAILABLE");
  const credentials = await loadCredentials(resolve(configured), options.production ?? process.env.NODE_ENV === "production");
  const [credentialId, secret] = match.slice(1);
  const now = (options.now ?? Date.now)();
  const integration = credentials.integrations.find((entry) => entry.keys.some((key) => key.credentialId === credentialId));
  const key = integration?.keys.find((entry) => entry.credentialId === credentialId);
  const valid = Boolean(integration?.enabled && key?.enabled && (key.expiresAt === null || key.expiresAt > now)
    && equalHash(hashMisSecret(secret), key!.secretHash));
  if (!valid || !integration || !key) return misFail(401, "MIS_UNAUTHORIZED");
  if (!key.scopes.includes(scope)) return misFail(403, "MIS_FORBIDDEN");
  return { integrationId: integration.integrationId, credentialId: key.credentialId,
    organizationId: integration.organizationId, scopes: [...key.scopes] };
}
