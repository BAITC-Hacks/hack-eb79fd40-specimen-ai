import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";

describe("session singleton configuration", () => {
  it("requires restart for memory/file transitions or a different volume, but allows equivalent paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-store-mode-"));
    const modulePath = resolve("lib/store.ts");
    const run = async (script: string) => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { store } from ${JSON.stringify(modulePath)};
      delete process.env.DEMEU_AUTH_SECRET; delete process.env.DEMEU_ACCOUNTS_FILE;
      ${script}
    `]);
    try {
      await run(`
        delete process.env.DEMEU_DATA_DIR;
        const original = store(); assert.equal(store(), original);
        process.env.DEMEU_DATA_DIR = ${JSON.stringify(directory)};
        assert.throws(() => store(), /restart required/);
      `);
      await run(`
        process.env.DEMEU_DATA_DIR = ${JSON.stringify(directory)};
        const original = store(); await original.createDoctorToken();
        process.env.DEMEU_DATA_DIR += "/.";
        assert.equal(store(), original);
        process.env.DEMEU_DATA_DIR += "/another";
        assert.throws(() => store(), /restart required/);
        delete process.env.DEMEU_DATA_DIR;
        assert.throws(() => store(), /restart required/);
        await original.close();
      `);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
