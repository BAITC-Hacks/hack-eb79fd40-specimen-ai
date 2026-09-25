import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatStart } from "../../app/api/chat/start/handler";
import { patientSafeResumeResponse } from "../../lib/patient-response";
import { SESSION_TTL_MS } from "../../lib/config";
import { hasPatientCapability, issuePatientCookie, patientCookieName, protectPatientAction, protectPatientStart, resumePatientSession } from "../../lib/patient-session";
import { MemorySessionStore } from "../../lib/store";
import { FileSessionStore } from "../../lib/storage/session-store";
import type { TriageResult } from "../../lib/types";
import { BASE_LLM_ANALYSIS } from "../fixtures/triage.ports";

const origin = "https://patient.test";
function request(body: unknown, cookie?: string, requestOrigin: string | null = origin): NextRequest {
  return new NextRequest(`${origin}/api/chat`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(requestOrigin === null ? {} : { origin: requestOrigin }), ...(cookie ? { cookie } : {}) },
  });
}
function cookie(id: string, now?: number): string {
  return issuePatientCookie(id, now).split(";", 1)[0];
}
const result: TriageResult = {
  anamnesis: BASE_LLM_ANALYSIS.anamnesis, red_flags: [], urgency: "planned", urgency_reasons: [], routing: [],
  hypothesis: { text: "Оценка врача", confidence: 0, disclaimer: "Это не диагноз, решает врач" }, source: "rules_only",
};

beforeEach(() => {
  vi.stubEnv("DEMEU_AUTH_SECRET", "patient-test-secret-with-at-least-32-bytes");
  vi.stubEnv("DEMEU_ACCOUNTS_FILE", "/operator/accounts.json");
  vi.stubEnv("DEMEU_DATA_DIR", "/operator/data");
  vi.stubEnv("APP_BASE_URL", origin);
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("patient session capabilities", () => {
  it("issues a restricted per-session cookie on successful start without changing the envelope", async () => {
    const state = new MemorySessionStore();
    const token = await state.createDoctorToken();
    const req = request({ token, language: "kk" });
    const response = await protectPatientStart(req, () => handleChatStart(req, state));
    const started = await response.json();
    expect(Object.keys(started).sort()).toEqual(["reply", "sessionId", "turnsLeft"]);
    expect(response.headers.get("Set-Cookie")).toContain("Path=/api/chat; HttpOnly; SameSite=Strict");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(hasPatientCapability(request({}, response.headers.get("Set-Cookie")!.split(";", 1)[0]), started.sessionId)).toBe(true);
  });

  it("uses a secure cookie in production and rejects forge, wrong session and expiration", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const state = new MemorySessionStore();
    const token = await state.createDoctorToken();
    const a = await state.createSession(token);
    const b = await state.createSession(token);
    expect(issuePatientCookie(a.id)).toContain("; Secure");
    expect(patientCookieName(a.id)).toMatch(/^__Secure-/);
    const valid = cookie(a.id);
    expect(hasPatientCapability(request({}, valid), b.id)).toBe(false);
    expect(hasPatientCapability(request({}, `${valid.slice(0, -1)}!`), a.id)).toBe(false);
    expect(hasPatientCapability(request({}, cookie(a.id, 0)), a.id)).toBe(false);
    expect(hasPatientCapability(request({}, `${valid}; ${valid}`), a.id)).toBe(false);
  });

  it("does not accept an actor cookie or raw session id instead of a patient capability", async () => {
    const state = new MemorySessionStore();
    const token = await state.createDoctorToken();
    const session = await state.createSession(token);
    const run = vi.fn(async () => Response.json({ done: true }));
    const response = await protectPatientAction(request({ sessionId: session.id }, "demeu_workspace=another-doctor-cookie"), state, run);
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([null, "https://other.test"])("rejects origin %j before any start or mutation", async (requestOrigin) => {
    const run = vi.fn(async () => Response.json({}));
    expect((await protectPatientStart(request({}, undefined, requestOrigin), run)).status).toBe(403);
    expect((await protectPatientAction(request({}, undefined, requestOrigin), new MemorySessionStore(), run)).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed on partial workspace configuration", async () => {
    vi.stubEnv("DEMEU_AUTH_SECRET", "short");
    const run = vi.fn(async () => Response.json({}));
    expect((await protectPatientStart(request({}), run)).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves legacy routes unchanged and keeps legacy resume disabled", async () => {
    vi.stubEnv("DEMEU_AUTH_SECRET", undefined);
    vi.stubEnv("DEMEU_ACCOUNTS_FILE", undefined);
    const run = vi.fn(async () => Response.json({ legacy: true }, { status: 201 }));
    expect((await protectPatientStart(request({}, undefined, null), run)).status).toBe(201);
    expect((await protectPatientAction(request({}, undefined, null), new MemorySessionStore(), run)).status).toBe(201);
    expect((await resumePatientSession(request({}), new MemorySessionStore())).status).toBe(404);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("resumes only the bound token and returns terminal state without analysis or delivery", async () => {
    const state = new MemorySessionStore();
    const token = await state.createDoctorToken();
    const session = await state.createSession(token, "kk");
    await state.appendMessage(session.id, { role: "user", content: "Ответ" });
    await state.completeSession(session.id, result);
    const create = vi.spyOn(state, "createSession");
    const append = vi.spyOn(state, "appendMessage");
    const response = await patientSafeResumeResponse(
      await resumePatientSession(request({ sessionId: session.id, token }, cookie(session.id)), state),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      sessionId: session.id,
      language: "kk",
      status: "completed",
      closing: { emergency: false },
      turnsLeft: 19,
    });
    expect(payload).not.toHaveProperty("result");
    expect(create).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect((await resumePatientSession(request({ sessionId: session.id, token: "other" }, cookie(session.id)), state)).status).toBe(401);
    expect((await resumePatientSession(request({ sessionId: session.id, token }), state)).status).toBe(401);
  });

  it("checks collecting TTL even before the periodic sweeper runs", async () => {
    const state = new MemorySessionStore({ now: () => Date.now() - SESSION_TTL_MS - 1 });
    const token = await state.createDoctorToken();
    const session = await state.createSession(token);
    const run = vi.fn(async () => Response.json({}));
    expect((await protectPatientAction(request({ sessionId: session.id }, cookie(session.id)), state, run)).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("restores with the same secret after reopening durable session storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-resume-"));
    const path = join(directory, "sessions.json");
    let state = new FileSessionStore({ path });
    try {
      const token = await state.createDoctorToken();
      const session = await state.createSession(token);
      await state.appendMessage(session.id, { role: "user", content: "Ответ" });
      const capability = cookie(session.id);
      await state.close();
      state = new FileSessionStore({ path });
      const response = await resumePatientSession(request({ sessionId: session.id, token }, capability), state);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "collecting", messages: [{ role: "user", content: "Ответ" }] });
      vi.stubEnv("DEMEU_AUTH_SECRET", "rotated-secret-also-longer-than-32-bytes");
      expect((await resumePatientSession(request({ sessionId: session.id, token }, capability), state)).status).toBe(401);
    } finally {
      await state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
