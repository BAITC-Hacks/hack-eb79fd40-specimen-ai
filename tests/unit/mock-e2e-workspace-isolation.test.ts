import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isolatedMockEnv, snapshotFilter } from "../../scripts/e2e-mock.mjs";
import { allocateFinalizationResources, finalizationSnapshotFilter, isolatedFinalizationEnv, spawnFinalizationCaptured, stopFinalizationProcess } from "../../scripts/finalization-smoke.mjs";

describe("mock E2E workspace isolation", () => {
  it("never snapshots local operational patient storage while keeping runtime model assets", () => {
    const root = "/isolated-source";
    for (const path of ["data/runtime", "data/runtime/referrals.json", "data/runtime/sessions.json", "data/runtime/deliveries.json", "data/raw", "data/processed"]) {
      expect(snapshotFilter(join(root, path), root)).toBe(false);
    }
    for (const path of ["data/pathology_map.json", "data/evidences_ru.json", "data/examination_requirements.json", "models/triage-lr-v1.json", ".env.example"]) {
      expect(snapshotFilter(join(root, path), root)).toBe(true);
    }
  });
  it("removes workspace configuration from both build and inherited app environment without mutating the parent", () => {
    const parent = {
      DEMEU_DATA_DIR: "/never-open-real-storage", DEMEU_ACCOUNTS_FILE: "/never-read-accounts.json", DEMEU_AUTH_SECRET: "sentinel-not-a-secret",
      DOCTOR_ACCESS_CODE: "sentinel", TELEGRAM_BOT_TOKEN: "sentinel", TELEGRAM_DOCTOR_CHAT_ID: "sentinel", TELEGRAM_DOCTOR_CHAT_IDS: "sentinel",
      ANTHROPIC_AUTH_TOKEN: "sentinel", PATH: "/usr/bin", NODE_OPTIONS: "--inspect",
    };
    const isolated = isolatedMockEnv(parent, "--import=/tmp/snapshot/e2e-fetch-guard.mjs");
    const app = { ...isolated, ANTHROPIC_API_KEY: "local-mock-key" };
    for (const key of ["DEMEU_DATA_DIR", "DEMEU_ACCOUNTS_FILE", "DEMEU_AUTH_SECRET", "DOCTOR_ACCESS_CODE", "TELEGRAM_BOT_TOKEN", "TELEGRAM_DOCTOR_CHAT_ID", "TELEGRAM_DOCTOR_CHAT_IDS", "ANTHROPIC_AUTH_TOKEN"]) {
      expect(isolated).not.toHaveProperty(key);
      expect(app).not.toHaveProperty(key);
      expect(parent).toHaveProperty(key);
    }
    expect(isolated.PATH).toBe("/usr/bin");
    expect(isolated.NODE_OPTIONS).toBe("--import=/tmp/snapshot/e2e-fetch-guard.mjs");
    expect(parent.NODE_OPTIONS).toBe("--inspect");
  });
  it("also removes empty defined workspace values because they enable fail-closed mode", () => {
    const isolated = isolatedMockEnv({ DEMEU_DATA_DIR: "", DEMEU_ACCOUNTS_FILE: "", DEMEU_AUTH_SECRET: "" }, "--import=guard");
    expect(Object.keys(isolated).some((key) => key.startsWith("DEMEU_"))).toBe(false);
  });
  it("uses an allowlisted finalization snapshot with no operational or tool state", () => {
    const root = "/isolated-source";
    for (const path of [".git/config", ".next/cache", ".unlazy/plan.md", ".playwright-mcp/state", ".worktrees/other", ".env", ".env.production", "data/raw/a.parquet", "data/processed/a.json", "data/runtime/referrals.json", "models/private.joblib", "README.md"]) {
      expect(finalizationSnapshotFilter(join(root, path), root), path).toBe(false);
    }
    for (const path of ["app/api/healthz/route.ts", "lib/store.ts", "data/pathology_map.json", "models/triage-lr-v1.json", "reports/referral-risk-parity.json", "eval/report.json", ".env.example"]) {
      expect(finalizationSnapshotFilter(join(root, path), root), path).toBe(true);
    }
  });
  it("builds finalization child environments from a small host allowlist", () => {
    const parent = {
      PATH: "/usr/bin", HOME: "/tmp/home", LANG: "C.UTF-8", NODE_ENV: "test" as const, NODE_OPTIONS: "--inspect",
      ANTHROPIC_API_KEY: "sentinel", ANTHROPIC_BASE_URL: "https://external.invalid",
      TELEGRAM_BOT_TOKEN: "sentinel", DEMEU_DATA_DIR: "/real", DEMEU_ACCOUNTS_FILE: "/real/accounts.json",
      DEMEU_AUTH_SECRET: "sentinel", DEMEU_MIS_CREDENTIALS_FILE: "/real/mis.json", DEMEU_MIS_RESEARCH_EVENTS: "sentinel",
    };
    const isolated = isolatedFinalizationEnv(parent, { NODE_OPTIONS: "--import=/private/guard.mjs", DEMEU_PROCESSING_MODE: "deterministic" });
    expect(isolated).toEqual({ PATH: "/usr/bin", HOME: "/tmp/home", LANG: "C.UTF-8", NEXT_TELEMETRY_DISABLED: "1", CI: "1",
      NODE_OPTIONS: "--import=/private/guard.mjs", DEMEU_PROCESSING_MODE: "deterministic" });
    expect(parent.ANTHROPIC_API_KEY).toBe("sentinel");
  });
  it("awaits SIGKILL escalation for a process group that ignores SIGTERM", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      detached: true, stdio: "ignore",
    });
    await new Promise((resolveReady) => setTimeout(resolveReady, 50));
    await stopFinalizationProcess({ label: "forced-stop", child, tail: () => "" });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  }, 12_000);
  it("retains a blocked-fetch verdict after the bounded log tail rolls over", async () => {
    const processInfo = spawnFinalizationCaptured("marker", process.execPath, ["-e",
      "process.stdout.write('DEMEU_FINALIZATION_EXTERNAL_FETCH_' + 'BLOCKED https://blocked.invalid\\n'); process.stdout.write('x'.repeat(40000))"],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolveExit) => processInfo.child.once("exit", resolveExit));
    expect(processInfo.tail()).not.toContain("DEMEU_FINALIZATION_EXTERNAL_FETCH_BLOCKED");
    expect(processInfo.externalFetchBlocked()).toBe(true);
  });
  it("removes the first private directory when a later allocation fails", async () => {
    const removed: string[] = []; let attempt = 0;
    await expect(allocateFinalizationResources({
      makeTemp: async () => { attempt += 1; if (attempt === 2) throw new Error("forced"); return "/tmp/private-first"; },
      remove: async (path: string) => { removed.push(path); },
      findPort: async () => 1,
    })).rejects.toThrow("forced");
    expect(removed).toEqual(["/tmp/private-first"]);
  });
});
