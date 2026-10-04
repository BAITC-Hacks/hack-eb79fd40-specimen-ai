import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("finalization integrated mock flow", () => {
  it("crosses the patient, doctor, B3, MIS, aggregate and restart boundaries without external services", async () => {
    const child = spawn(process.execPath, [resolve("scripts/finalization-smoke.mjs")], {
      cwd: resolve("."), detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
        NODE_ENV: "test", FINALIZATION_SMOKE_TEST: "1" },
    });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-20_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const watchdog = setTimeout(() => {
      if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      }, 8_000).unref();
    }, 290_000);
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    clearTimeout(watchdog);
    expect({ code, signal, output }).toMatchObject({ code: 0, signal: null });
    const resultLine = output.split(/\r?\n/u).find((line) => line.startsWith("FINALIZATION_SMOKE_RESULT "));
    expect(resultLine).toBeTruthy();
    const result = JSON.parse(resultLine!.slice("FINALIZATION_SMOKE_RESULT ".length));
    expect(result).toMatchObject({
      ok: true,
      processingMode: "deterministic",
      anthropicRequestUpperBound: 0,
      languages: ["ru", "kk"],
      emergency: true,
      clinicianConfirmed: true,
      patientPdfLanguages: 2,
      riskStatus: "available",
      openapiExact: true,
      isolation: { privateSnapshot: true, privateStorage: true, externalFetchBlocked: false },
      restart: { misAckNoRedelivery: true, telegramNoDuplicate: true, sourceExpiredPackageRetained: true },
    });
    expect(result.patientReports).toBeGreaterThanOrEqual(2);
    expect(result.aggregateVisibleGroups).toBeGreaterThanOrEqual(1);
    expect(result.misSequence).toBeGreaterThanOrEqual(1);
    expect(output).not.toMatch(/sk-ant-|api\.telegram\.org|\/api\/chat\/[^\s]+|[0-9a-f]{8}-[0-9a-f-]{27}|DemeuDemo2026/iu);
  }, 300_000);
});
