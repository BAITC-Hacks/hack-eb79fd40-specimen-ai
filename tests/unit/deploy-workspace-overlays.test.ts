import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scripts = ["deploy/deploy.sh", "deploy/rollback.sh"] as const;

describe("workspace-aware release scripts", () => {
  for (const filename of scripts) {
    it(`${filename} preserves persistent workspace and current ingress overlays`, async () => {
      const source = await readFile(filename, "utf8");
      const proxy = source.indexOf("deploy/compose.caddy.yml");
      const workspace = source.indexOf("COMPOSE_ARGS+=(-f deploy/compose.workspace.yml)");
      const ingress = source.indexOf("COMPOSE_ARGS+=(-f deploy/compose.new-server-ip.yml)");

      expect(proxy).toBeGreaterThan(-1);
      expect(workspace).toBeGreaterThan(proxy);
      expect(ingress).toBeGreaterThan(workspace);
      expect(source).toContain('CURRENT_PRODUCTION_DOMAIN="84.247.161.211"');
      expect(source).toContain('docker compose "${COMPOSE_ARGS[@]}" config --quiet');
    });

    it(`${filename} gates release health on the workspace and anonymous auth bootstrap`, async () => {
      const source = await readFile(filename, "utf8");

      expect(source).toContain("demeu-workspace-health:v1");
      expect(source).toContain('fetch("http://127.0.0.1:3000/workspace", { redirect: "manual" })');
      expect(source).toContain('fetch("http://127.0.0.1:3000/api/workspace/auth")');
      expect(source).toContain('auth.enabled === true');
      expect(source).toContain('auth.actor === null');
    });
  }
});
