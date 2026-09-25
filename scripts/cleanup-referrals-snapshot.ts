import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import filesystem from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReferralDatabase } from "../lib/referrals/service";
import type { ReferralDatabase } from "../lib/referrals/types";

export const INSTALLATION_CHECK_REFERRAL_ID = "2e2d9e10-e4a2-46e3-9119-3b8b1d55db34";
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface CleanupResult {
  snapshot: ReferralDatabase;
  changed: boolean;
  removedReferrals: number;
  removedCommands: number;
}

export function snapshotSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertSnapshotSha(bytes: Uint8Array, expectedSha256: string): string {
  const expected = expectedSha256.trim().toLowerCase();
  if (!SHA256.test(expected)) throw new Error("Expected SHA-256 must contain exactly 64 lowercase hexadecimal characters");
  const actual = snapshotSha256(bytes);
  if (actual !== expected) throw new Error("Referral snapshot SHA-256 does not match the expected value");
  return actual;
}

export function cleanupInstallationCheck(
  value: unknown,
  referralId = INSTALLATION_CHECK_REFERRAL_ID,
): CleanupResult {
  const current = validateReferralDatabase(value);
  const matches = current.referrals.filter((referral) => referral.id === referralId);
  if (matches.length > 1) throw new Error("Synthetic referral ID is not unique");
  if (matches.length === 0) {
    return { snapshot: current, changed: false, removedReferrals: 0, removedCommands: 0 };
  }
  const removedCommands = current.commands.filter((command) => command.referralId === referralId).length;
  const candidate: ReferralDatabase = {
    ...structuredClone(current),
    referrals: current.referrals.filter((referral) => referral.id !== referralId),
    commands: current.commands.filter((command) => command.referralId !== referralId),
  };
  return {
    snapshot: validateReferralDatabase(candidate),
    changed: true,
    removedReferrals: 1,
    removedCommands,
  };
}

interface CliOptions { input: string; expectedSha256: string; output?: string }

function usage(): never {
  throw new Error("Usage: cleanup-referrals-snapshot --input FILE --expect-sha256 SHA256 [--output NEW_FILE]");
}

function parseArgs(args: readonly string[]): CliOptions {
  let input = "";
  let expectedSha256 = "";
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usage();
    if (key === "--input" && !input) input = value;
    else if (key === "--expect-sha256" && !expectedSha256) expectedSha256 = value;
    else if (key === "--output" && output === undefined) output = value;
    else usage();
    index += 1;
  }
  if (!input || !expectedSha256) usage();
  if (output && resolve(output) === resolve(input)) throw new Error("Output must be a new file, not the source snapshot");
  return { input, expectedSha256, ...(output ? { output } : {}) };
}

async function readSnapshot(path: string): Promise<Buffer> {
  const info = await filesystem.stat(path);
  if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) throw new Error("Invalid snapshot size or file type");
  const bytes = await filesystem.readFile(path);
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot size limit exceeded");
  return bytes;
}

interface AtomicHandle {
  writeFile(data: Uint8Array): Promise<unknown>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface AtomicFileOperations {
  lstat(path: string): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<AtomicHandle>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

export async function writeProtected(
  path: string,
  bytes: Buffer,
  operations: AtomicFileOperations = filesystem as AtomicFileOperations,
): Promise<void> {
  const destination = resolve(path);
  try {
    await operations.lstat(destination);
    throw new Error("Output file already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await operations.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await operations.rename(temporary, destination);
    renamed = true;
    const directory = await operations.open(dirname(destination), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (renamed) await operations.unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    if (!renamed) await operations.unlink(temporary).catch(() => undefined);
  }
}

export async function runCleanupCli(args: readonly string[]): Promise<Record<string, unknown>> {
  const options = parseArgs(args);
  const bytes = await readSnapshot(options.input);
  const inputSha256 = assertSnapshotSha(bytes, options.expectedSha256);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const result = cleanupInstallationCheck(parsed);
  const outputBytes = Buffer.from(`${JSON.stringify(result.snapshot)}\n`, "utf8");
  const outputSha256 = snapshotSha256(outputBytes);
  if (options.output) await writeProtected(options.output, outputBytes);
  return {
    mode: options.output ? "candidate_written" : "dry_run",
    changed: result.changed,
    removed_referrals: result.removedReferrals,
    removed_commands: result.removedCommands,
    input_sha256: inputSha256,
    output_sha256: outputSha256,
    output_written: Boolean(options.output),
  };
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  runCleanupCli(process.argv.slice(2))
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Cleanup failed"}\n`);
      process.exitCode = 1;
    });
}
