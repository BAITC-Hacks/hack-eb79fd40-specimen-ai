import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotFilter } from "../../scripts/e2e-mock.mjs";

const ROOT = resolve(".");
const ENV_VARIANTS = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test.local",
  ".env.custom",
  ".env.secrets",
] as const;

function sourceFilter(source: string): boolean {
  const path = relative(ROOT, source);
  if (!path) return true;
  const parts = path.split(sep);
  if ([".git", ".next", "node_modules", ".venv", ".orchestrator"].includes(parts[0])) {
    return false;
  }
  if (parts.some((part) => part.startsWith(".env") && part !== ".env.example")) {
    return false;
  }
  return !(parts[0] === "data" && ["raw", "processed", "runtime"].includes(parts[1]));
}

function run(command: string, args: string[], cwd: string): Promise<{
  code: number | null;
  output: string;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, E2E_FORCE_FAILURE: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => resolveRun({ code, output }));
  });
}

describe("mock E2E snapshot environment isolation", () => {
  it("keeps only .env.example and never attempts Telegram delivery with sentinel secrets", {
    timeout: 300_000,
  }, async () => {
    for (const name of ENV_VARIANTS) {
      expect(snapshotFilter(join(ROOT, name))).toBe(false);
      expect(snapshotFilter(join(ROOT, "nested", name))).toBe(false);
    }
    expect(snapshotFilter(join(ROOT, ".env.example"))).toBe(true);

    const source = await mkdtemp(join(tmpdir(), "demeu-e2e-env-source-"));
    try {
      await cp(ROOT, source, { recursive: true, filter: sourceFilter });
      await symlink(join(ROOT, "node_modules"), join(source, "node_modules"), "dir");
      const sentinel = [
        "TELEGRAM_BOT_TOKEN=sentinel-telegram-token",
        "TELEGRAM_DOCTOR_CHAT_IDS=111111111,222222222",
        "TELEGRAM_DOCTOR_CHAT_ID=sentinel-chat-id",
        "DOCTOR_ACCESS_CODE=sentinel-access-code",
        "",
      ].join("\n");
      await Promise.all(
        ENV_VARIANTS.map((name) => writeFile(join(source, name), sentinel, "utf8")),
      );

      const result = await run(
        process.execPath,
        [join(source, "scripts/e2e-mock.mjs")],
        source,
      );

      expect(result.code, result.output).toBe(0);
      expect(result.output).not.toContain("E2E_EXTERNAL_FETCH_BLOCKED");
      expect(result.output).toContain("scenario-1-chest-pain provenance=mock");
      expect(result.output).toContain("scenario-2-back-pain provenance=mock");
      expect(result.output).toContain("scenario-3-rhinitis provenance=mock");
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});
