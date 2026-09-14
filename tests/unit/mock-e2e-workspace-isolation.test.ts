import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedMockEnv, snapshotFilter } from "../../scripts/e2e-mock.mjs";

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
});
