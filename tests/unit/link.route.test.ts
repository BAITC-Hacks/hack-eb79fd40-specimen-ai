import { afterEach, describe, expect, it, vi } from "vitest";
import { handleLink } from "../../app/api/link/handler";
import { POST } from "../../app/api/link/route";
import { LinkRateLimiter, linkClientKey } from "../../lib/rate-limit";

function request(ip?: string, code?: string): Request {
  const headers = new Headers();
  if (ip !== undefined) headers.set("x-forwarded-for", ip);
  if (code !== undefined) headers.set("x-doctor-code", code);
  return new Request("http://localhost/api/link", { method: "POST", headers });
}

function setup(accessCode?: string) {
  let now = 1_000;
  const createDoctorToken = vi.fn(async () => "0123456789abcdef");
  const deps = {
    sessionStore: { createDoctorToken },
    limiter: new LinkRateLimiter(() => now),
    accessCode,
  };
  return { deps, createDoctorToken, advance: (ms: number) => { now += ms; } };
}

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/link", () => {
  it.each([undefined, ""])("remains open when access code is %j", async (code) => {
    const { deps, createDoctorToken } = setup(code);
    const response = await handleLink(request(), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "0123456789abcdef" });
    expect(createDoctorToken).toHaveBeenCalledOnce();
  });

  it.each([undefined, "wrong", "secret!", "SECRET"])(
    "rejects invalid credentials %j without creating a token",
    async (code) => {
      const { deps, createDoctorToken } = setup("secret");
      const response = await handleLink(request(undefined, code), deps);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
      expect(createDoctorToken).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact configured credential", async () => {
    const { deps } = setup("secret");
    expect((await handleLink(request(undefined, "secret"), deps)).status).toBe(200);
  });

  it("wires the environment access code through the production route", async () => {
    vi.stubEnv("DOCTOR_ACCESS_CODE", "route-test-secret");
    expect((await POST(request("192.0.2.231"))).status).toBe(401);
  });

  it("limits the eleventh request, refills at six seconds and caps idle credit", async () => {
    const { deps, advance, createDoctorToken } = setup();
    const send = () => handleLink(request("192.0.2.1"), deps);
    for (let i = 0; i < 10; i += 1) expect((await send()).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("6");
    expect(await blocked.json()).toEqual({
      error: "Слишком много запросов", code: "RATE_LIMITED", retry_after_ms: 6_000,
    });
    expect(createDoctorToken).toHaveBeenCalledTimes(10);
    advance(5_999);
    const almost = await send();
    expect(almost.status).toBe(429);
    expect(almost.headers.get("Retry-After")).toBe("1");
    expect(await almost.json()).toMatchObject({ retry_after_ms: 1 });
    advance(1);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    advance(120_000);
    for (let i = 0; i < 10; i += 1) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });

  it("keeps independent client buckets and uses the first forwarded address", async () => {
    const { deps } = setup();
    for (let i = 0; i < 10; i += 1) await handleLink(request("192.0.2.1, 10.0.0.1"), deps);
    expect((await handleLink(request("192.0.2.1, 10.0.0.2"), deps)).status).toBe(429);
    expect((await handleLink(request("192.0.2.2"), deps)).status).toBe(200);
  });

  it("charges failed authentication attempts to the same bucket", async () => {
    const { deps, createDoctorToken } = setup("secret");
    for (let i = 0; i < 10; i += 1) {
      expect((await handleLink(request(), deps)).status).toBe(401);
    }
    expect((await handleLink(request(undefined, "secret"), deps)).status).toBe(429);
    expect(createDoctorToken).not.toHaveBeenCalled();
  });

  it("shares a fallback bucket for absent or malformed client addresses", async () => {
    const { deps } = setup();
    for (let i = 0; i < 10; i += 1) await handleLink(request(`fake-${i}`), deps);
    expect((await handleLink(request(), deps)).status).toBe(429);
    expect((await handleLink(request("invalid, 192.0.2.1"), deps)).status).toBe(429);
  });

  it("returns a sanitized 500 for a store failure", async () => {
    const { deps, createDoctorToken } = setup();
    createDoctorToken.mockRejectedValueOnce(new Error("private store details"));
    const response = await handleLink(request(), deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Не удалось создать ссылку", code: "INTERNAL" });
  });
});

describe("link limiter client keys and bounded storage", () => {
  it.each([undefined, "", "unknown", "192.0.2.1:80", "fe80::1%eth0", "999.0.0.1"])(
    "maps %j to the fallback key", (value) => {
      expect(linkClientKey(request(value).headers)).toBe("unknown");
    },
  );

  it("canonicalizes equivalent IPv6 spellings", () => {
    expect(linkClientKey(request("2001:0DB8:0:0:0:0:0:1").headers))
      .toBe(linkClientKey(request("2001:db8::1").headers));
  });

  it("rejects new keys at capacity without resetting existing buckets, then prunes", () => {
    let now = 0;
    const limiter = new LinkRateLimiter(() => now, 2);
    for (let i = 0; i < 10; i += 1) expect(limiter.consume("a")).toBe(0);
    expect(limiter.consume("b")).toBe(0);
    expect(limiter.consume("c")).toBe(60_000);
    expect(limiter.consume("a")).toBe(6_000);
    now = 60_000;
    expect(limiter.consume("c")).toBe(0);
    expect(limiter.consume("d")).toBe(0);
  });
});
