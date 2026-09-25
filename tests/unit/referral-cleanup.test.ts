import { execFile } from "node:child_process";
import filesystem, { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertSnapshotSha,
  cleanupInstallationCheck,
  INSTALLATION_CHECK_REFERRAL_ID,
  snapshotSha256,
  writeProtected,
  type AtomicFileOperations,
} from "../../scripts/cleanup-referrals-snapshot";
import type { Referral, ReferralDatabase, ReferralFacts } from "../../lib/referrals/types";

const run = promisify(execFile);
const facts: ReferralFacts = {
  profile: "Хирургический", icd10Code: null, specialistReferred: null,
  preparationStarted: true, destinationOrganization: null, sent: null,
  queue: null, scheduledDate: null, attendance: null, cancelled: false,
};

function referral(id: string): Referral {
  return {
    id, organizationId: "demeu-team", doctorId: "doctor", patientLabel: `Эпизод ${id}`,
    sourceSessionId: null, triageSnapshot: null, ...facts,
    createdAt: 1, updatedAt: 1, revision: 1, examinations: [],
    events: [{ id: `event-${id}`, type: "created", actorId: "doctor", actorName: "Врач",
      source: "doctor_confirmation", occurredAt: null, recordedAt: 1, reason: null,
      before: null, after: facts, revision: 1 }],
  };
}

function database(): ReferralDatabase {
  const keep = referral("keep-referral");
  const remove = referral(INSTALLATION_CHECK_REFERRAL_ID);
  return {
    schemaVersion: 2, referrals: [remove, keep], links: [],
    commands: [
      { actorId: "doctor", organizationId: "demeu-team", key: "create-installation", payload: "{}", referralId: remove.id },
      { actorId: "doctor", organizationId: "demeu-team", key: "create-keep", payload: "{}", referralId: keep.id },
    ],
  };
}

describe("referral installation-check cleanup", () => {
  it("removes only the exact referral and every command that would otherwise invalidate the snapshot", () => {
    const result = cleanupInstallationCheck(database());
    expect(result).toMatchObject({ changed: true, removedReferrals: 1, removedCommands: 1 });
    expect(result.snapshot.referrals.map((entry) => entry.id)).toEqual(["keep-referral"]);
    expect(result.snapshot.commands.map((entry) => entry.referralId)).toEqual(["keep-referral"]);
  });

  it("is idempotent after the exact record has already been removed", () => {
    const first = cleanupInstallationCheck(database());
    const second = cleanupInstallationCheck(first.snapshot);
    expect(second).toMatchObject({ changed: false, removedReferrals: 0, removedCommands: 0 });
    expect(second.snapshot).toEqual(first.snapshot);
  });

  it("fails closed before cleanup when the input snapshot is invalid", () => {
    const invalid = database();
    invalid.commands.push({ actorId: "doctor", organizationId: "demeu-team", key: "orphan", payload: "{}", referralId: "missing" });
    expect(() => cleanupInstallationCheck(invalid)).toThrow("Invalid referral snapshot");
  });

  it("requires an exact SHA binding", () => {
    const bytes = Buffer.from(JSON.stringify(database()));
    const hash = snapshotSha256(bytes);
    expect(assertSnapshotSha(bytes, hash)).toBe(hash);
    expect(() => assertSnapshotSha(bytes, "0".repeat(64))).toThrow("does not match");
    expect(() => assertSnapshotSha(bytes, "bad")).toThrow("64 lowercase");
  });

  it("dry-runs without changing the input and writes a protected validated candidate only when requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-referral-cleanup-"));
    const input = join(directory, "referrals.json");
    const output = join(directory, "candidate.json");
    const bytes = Buffer.from(JSON.stringify(database()));
    await writeFile(input, bytes, { mode: 0o600 });
    const command = join(process.cwd(), "scripts/cleanup-referrals-snapshot.ts");
    const loader = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
    const hash = snapshotSha256(bytes);

    const dry = await run(process.execPath, ["--import", loader, command, "--input", input, "--expect-sha256", hash]);
    expect(JSON.parse(dry.stdout)).toMatchObject({ mode: "dry_run", changed: true, output_written: false });
    expect(await readFile(input)).toEqual(bytes);

    const applied = await run(process.execPath, ["--import", loader, command, "--input", input, "--expect-sha256", hash, "--output", output]);
    expect(JSON.parse(applied.stdout)).toMatchObject({ mode: "candidate_written", removed_referrals: 1, removed_commands: 1, output_written: true });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(cleanupInstallationCheck(JSON.parse(await readFile(output, "utf8"))).changed).toBe(false);
  }, 15_000);

  it("does not replace an existing candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-referral-cleanup-existing-"));
    const output = join(directory, "candidate.json");
    await writeFile(output, "keep", { mode: 0o600 });

    await expect(writeProtected(output, Buffer.from("replacement"))).rejects.toThrow("already exists");
    expect(await readFile(output, "utf8")).toBe("keep");
  });

  it("cleans an interrupted partial temporary write without exposing a candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-referral-cleanup-interrupted-"));
    const output = join(directory, "candidate.json");
    const interrupted: AtomicFileOperations = {
      lstat: (path) => filesystem.lstat(path),
      rename: (from, to) => filesystem.rename(from, to),
      unlink: (path) => filesystem.unlink(path),
      open: async (path, flags, mode) => {
        const handle = await filesystem.open(path, flags, mode);
        if (!path.endsWith(".tmp")) return handle;
        return {
          writeFile: async (bytes) => {
            await handle.writeFile(bytes.subarray(0, Math.min(8, bytes.byteLength)));
            throw new Error("simulated interrupted write");
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };

    await expect(writeProtected(output, Buffer.from("complete candidate"), interrupted)).rejects.toThrow("interrupted");
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes the renamed candidate when the directory durability step fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-referral-cleanup-sync-"));
    const output = join(directory, "candidate.json");
    const failedDirectorySync: AtomicFileOperations = {
      lstat: (path) => filesystem.lstat(path),
      rename: (from, to) => filesystem.rename(from, to),
      unlink: (path) => filesystem.unlink(path),
      open: async (path, flags, mode) => {
        const handle = await filesystem.open(path, flags, mode);
        if (path !== directory) return handle;
        return {
          writeFile: (bytes) => handle.writeFile(bytes),
          sync: async () => { throw new Error("simulated directory sync failure"); },
          close: () => handle.close(),
        };
      },
    };

    await expect(writeProtected(output, Buffer.from("complete candidate"), failedDirectorySync)).rejects.toThrow("directory sync");
    expect(await readdir(directory)).toEqual([]);
  });
});
