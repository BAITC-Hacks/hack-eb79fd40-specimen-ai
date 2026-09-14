import { execFile } from "node:child_process";
import filesystem from "node:fs/promises";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileState } from "../../lib/storage/file-state";

interface Counter { schema_version: 1; count: number }
function validate(value: unknown): Counter {
  if (typeof value !== "object" || value === null ||
      !("schema_version" in value) || value.schema_version !== 1 ||
      !("count" in value) || !Number.isSafeInteger(value.count)) {
    throw new Error("Invalid counter snapshot");
  }
  return value as Counter;
}

const directories: string[] = [];
const instances: FileState<Counter>[] = [];
async function fixture(maxBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), "demeu-state-"));
  directories.push(directory);
  const path = join(directory, "counter.json");
  const open = () => {
    const state = new FileState({ path, initial: () => ({ schema_version: 1 as const, count: 0 }), validate, maxBytes });
    instances.push(state);
    return state;
  };
  return { directory, path, open };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(instances.splice(0).map((state) => state.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("durable file state", () => {
  it("persists private snapshots, serializes concurrent updates and reopens", async () => {
    const { path, open } = await fixture();
    const first = open();
    await Promise.all(Array.from({ length: 20 }, () => first.transaction(async (draft) => {
      const previous = draft.count;
      await Promise.resolve();
      draft.count = previous + 1;
    })));
    expect(await first.read((state) => state.count)).toBe(20);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await first.close();
    expect(await open().read((state) => state.count)).toBe(20);
  });

  it("isolates reads, callback references and return values", async () => {
    const { open } = await fixture();
    const state = open();
    const result = await state.transaction((draft) => { draft.count = 2; return draft; });
    result.count = 100;
    const snapshot = await state.read((value) => value);
    (snapshot as Counter).count = 200;
    expect(await state.read((value) => value.count)).toBe(2);
  });

  it("rolls back a rejected operation and continues with the committed state", async () => {
    const { open } = await fixture();
    const state = open();
    await expect(state.transaction((draft) => { draft.count = 9; throw new Error("stop"); })).rejects.toThrow("stop");
    expect(await state.read((value) => value.count)).toBe(0);
    await state.transaction((draft) => { draft.count = 1; });
    expect(await state.read((value) => value.count)).toBe(1);
  });

  it("does not expose a mutation when writing the snapshot fails", async () => {
    const { directory, open } = await fixture();
    const state = open();
    await state.read((value) => value);
    const moved = `${directory}-moved`;
    directories.push(moved);
    await rename(directory, moved);
    await expect(state.transaction((draft) => { draft.count = 1; })).rejects.toThrow();
    expect(await state.read((value) => value.count)).toBe(0);
    await rename(moved, directory);
    await state.transaction((draft) => { draft.count = 2; });
    expect(await state.read((value) => value.count)).toBe(2);
  });

  it("fails closed after an uncertain directory sync and recovers by reopening", async () => {
    const { directory, open } = await fixture();
    const state = open();
    await state.read((value) => value);
    const originalOpen = filesystem.open;
    vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === directory) vi.spyOn(handle, "sync").mockRejectedValue(new Error("sync failed"));
      return handle;
    });
    await expect(state.transaction((draft) => { draft.count = 7; })).rejects.toThrow("sync failed");
    await expect(state.read((value) => value.count)).rejects.toThrow("uncertain commit");
    await expect(state.transaction((draft) => { draft.count = 1; })).rejects.toThrow("uncertain commit");
    vi.restoreAllMocks();
    await state.close();
    expect(await open().read((value) => value.count)).toBe(7);
  });

  it.each(["{", '{"schema_version":2,"count":1}', '{"schema_version":1,"count":"wrong"}'])(
    "fails closed on malformed persisted state %s", async (contents) => {
      const { path, open } = await fixture();
      await writeFile(path, contents, { mode: 0o600 });
      const state = open();
      await expect(state.read((value) => value.count)).rejects.toThrow();
      await expect(state.transaction((draft) => { draft.count = 3; })).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(contents);
    },
  );

  it("rejects oversized snapshots on load and oversized candidates before commit", async () => {
    const { path, open } = await fixture(32);
    const state = open();
    await state.read((value) => value);
    await expect(state.transaction((draft) => { draft.count = 1234567890; })).rejects.toThrow("size");
    expect(await state.read((value) => value.count)).toBe(0);
    await state.close();
    await writeFile(path, " ".repeat(33), { mode: 0o600 });
    await expect(open().read((value) => value.count)).rejects.toThrow("size");
  });

  it("rejects two active instances for one path but allows reopening after close", async () => {
    const { open } = await fixture();
    const state = open();
    expect(open).toThrow("already open");
    await state.close();
    expect(await open().read((value) => value.count)).toBe(0);
    await expect(state.read((value) => value.count)).rejects.toThrow("closed");
  });

  it("reopens an acknowledged commit after the writer process exits without close", async () => {
    const { path, open } = await fixture();
    const modulePath = resolve("lib/storage/file-state.ts");
    const script = `import { FileState } from ${JSON.stringify(modulePath)};
      const state = new FileState({path:${JSON.stringify(path)}, initial:()=>({schema_version:1,count:0}),validate:v=>v});
      await state.transaction(draft=>{draft.count=42}); process.exit(0);`;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
    expect(await open().read((value) => value.count)).toBe(42);
  });
});
