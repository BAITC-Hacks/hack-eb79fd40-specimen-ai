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

describe("TLS branch configuration", () => {
  it("keeps the base compose app-only for an existing host proxy", async () => {
    const base = await text("docker-compose.yml");
    const hostOverlay = await text("deploy/compose.host-proxy.yml");

    expect(base).not.toMatch(/^\s{2}caddy:/mu);
    expect(base).toContain('"127.0.0.1:${APP_PORT:-3100}:3000"');
    expect(hostOverlay).toContain(
      "APP_BASE_URL: https://${DEMEU_DOMAIN-109-123-248-16.sslip.io}",
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
    expect(overlay).toContain("condition: service_healthy");
    expect(overlay).toContain('entrypoint: ["/bin/sh", "/usr/local/bin/demeu-tls"]');
    expect(overlay).toContain('command: ["caddy-run"]');
    expect(overlay).toContain("./deploy/tls.sh:/usr/local/bin/demeu-tls:ro");
    expect(overlay).not.toMatch(/3100:3000/u);
  });

  it.each(["109-123-248-16.sslip.io", "109-123-248-16.nip.io"])(
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
    "sub.109-123-248-16.sslip.io",
    "\t109-123-248-16.sslip.io",
    "109-123-248-16.sslip.io evil.example",
    "109-123-248-16.sslip.io\nmalicious",
    "evil.example",
    "109.123.248.16",
    "$(touch /tmp/demeu-domain-injection)",
  ])("rejects untrusted DEMEU_DOMAIN before any TLS command: %s", async (domain) => {
    await expect(
      execFile("deploy/tls.sh", ["preflight"], {
        env: { ...process.env, DEMEU_DOMAIN: domain },
      }),
    ).rejects.toMatchObject({ code: 64 });
  });

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

  it.each(["109-123-248-16.sslip.io", "109-123-248-16.nip.io"])(
    "accepts the documented bare magic-DNS hostname: %s",
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
    expect(stdout).toContain("domain=109-123-248-16.sslip.io");

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

    expect(caddyfile).toContain("{$DEMEU_DOMAIN:109-123-248-16.sslip.io}");
    expect(caddyfile).toContain("reverse_proxy app:3000");
    expect(caddyfile).toContain("response_header_timeout 120s");
    expect(caddyfile).toContain("read_timeout 120s");
    expect(caddyfile).toContain("Strict-Transport-Security");
    expect(caddyfile).not.toMatch(/tls\s+internal/iu);
  });

  it("renders host proxy templates to loopback with 120-second timeouts", async () => {
    const nginx = await text("deploy/nginx/demeu.conf.template");
    const caddy = await text("deploy/Caddyfile.host.template");

    expect(nginx).toContain("server_name ${DEMEU_DOMAIN}");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:${APP_PORT}");
    expect(nginx).toContain("proxy_read_timeout 120s");
    expect(nginx).toContain("proxy_send_timeout 120s");
    expect(nginx).toContain("Strict-Transport-Security");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:${APP_PORT}");
    expect(caddy).toContain("response_header_timeout 120s");
    expect(caddy).not.toContain("app:3000");
  });

  it("switches sslip to nip through one persisted setting without insecure production flags", async () => {
    const overlay = await text("deploy/compose.caddy.yml");
    const instructions = await text("deploy/TLS.md");
    const productionFiles = [
      overlay,
      await text("deploy/compose.host-proxy.yml"),
      await text("deploy/Caddyfile"),
      await text("deploy/nginx/demeu.conf.template"),
      await text("deploy/Caddyfile.host.template"),
      instructions,
    ].join("\n");

    expect(overlay).toContain("APP_BASE_URL: https://${DEMEU_DOMAIN-109-123-248-16.sslip.io}");
    expect(instructions).toContain("DEMEU_DOMAIN=109-123-248-16.nip.io");
    expect(instructions).toContain("./deploy/tls.sh branch-b-config");
    expect(instructions).toContain("./deploy/tls.sh branch-b-up");
    expect(instructions).toContain("./deploy/tls.sh host-app-up");
    expect(instructions).toContain("./deploy/tls.sh render-nginx");
    expect(instructions).toContain("./deploy/tls.sh render-caddy");
    expect(instructions).not.toMatch(/^docker compose -f docker-compose\.yml/mu);
    expect(instructions).not.toMatch(/^envsubst /mu);
    expect(instructions).toContain("не проверены");
    expect(productionFiles).not.toMatch(/(?:^|\s)-k(?:\s|$)/mu);
    expect(productionFiles).not.toMatch(/tls\s+internal/iu);
    expect(productionFiles).not.toMatch(/hermes/iu);
  });
});
