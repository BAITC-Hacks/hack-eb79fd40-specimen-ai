import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const IMAGE = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];

async function fixture(snapshot?: string): Promise<{ root: string; data: string; marker: string }> {
  const root = await mkdtemp(join(tmpdir(), "demeu-rootless-recovery-"));
  directories.push(root);
  const bin = join(root, "bin");
  const data = join(root, "container-visible-data");
  const marker = join(root, "marker");
  await Promise.all([mkdir(bin), mkdir(data), writeFile(marker, "2\n")]);
  if (snapshot !== undefined) await writeFile(join(data, "referrals.json"), snapshot);
  await writeFile(join(bin, "docker"), `#!/bin/sh
set -eu
[ "\${1-}" = run ] || exit 2
while [ "\${1-}" != -e ]; do shift; done
shift
code="$1"
exec node -e "$code" "$STUB_MARKER" "$STUB_CONTAINER_DATA" "\${STUB_EXPLICIT_SCHEMA-}"
`);
  await chmod(join(bin, "docker"), 0o755);
  return { root, data, marker };
}

async function probe(
  value: Awaited<ReturnType<typeof fixture>>,
  explicitSchema = "",
): Promise<{ code: number; stderr: string }> {
  try {
    await execFile("bash", ["-c", `set -Eeuo pipefail
env_value() { [ "$1" = DEMEU_HOST_DATA_DIR ] && printf '%s' /opaque/rootless-owned-data; }
die() { return 1; }
source deploy/recovery-guards.sh
assert_recovery_image_compatible '${IMAGE}' '${explicitSchema}'
`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${join(value.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        STUB_CONTAINER_DATA: value.data,
        STUB_MARKER: value.marker,
        STUB_EXPLICIT_SCHEMA: explicitSchema,
      },
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rootless recovery snapshot proof", () => {
  it("does not treat a host-inaccessible path as an absent snapshot", async () => {
    const value = await fixture('{"schemaVersion":6,"referrals":[],"links":[],"commands":[]}');
    expect((await probe(value)).code).not.toBe(0);
  });

  it("accepts absence only when the exact-image probe observes ENOENT", async () => {
    const value = await fixture();
    await rm(value.marker);
    expect(await probe(value)).toEqual({ code: 0, stderr: "" });
  });

  it.each([
    ["malformed trailing bytes", '{"schemaVersion":2,"referrals":[]}broken'],
    ["future schema", '{"schemaVersion":7,"referrals":[]}'],
    ["non-object document", "[]"],
  ])("fails closed on %s visible only to the image", async (_label, snapshot) => {
    const value = await fixture(snapshot);
    expect((await probe(value)).code).not.toBe(0);
  });

  it("rejects a snapshot symlink inside the mounted directory", async () => {
    const value = await fixture();
    const target = join(value.root, "target.json");
    await writeFile(target, '{"schemaVersion":2,"referrals":[]}');
    await symlink(target, join(value.data, "referrals.json"));
    expect((await probe(value)).code).not.toBe(0);
  });
});
