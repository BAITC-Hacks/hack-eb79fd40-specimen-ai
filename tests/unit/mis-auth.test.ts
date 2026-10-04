import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeMis, hashMisSecret } from "../../lib/mis/auth";
import { handleMisPull } from "../../lib/mis/api";

const secret = "s".repeat(43);
const bearer = `Bearer credential-a.${secret}`;
const dirs: string[] = [];

async function fixture(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "demeu-mis-auth-"));
  dirs.push(dir);
  const path = join(dir, "credentials.json");
  const document = {
    schemaVersion: 1,
    integrations: [{
      integrationId: "integration-a", organizationId: "org-a", enabled: true,
      keys: [{ credentialId: "credential-a", secretHash: hashMisSecret(secret), enabled: true,
        scopes: ["events:pull", "events:ack", "events:research"], expiresAt: null as number | null }],
    }],
    ...overrides,
  };
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, document };
}

const request = (authorization = bearer, cookie?: string) => new Request("https://demeu.test/api/mis/v1/events/pull", {
  method: "POST", headers: { ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) },
});

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("MIS service credentials", () => {
  it("authenticates an organization scoped credential and keeps research as a distinct scope", async () => {
    const { path } = await fixture();
    await expect(authorizeMis(request(), "events:pull", { path, production: true, now: () => 1 }))
      .resolves.toEqual({ integrationId: "integration-a", credentialId: "credential-a", organizationId: "org-a",
        scopes: ["events:pull", "events:ack", "events:research"] });
    const { path: limited } = await fixture({ integrations: [{ integrationId: "integration-b", organizationId: "org-b", enabled: true,
      keys: [{ credentialId: "credential-a", secretHash: hashMisSecret(secret), enabled: true, scopes: ["events:pull"], expiresAt: null }] }] });
    await expect(authorizeMis(request(), "events:research", { path: limited, production: true })).rejects.toMatchObject({ status: 403, code: "MIS_FORBIDDEN" });
  });

  it("rejects cookies, wrong secrets, disabled, expired and revoked credentials without revealing which check failed", async () => {
    const { path, document } = await fixture();
    await expect(authorizeMis(request("", "__Host-demeu_workspace=fake"), "events:pull", { path, production: true }))
      .rejects.toMatchObject({ status: 401, code: "MIS_UNAUTHORIZED" });
    await expect(authorizeMis(request(`Bearer credential-a.${"x".repeat(43)}`), "events:pull", { path, production: true }))
      .rejects.toMatchObject({ status: 401, code: "MIS_UNAUTHORIZED" });
    const integration = document.integrations[0];
    integration.keys[0].enabled = false;
    await writeFile(path, JSON.stringify(document));
    await expect(authorizeMis(request(), "events:pull", { path, production: true })).rejects.toMatchObject({ status: 401, code: "MIS_UNAUTHORIZED" });
    integration.keys[0].enabled = true;
    integration.keys[0].expiresAt = 10;
    await writeFile(path, JSON.stringify(document));
    await expect(authorizeMis(request(), "events:pull", { path, production: true, now: () => 10 })).rejects.toMatchObject({ status: 401, code: "MIS_UNAUTHORIZED" });
    integration.keys[0].expiresAt = null;
    integration.enabled = false;
    await writeFile(path, JSON.stringify(document));
    await expect(authorizeMis(request(), "events:pull", { path, production: true })).rejects.toMatchObject({ status: 401, code: "MIS_UNAUTHORIZED" });
  });

  it("rereads rotation and revocation on every request", async () => {
    const { path, document } = await fixture();
    await expect(authorizeMis(request(), "events:pull", { path, production: true })).resolves.toMatchObject({ integrationId: "integration-a" });
    document.integrations[0].keys[0].enabled = false;
    document.integrations[0].keys.push({ credentialId: "credential-b", secretHash: hashMisSecret("b".repeat(43)), enabled: true,
      scopes: ["events:pull", "events:ack", "events:research"], expiresAt: null });
    await writeFile(path, JSON.stringify(document));
    await expect(authorizeMis(request(), "events:pull", { path, production: true })).rejects.toMatchObject({ status: 401 });
    await expect(authorizeMis(request(`Bearer credential-b.${"b".repeat(43)}`), "events:pull", { path, production: true }))
      .resolves.toMatchObject({ integrationId: "integration-a", credentialId: "credential-b" });
  });

  it("fails closed for missing, malformed, symlinked, oversized-permission credential files", async () => {
    const { path } = await fixture();
    await chmod(path, 0o644);
    await expect(authorizeMis(request(), "events:pull", { path, production: true })).rejects.toMatchObject({ status: 503, code: "MIS_UNAVAILABLE" });
    await writeFile(path, "not-json");
    await chmod(path, 0o600);
    await expect(authorizeMis(request(), "events:pull", { path, production: true })).rejects.toMatchObject({ status: 503 });
    const link = `${path}.link`;
    await symlink(path, link);
    await expect(authorizeMis(request(), "events:pull", { path: link, production: true })).rejects.toMatchObject({ status: 503 });
    await expect(authorizeMis(request(), "events:pull", { path: `${path}.missing`, production: true })).rejects.toMatchObject({ status: 503 });
    await writeFile(path, "x".repeat(1_000_001), { mode: 0o600 });
    await expect(authorizeMis(request(), "events:pull", { path, production: true })).rejects.toMatchObject({ status: 503 });
  });

  it("authenticates and checks scope before query, body and event work", async () => {
    const { path } = await fixture();
    const service = { pull: async () => { throw new Error("must not run"); } };
    const malformed = new Request("https://demeu.test/api/mis/v1/events/pull?forged=1", {
      method: "POST", headers: { "content-type": "application/json", cookie: "__Host-demeu_workspace=fake" }, body: "not-json",
    });
    const unauthorized = await handleMisPull(malformed, { auth: { path, production: true }, service: service as never });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ code: "MIS_UNAUTHORIZED" });
    const authorized = new Request("https://demeu.test/api/mis/v1/events/pull?forged=1", {
      method: "POST", headers: { "content-type": "application/json", authorization: bearer }, body: "not-json",
    });
    const badQuery = await handleMisPull(authorized, { auth: { path, production: true }, service: service as never });
    expect(badQuery.status).toBe(400);
    expect(await badQuery.json()).toMatchObject({ code: "BAD_REQUEST" });
  });
});
