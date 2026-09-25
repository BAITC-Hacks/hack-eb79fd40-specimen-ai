import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSameOrigin,
  currentWorkspaceActor,
  getWorkspaceActor,
  handleWorkspaceAuth,
  hashWorkspacePassword,
  requireWorkspaceActor,
  workspaceConfigured,
  workspaceCookieName,
  workspaceEnabled,
} from "../../lib/workspace-auth";
import { GET, POST, DELETE } from "../../app/api/workspace/auth/route";
import { protectPatientAction, protectPatientStart } from "../../lib/patient-session";
import { MemorySessionStore } from "../../lib/store";
import { ScopedWorkspaceNotifier, workspaceNotifierFromEnv } from "../../lib/workspace-notifier";

const PASSWORD = "test-password-only-2026";
const SECRET = "workspace-test-signing-secret-only-32bytes";
const BASE = "https://workspace.example.test";
let directory: string;
let filename: string;
let passwordHash: string;
let configured: Array<Record<string, unknown>>;

beforeAll(async () => { passwordHash = await hashWorkspacePassword(PASSWORD); });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "demeu-auth-test-"));
  filename = path.join(directory, "accounts.json");
  configured = ["doctor", "owner", "analyst"].map((role) => ({
    id: role, displayName: `Test ${role}`, role, organizationId: "clinic-a", organizationDisplayName: "Клиника А", passwordHash, sessionVersion: 1,
    ...(role === "doctor" ? { telegramChatId: "1234567" } : {}),
  }));
  await save();
  vi.stubEnv("DEMEU_ACCOUNTS_FILE", filename);
  vi.stubEnv("DEMEU_AUTH_SECRET", SECRET);
  vi.stubEnv("DEMEU_DATA_DIR", directory);
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("NODE_ENV", "test");
  delete (globalThis as { __demeuWorkspaceLoginLimiter?: unknown }).__demeuWorkspaceLoginLimiter;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function save() { await writeFile(filename, JSON.stringify({ accounts: configured }), { mode: 0o600 }); }
