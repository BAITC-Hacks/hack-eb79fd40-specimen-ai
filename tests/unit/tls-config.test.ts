import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectJsonKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonKeys(item, keys);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectJsonKeys(nested, keys);
  }
}

function collectModuleNames(value: unknown, modules: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectModuleNames(item, modules);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.module === "string") modules.add(value.module);
  for (const nested of Object.values(value)) collectModuleNames(nested, modules);
}

describe("TLS branch configuration", () => {
  it("keeps the base compose app-only for an existing host proxy", async () => {
    const base = await text("docker-compose.yml");
    const hostOverlay = await text("deploy/compose.host-proxy.yml");

    expect(base).not.toMatch(/^\s{2}caddy:/mu);
    expect(base).toContain('"127.0.0.1:${APP_PORT:-3100}:3000"');
    expect(hostOverlay).toContain(
      "APP_BASE_URL: https://${DEMEU_DOMAIN-109.123.248.16}",
    );
    expect(hostOverlay).not.toMatch(/^\s{2}caddy:/mu);
  });

  it("enables Caddy only through the branch-B overlay", async () => {
    const overlay = await text("deploy/compose.caddy.yml");

    expect(overlay).toContain("ports: !reset []");
    expect(overlay).toContain("caddy:2.10.2-alpine");
    expect(overlay).toContain('"80:80"');
    expect(overlay).toContain('"443:443"');
    expect(overlay).toContain("caddy_data:/data");
    expect(overlay).toContain("caddy_config:/config");
    expect(overlay).toContain("./deploy/Caddyfile.ip:/etc/caddy/Caddyfile.ip:ro");
    expect(overlay).toContain("./deploy/Caddyfile:/etc/caddy/Caddyfile.fqdn:ro");
    expect(overlay).toContain("condition: service_healthy");
    expect(overlay).toContain('entrypoint: ["/bin/sh", "/usr/local/bin/demeu-tls"]');
    expect(overlay).toContain('command: ["caddy-run"]');
    expect(overlay).toContain("./deploy/tls.sh:/usr/local/bin/demeu-tls:ro");
    expect(overlay).not.toMatch(/3100:3000/u);
  });

  it.each([
    "109.123.248.16",
    "109-123-248-16.sslip.io",
    "109-123-248-16.nip.io",
    "demo.example.kz",
  ])(
    "validates branch-B compose for %s without rendering runtime secrets",
    async (domain) => {
      const sandbox = await mkdtemp(join(tmpdir(), "demeu-tls-config-"));
      const sentinel = "synthetic-secret-must-not-render";

      try {
        await mkdir(join(sandbox, "deploy"));
        await Promise.all([
          copyFile("docker-compose.yml", join(sandbox, "docker-compose.yml")),
          copyFile("Dockerfile", join(sandbox, "Dockerfile")),
          copyFile("deploy/compose.caddy.yml", join(sandbox, "deploy/compose.caddy.yml")),
          copyFile("deploy/Caddyfile", join(sandbox, "deploy/Caddyfile")),
          copyFile("deploy/Caddyfile.ip", join(sandbox, "deploy/Caddyfile.ip")),
          copyFile("deploy/tls.sh", join(sandbox, "deploy/tls.sh")),
          writeFile(join(sandbox, ".env"), `ANTHROPIC_API_KEY=${sentinel}\n`),
        ]);

        const { stdout, stderr } = await execFile(
          resolve("deploy/tls.sh"),
          ["branch-b-config"],
          {
            cwd: sandbox,
            env: {
              ...process.env,
              DEMEU_DOMAIN: domain,
              APP_PORT: "3100",
            },
          },
        );

        expect(stdout).toBe("");
        expect(stderr).toBe("");

        await writeFile(
          join(sandbox, "deploy/compose.caddy.yml"),
          "services:\n  app: [\n",
        );
        let malformedError: unknown;
        try {
          await execFile(resolve("deploy/tls.sh"), ["branch-b-config"], {
            cwd: sandbox,
            env: {
              ...process.env,
              DEMEU_DOMAIN: domain,
              APP_PORT: "3100",
            },
          });
        } catch (error) {
          malformedError = error;
        }

        expect(malformedError).toMatchObject({ code: expect.any(Number) });
        expect((malformedError as { code: number }).code).not.toBe(0);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "",
    "http://evil.example",
    "HTTP://109-123-248-16.sslip.io",
    "109-123-248-16.sslip.io/path",
    "109-123-248-16.sslip.io:443",
    "109-123-248-16.SSLIP.IO",
    "109-123-248-16.sslip.io.",
    "\t109-123-248-16.sslip.io",
    "109-123-248-16.sslip.io evil.example",
    "109-123-248-16.sslip.io\nmalicious",
    "109.123.248.17",
    "1.1.1.1",
    "127.1",
    "127.0.1",
    "10.1",
    "169.254",
    "192.168.1",
    "0x7f.0.0.1",
    "0x.1",
    "0x.999",
    "1.0x",
    "0x0.0x",
    "0xg.1",
    "00x1.1",
    "demo.1",
    "demo.0x",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "192.168.1.1",
    "999.999.999.999",
    "[2001:db8::1]",
    "localhost",
    "*.example.kz",
    "-demo.example.kz",
    "demo-.example.kz",
    "demo..example.kz",
    "xn--e1afmkfd.example",
    "демеу.example.kz",
    `${"a".repeat(64)}.example.kz`,
    `${Array.from({ length: 43 }, () => "aaaaa").join(".")}.kz`,
    "$(touch /tmp/demeu-domain-injection)",
  ])("rejects untrusted DEMEU_DOMAIN before any TLS command: %s", async (domain) => {
    await expect(
      execFile("deploy/tls.sh", ["preflight"], {
        env: { ...process.env, DEMEU_DOMAIN: domain },
      }),
    ).rejects.toMatchObject({ code: 64 });
  });

  it.each(["branch-a-nginx", "branch-a-caddy"])(
    "rejects the production IP on %s before any proxy command",
    async (branch) => {
      await expect(
        execFile("deploy/tls.sh", ["preflight"], {
          env: {
            ...process.env,
            DEMEU_DOMAIN: "109.123.248.16",
            TLS_BRANCH: branch,
          },
        }),
      ).rejects.toMatchObject({ code: 64 });
    },
  );

  it.each(["host-app-up", "render-nginx", "render-caddy"])(
    "rejects the production IP for direct branch-A command %s",
    async (command) => {
      await expect(
        execFile("deploy/tls.sh", [command], {
          env: {
            ...process.env,
            DEMEU_DOMAIN: "109.123.248.16",
            TLS_BRANCH: "branch-b-caddy",
          },
        }),
      ).rejects.toMatchObject({ code: 64 });
    },
  );

  it.each([
    "branch-b-config",
    "branch-b-up",
    "host-app-up",
    "render-nginx",
    "render-caddy",
    "caddy-run",
  ])("fails closed on an invalid domain before executing %s", async (command) => {
    await expect(
      execFile("deploy/tls.sh", [command], {
        env: { ...process.env, DEMEU_DOMAIN: "http://evil.example" },
      }),
    ).rejects.toMatchObject({ code: 64 });
  });

  it.each([
    "109.123.248.16",
    "109-123-248-16.sslip.io",
    "109-123-248-16.nip.io",
    "demo.example.kz",
    "triage.gov.example.kz",
  ])(
    "accepts the approved public IP or a normalized bare DNS FQDN: %s",
    async (domain) => {
      const { stdout } = await execFile("deploy/tls.sh", ["preflight"], {
        env: { ...process.env, DEMEU_DOMAIN: domain },
      });

      expect(stdout).toContain(`domain=${domain}`);
    },
  );

  it("defaults safely and rejects invalid host-proxy ports", async () => {
    const env = { ...process.env };
    delete env.DEMEU_DOMAIN;
    const { stdout } = await execFile("deploy/tls.sh", ["preflight"], { env });
    expect(stdout).toContain("domain=109.123.248.16");

    await expect(
      execFile("deploy/tls.sh", ["preflight"], {
        env: { ...env, APP_PORT: "3100;touch /tmp/demeu-port-injection" },
      }),
    ).rejects.toMatchObject({ code: 64 });
  });

  it.each(["1", "65535"])("accepts an APP_PORT boundary: %s", async (port) => {
    const { stdout } = await execFile("deploy/tls.sh", ["preflight"], {
      env: {
        ...process.env,
        DEMEU_DOMAIN: "109-123-248-16.sslip.io",
        APP_PORT: port,
      },
    });

    expect(stdout).toContain(`app_port=${port}`);
  });

  it.each([
    "",
    "0",
    "65536",
    "-1",
    "+1",
    " 3100",
    "3100 ",
    "1e3",
    "01",
    "00001",
    "3100;touch /tmp/demeu-port-injection",
    "999999999999999999999999999999999999999999999999999",
  ])("rejects an invalid APP_PORT without integer-overflow bypass: %s", async (port) => {
    await expect(
      execFile("deploy/tls.sh", ["preflight"], {
        env: {
          ...process.env,
          DEMEU_DOMAIN: "109-123-248-16.sslip.io",
          APP_PORT: port,
        },
      }),
    ).rejects.toMatchObject({ code: 64 });
  });

  it("cannot receive a NUL byte through the process environment", () => {
    expect(() =>
      execFile("deploy/tls.sh", ["preflight"], {
        env: { ...process.env, DEMEU_DOMAIN: "109-123-248-16.sslip.io\0evil" },
      }),
    ).toThrow(/without null bytes/iu);
  });

  it("uses public ACME TLS and the internal app service in branch B", async () => {
    const caddyfile = await text("deploy/Caddyfile");
    const ipCaddyfile = await text("deploy/Caddyfile.ip");

    expect(caddyfile).toContain("{$DEMEU_DOMAIN:109-123-248-16.sslip.io}");
    expect(ipCaddyfile).toContain("https://109.123.248.16");
    expect(ipCaddyfile).toContain("https://109-123-248-16.sslip.io");
    expect(ipCaddyfile).toContain("default_sni 109.123.248.16");
    expect(ipCaddyfile).toContain("profile shortlived");
    expect(ipCaddyfile).toContain("disable_tlsalpn_challenge");
    for (const config of [caddyfile, ipCaddyfile]) {
      expect(config).toContain("reverse_proxy app:3000");
      expect(config).toContain("response_header_timeout 120s");
      expect(config).toContain("read_timeout 120s");
      expect(config).toContain("Strict-Transport-Security");
      expect(config).not.toMatch(/tls\s+internal/iu);
    }
  });

  it("adapts and validates the pinned Caddy IP policy with HTTP-01 enabled", async () => {
    const mount = `${resolve("deploy/Caddyfile.ip")}:/etc/caddy/Caddyfile:ro`;
    const { stdout, stderr } = await execFile("docker", [
      "run",
      "--rm",
      "-v",
      mount,
      "caddy:2.10.2-alpine",
      "caddy",
      "adapt",
      "--validate",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ]);
    const adapted = JSON.parse(stdout) as {
      apps?: {
        http?: { servers?: Record<string, { tls_connection_policies?: unknown[] }> };
        tls?: { automation?: { policies?: unknown[] } };
      };
    };
    const server = Object.values(adapted.apps?.http?.servers ?? {})[0];
    const connectionPolicies = server?.tls_connection_policies ?? [];
    const automationPolicies = adapted.apps?.tls?.automation?.policies ?? [];
    const ipAutomationPolicy = automationPolicies.find((policy) =>
      isRecord(policy) &&
      Array.isArray(policy.subjects) &&
      JSON.stringify(policy.subjects) === JSON.stringify(["109.123.248.16"]));
    expect(connectionPolicies).toHaveLength(2);
    expect(connectionPolicies[0]).toEqual({
      match: { sni: ["", "109.123.248.16"] },
      default_sni: "109.123.248.16",
    });
    expect(connectionPolicies[1]).toEqual({
      default_sni: "109.123.248.16",
    });
    expect(isRecord(connectionPolicies[1]) && connectionPolicies[1].match).toBeUndefined();
    expect(ipAutomationPolicy).toMatchObject({
      issuers: [{
        module: "acme",
        profile: "shortlived",
        challenges: { "tls-alpn": { disabled: true } },
      }],
    });

    const adaptedText = JSON.stringify(adapted);
    expect(adaptedText).not.toContain('"http":{"disabled":true}');
    expect(adaptedText).toContain('"subjects":["109-123-248-16.sslip.io"]');
    expect(adaptedText).toContain('"host":["109-123-248-16.sslip.io"]');
    expect(adaptedText).toContain('"host":["109.123.248.16"]');
    expect(adaptedText).toContain('"dial":"app:3000"');
    expect(adaptedText).toContain('"Strict-Transport-Security"');

    const keys = new Set<string>();
    const modules = new Set<string>();
    collectJsonKeys(adapted, keys);
    collectModuleNames(adapted, modules);
    for (const forbiddenKey of [
      "fallback_sni",
      "strict_sni_host",
      "default_bind",
      "load_files",
      "load_pem",
      "certificate_loader",
    ]) {
      expect(keys.has(forbiddenKey)).toBe(false);
    }
    expect(keys.has("certificates")).toBe(false);
    expect(modules.has("internal")).toBe(false);
    expect(stderr).toContain("enabling automatic HTTP->HTTPS redirects");
  });

  it("renders host proxy templates to loopback with 120-second timeouts", async () => {
    const nginx = await text("deploy/nginx/demeu.conf.template");
    const caddy = await text("deploy/Caddyfile.host.template");

    expect(nginx).toContain("server_name ${DEMEU_DOMAIN}");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:${APP_PORT}");
    expect(nginx).toContain("proxy_read_timeout 120s");
    expect(nginx).toContain("proxy_send_timeout 120s");
    expect(nginx).toMatch(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/);
    expect(nginx).not.toContain("$proxy_add_x_forwarded_for");
    expect(nginx).toContain("Strict-Transport-Security");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:${APP_PORT}");
    expect(caddy).toContain("response_header_timeout 120s");
    expect(caddy).not.toContain("app:3000");
  });

  it("keeps the IP canonical and supports an FQDN rollback without insecure production flags", async () => {
    const overlay = await text("deploy/compose.caddy.yml");
    const instructions = await text("deploy/TLS.md");
    const productionFiles = [
      overlay,
      await text("deploy/compose.host-proxy.yml"),
      await text("deploy/Caddyfile"),
      await text("deploy/Caddyfile.ip"),
      await text("deploy/nginx/demeu.conf.template"),
      await text("deploy/Caddyfile.host.template"),
      instructions,
    ].join("\n");

    expect(overlay).toContain("APP_BASE_URL: https://${DEMEU_DOMAIN-109.123.248.16}");
    expect(instructions).toContain("DEMEU_DOMAIN=109.123.248.16");
    expect(instructions).toContain("./deploy/tls.sh branch-b-config");
    expect(instructions).toContain("./deploy/tls.sh branch-b-up");
    expect(instructions).toContain("./deploy/tls.sh host-app-up");
    expect(instructions).toContain("./deploy/tls.sh render-nginx");
    expect(instructions).toContain("./deploy/tls.sh render-caddy");
    expect(instructions).not.toMatch(/^docker compose -f docker-compose\.yml/mu);
    expect(instructions).not.toMatch(/^envsubst /mu);
    expect(instructions).toContain("default_sni 109.123.248.16");
    expect(instructions).toContain("**не проверены**");
    expect(productionFiles).not.toMatch(/(?:^|\s)-k(?:\s|$)/mu);
    expect(productionFiles).not.toMatch(/tls\s+internal/iu);
    expect(productionFiles).not.toMatch(/hermes/iu);
  });
});
