import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const CADDY_IMAGE = "caddy:2.10.2-alpine";
const IP_HOST = "109.123.248.16";
const ALIAS_HOST = "109-123-248-16.sslip.io";
const dockerAvailable = spawnSync(
  "docker",
  ["info", "--format", "{{.ServerVersion}}"],
  { stdio: "ignore" },
).status === 0;

interface CaddyRoute {
  match?: Array<{ host?: string[] }>;
  handle?: unknown[];
}

interface CaddyServer {
  routes?: CaddyRoute[];
  tls_connection_policies?: unknown[];
}

interface CaddyJson {
  apps?: {
    http?: { servers?: Record<string, CaddyServer> };
    tls?: { automation?: { policies?: Array<Record<string, unknown>> } };
  };
}

function curlRoute(port: number, host: string): ReturnType<typeof spawnSync> {
  return spawnSync("curl", [
    "-ksS",
    "--connect-to",
    `${host}:443:127.0.0.1:${port}`,
    "--write-out",
    "\n%{http_code}",
    `https://${host}/`,
  ], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

async function adaptProductionIpConfig(): Promise<CaddyJson> {
  const source = await readFile("deploy/Caddyfile.ip", "utf8");
  const encoded = Buffer.from(source, "utf8").toString("base64");
  const { stdout } = await execFile("docker", [
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-e",
    `CADDYFILE_B64=${encoded}`,
    "--entrypoint",
    "/bin/sh",
    CADDY_IMAGE,
    "-c",
    "printf '%s' \"$CADDYFILE_B64\" | base64 -d > /tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile",
  ]);
  return JSON.parse(stdout) as CaddyJson;
}

function offlineFixture(productionConfig: CaddyJson): CaddyJson {
  const fixture = structuredClone(productionConfig);
  const automationPolicies = fixture.apps?.tls?.automation?.policies ?? [];
  for (const policy of automationPolicies) {
    policy.issuers = [{ module: "internal" }];
  }

  const server = Object.values(fixture.apps?.http?.servers ?? {})[0];
  if (!server?.routes?.length) throw new Error("Adapted production Caddy config has no routes");
  for (const route of server.routes) {
    const host = route.match?.[0]?.host?.[0];
    if (!host) throw new Error("Adapted production Caddy route has no exact host matcher");
    route.handle = [{ handler: "static_response", body: `route:${host}`, status_code: 200 }];
  }
  return fixture;
}

async function startCaddy(
  config: CaddyJson,
  suffix: string,
): Promise<{ name: string; port: number }> {
  const name = `demeu-caddy-sni-${process.pid}-${suffix}`;
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  await execFile("docker", ["image", "inspect", CADDY_IMAGE]);
  try {
    await execFile("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--read-only",
      "--tmpfs",
      "/data",
      "--tmpfs",
      "/config",
      "--tmpfs",
      "/tmp",
      "-p",
      "127.0.0.1::443",
      "-e",
      `CADDY_JSON_B64=${encoded}`,
      "--entrypoint",
      "/bin/sh",
      CADDY_IMAGE,
      "-c",
      "printf '%s' \"$CADDY_JSON_B64\" | base64 -d > /tmp/caddy.json && exec caddy run --config /tmp/caddy.json",
    ]);
    const { stdout } = await execFile("docker", ["port", name, "443/tcp"]);
    const match = stdout.trim().match(/^127\.0\.0\.1:(\d+)$/u);
    if (!match) throw new Error("Docker did not publish ephemeral Caddy on loopback");
    return { name, port: Number(match[1]) };
  } catch (error) {
    await removeContainer(name);
    throw error;
  }
}

async function waitForAlias(port: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = curlRoute(port, ALIAS_HOST);
    if (result.status === 0 && result.stdout.includes(`route:${ALIAS_HOST}\n200`)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Ephemeral Caddy did not become ready");
}

async function removeContainer(name: string | undefined): Promise<void> {
  if (!name) return;
  try {
    await execFile("docker", ["rm", "-f", name]);
  } catch {
    // `--rm` may remove an already-exited container before cleanup runs.
  }
  const { stdout } = await execFile("docker", [
    "ps",
    "-aq",
    "--filter",
    `name=^/${name}$`,
  ]);
  if (stdout.trim()) throw new Error(`Ephemeral Caddy container remains: ${name}`);
}

it(
  "routes no-SNI IP clients through production default_sni without becoming an unknown-SNI fallback",
  async () => {
    if (!dockerAvailable) {
      throw new Error("Docker is required for the pinned Caddy no-SNI acceptance test");
    }
    const productionConfig = await adaptProductionIpConfig();
    const fixedConfig = offlineFixture(productionConfig);
    const controlConfig = structuredClone(fixedConfig);
    const controlServer = Object.values(controlConfig.apps?.http?.servers ?? {})[0];
    if (!controlServer) throw new Error("Adapted production Caddy config has no server");
    delete controlServer.tls_connection_policies;
    let controlName: string | undefined;
    let fixedName: string | undefined;

    try {
      const control = await startCaddy(controlConfig, "control");
      controlName = control.name;
      await waitForAlias(control.port);
      const controlNoSni = curlRoute(control.port, IP_HOST);
      expect(controlNoSni.status).not.toBe(0);
      expect(controlNoSni.stdout).not.toContain(`route:${IP_HOST}`);
      await removeContainer(controlName);
      controlName = undefined;

      const fixed = await startCaddy(fixedConfig, "fixed");
      fixedName = fixed.name;
      await waitForAlias(fixed.port);

      const noSniIp = curlRoute(fixed.port, IP_HOST);
      expect(noSniIp.status).toBe(0);
      expect(noSniIp.stdout).toContain(`route:${IP_HOST}\n200`);

      const explicitAlias = curlRoute(fixed.port, ALIAS_HOST);
      expect(explicitAlias.status).toBe(0);
      expect(explicitAlias.stdout).toContain(`route:${ALIAS_HOST}\n200`);

      const unknownSni = curlRoute(fixed.port, "unknown.example");
      expect(unknownSni.status).not.toBe(0);
      expect(unknownSni.stdout).not.toContain("\n200");
      expect(unknownSni.stdout).not.toMatch(/route:/u);
    } finally {
      await removeContainer(controlName);
      await removeContainer(fixedName);
    }
  },
  30_000,
);

it(
  "removes the ephemeral Caddy container after a forced harness failure",
  async () => {
    if (!dockerAvailable) {
      throw new Error("Docker is required for the pinned Caddy cleanup acceptance test");
    }
    const fixedConfig = offlineFixture(await adaptProductionIpConfig());
    let name: string | undefined;

    await expect((async () => {
      try {
        const started = await startCaddy(fixedConfig, "forced-failure");
        name = started.name;
        await waitForAlias(started.port);
        throw new Error("forced harness failure");
      } finally {
        await removeContainer(name);
      }
    })()).rejects.toThrow("forced harness failure");

    const { stdout } = await execFile("docker", [
      "ps",
      "-aq",
      "--filter",
      `name=^/${name}$`,
    ]);
    expect(stdout.trim()).toBe("");
  },
  30_000,
);