function request(method = "GET", cookie?: string, body?: unknown, origin: string | null = BASE): Request {
  const headers = new Headers({ "x-forwarded-for": "192.0.2.17" });
  if (origin !== null) headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${BASE}/api/workspace/auth`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function login(id = "doctor"): Promise<string> {
  const response = await POST(request("POST", undefined, { id, password: PASSWORD }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.headers.get("set-cookie")!.split(";", 1)[0];
}
function signed(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");
  return `${workspaceCookieName()}=${encoded}.${signature}`;
}

describe("workspace identities and signed cookies", () => {
  it.each(["doctor", "owner", "analyst"])("returns only the current public %s actor", async (id) => {
    const cookie = await login(id);
    const response = await GET(request("GET", cookie));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ enabled: true, actor: {
      id, displayName: `Test ${id}`, role: id, organizationId: "clinic-a", organizationDisplayName: "Клиника А",
      ...(id === "doctor" ? { telegramChatId: "1234567" } : {}),
    } });
    expect(JSON.stringify(payload)).not.toContain(passwordHash);
    expect(payload.actor).not.toHaveProperty("sessionVersion");
    const persistedActor = { ...payload.actor };
    delete persistedActor.organizationDisplayName;
    expect(await requireWorkspaceActor(request("GET", cookie))).toEqual(persistedActor);
    expect(await currentWorkspaceActor(id)).toEqual(persistedActor);
  });

  it("uses secure host-only HttpOnly cookies in production and clears them on logout", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(request("POST", undefined, { id: "doctor", password: PASSWORD }));
    const header = response.headers.get("set-cookie")!;
    expect(header).toMatch(/^__Host-demeu_workspace=/u);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=28800"]) expect(header).toContain(attr);
    expect(header).not.toContain("Domain=");
    const logout = await DELETE(request("DELETE", header.split(";", 1)[0]));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(logout.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects forged, expired, duplicate and malformed cookies", async () => {
    const cookie = await login();
    expect(await getWorkspaceActor(request("GET", `${cookie.slice(0, -1)}!`))).toBeNull();
    expect(await getWorkspaceActor(request("GET", `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`))).toBeNull();
    const future = Math.floor(Date.now() / 1_000) + 60;
    for (const value of [
      signed({ id: "doctor", exp: 1, version: 1 }),
      signed({ id: "doctor", exp: future, version: 99 }),
      signed({ id: "unknown", exp: future, version: 1 }),
      signed({ id: "doctor", exp: future, version: 1, role: "owner" }),
      signed({ id: "doctor", exp: "tomorrow", version: 1 }),
      `${cookie}; ${cookie}`,
      `${workspaceCookieName()}=invalid`,
    ]) expect(await getWorkspaceActor(request("GET", value))).toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1_000);
    expect(await getWorkspaceActor(request("GET", cookie))).toBeNull();
  });

  it("reloads roles and organization, and honors account removal and session revocation", async () => {
    const cookie = await login();
    configured[0].role = "analyst";
    configured[0].organizationId = "clinic-b";
    await save();
    expect(await getWorkspaceActor(request("GET", cookie))).toMatchObject({ role: "analyst", organizationId: "clinic-b" });
    configured[0].sessionVersion = 2;
    await save();
    expect(await getWorkspaceActor(request("GET", cookie))).toBeNull();
    configured = configured.slice(1);
    await save();
    expect(await currentWorkspaceActor("doctor")).toBeNull();
    expect(await getWorkspaceActor(request("GET", cookie))).toBeNull();
  });

  it("uses the same generic failure for an unknown account or wrong password", async () => {
    const unknown = await POST(request("POST", undefined, { id: "unknown", password: PASSWORD }));
    const wrong = await POST(request("POST", undefined, { id: "doctor", password: "wrong" }));
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(unknown.headers.get("set-cookie")).toBeNull();
    expect(unknown.headers.get("cache-control")).toBe("no-store");
  });

  it("charges invalid attempts and throttles the eleventh before password work", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await POST(request("POST", undefined, {}))).status).toBe(400);
    }
    const response = await POST(request("POST", undefined, { id: "doctor", password: PASSWORD }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("workspace configuration and request boundaries", () => {
  it("latches owned storage to workspace mode when both auth variables are removed", async () => {
    vi.stubEnv("DEMEU_ACCOUNTS_FILE", undefined);
    vi.stubEnv("DEMEU_AUTH_SECRET", undefined);
    expect(workspaceConfigured()).toBe(false);
    await writeFile(path.join(directory, "referrals.json"), "{}");
    expect(workspaceConfigured()).toBe(true);
    expect(workspaceEnabled()).toBe(false);
    expect((await GET(request())).status).toBe(503);
    await expect(requireWorkspaceActor(request())).rejects.toMatchObject({ status: 503 });
    const run = vi.fn(async () => Response.json({ leaked: true }));
    expect((await protectPatientStart(request("POST"), run)).status).toBe(503);
    expect((await protectPatientAction(request("POST"), new MemorySessionStore(), run)).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_IDS", "999,888");
    expect(workspaceNotifierFromEnv()).toBeInstanceOf(ScopedWorkspaceNotifier);
    // Even an unreadable/malformed path cannot downgrade to legacy access.
    vi.stubEnv("DEMEU_DATA_DIR", filename);
    expect(workspaceConfigured()).toBe(true);
    expect((await GET(request())).status).toBe(503);
  });

  it("keeps absent workspace off but partial configuration fails closed", async () => {
    vi.stubEnv("DEMEU_ACCOUNTS_FILE", undefined);
    vi.stubEnv("DEMEU_AUTH_SECRET", undefined);
    expect(workspaceConfigured()).toBe(false);
    expect(workspaceEnabled()).toBe(false);
    expect(await (await GET(request())).json()).toEqual({ enabled: false, actor: null });
    expect((await POST(request("POST", undefined, { id: "doctor", password: PASSWORD }))).status).toBe(503);
    vi.stubEnv("DEMEU_ACCOUNTS_FILE", filename);
    expect(workspaceConfigured()).toBe(true);
    expect((await GET(request())).status).toBe(503);
    vi.stubEnv("DEMEU_AUTH_SECRET", SECRET);
    vi.stubEnv("DEMEU_DATA_DIR", undefined);
    expect((await GET(request())).status).toBe(503);
    vi.stubEnv("DEMEU_DATA_DIR", directory);
    vi.stubEnv("DEMEU_AUTH_SECRET", "short");
    expect((await GET(request())).status).toBe(503);
  });

  it("does not accept shared doctor code as identity", async () => {
    vi.stubEnv("DOCTOR_ACCESS_CODE", "shared");
    const req = request();
    req.headers.set("x-doctor-code", "shared");
    expect(await getWorkspaceActor(req)).toBeNull();
    await expect(requireWorkspaceActor(req)).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it.each([null, "null", "https://evil.example.test", "https://workspace.example.test.evil.test"])("rejects mutation origin %j", async (origin) => {
    for (const method of ["POST", "DELETE"]) {
      const response = await handleWorkspaceAuth(request(method, undefined, method === "POST" ? { id: "doctor", password: PASSWORD } : undefined, origin));
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("uses configured origin over request Host and permits URL fallback only outside production", async () => {
    const spoofed = new Request("https://evil.example.test/api/workspace/auth", { headers: { origin: "https://evil.example.test" } });
    expect(() => assertSameOrigin(spoofed)).toThrow();
    vi.stubEnv("APP_BASE_URL", undefined);
    expect(() => assertSameOrigin(request())).not.toThrow();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertSameOrigin(request())).toThrow();
  });

  it("caps declared and streamed request bodies and rejects client-selected authority", async () => {
    const large = request("POST", undefined, { id: "doctor", password: "a".repeat(5_000) });
    expect((await POST(large)).status).toBe(413);
    const declared = request("POST", undefined, {});
    declared.headers.set("content-length", "5000");
    expect((await POST(declared)).status).toBe(413);
    expect((await POST(request("POST", undefined, { id: "doctor", password: PASSWORD, role: "owner" }))).status).toBe(400);
    expect((await POST(request("POST", undefined, { id: "doctor", password: "a".repeat(1_025) }))).status).toBe(400);
    const malformed = new Request(`${BASE}/api/workspace/auth`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: "{" });
    expect((await POST(malformed)).status).toBe(400);
  });

  it("fails closed on corrupt, duplicate, malformed-role, or missing account files without leaking paths", async () => {
    for (const text of ["broken", JSON.stringify({ accounts: [...configured, configured[0]] }), JSON.stringify({ accounts: [{ ...configured[0], role: ["owner"] }] })]) {
      await writeFile(filename, text);
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain(directory);
    }
    vi.stubEnv("DEMEU_ACCOUNTS_FILE", path.join(directory, "absent.json"));
    expect((await GET(request())).status).toBe(503);
  });
});
