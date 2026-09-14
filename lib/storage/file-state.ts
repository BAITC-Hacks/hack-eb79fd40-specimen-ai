import { randomUUID } from "node:crypto";
import filesystem from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface FileStateOptions<T> {
  path: string;
  initial: () => T;
  validate: (value: unknown) => T;
  maxBytes?: number;
}

const globals = globalThis as typeof globalThis & {
  __demeuFileStatePaths?: Set<string>;
};
const activePaths = (globals.__demeuFileStatePaths ??= new Set<string>());

// One Node process per local volume. This registry is not an interprocess lock.
export class FileState<T> {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private state!: T;
  private closed = false;
  private poisoned = false;

  constructor(private readonly options: FileStateOptions<T>) {
    this.path = resolve(options.path);
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("Invalid snapshot size limit");
    }
    if (activePaths.has(this.path)) throw new Error("Snapshot already open in this process");
    activePaths.add(this.path);
    this.ready = this.initialize();
    // Calls still receive initialization errors; avoid an unhandled rejection
    // when the first consumer arrives after initialization fails.
    void this.ready.catch(() => undefined);
  }

  private async initialize(): Promise<void> {
    await filesystem.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await filesystem.open(this.path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial = this.options.validate(this.options.initial());
      await this.persist(initial);
      return;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.maxBytes) throw new Error("Invalid snapshot size or file type");
      const bytes = await handle.readFile();
      if (bytes.byteLength > this.maxBytes) throw new Error("Snapshot size limit exceeded");
      this.state = structuredClone(this.options.validate(JSON.parse(bytes.toString("utf8"))));
    } finally {
      await handle.close();
    }
  }

  private async persist(candidate: T): Promise<void> {
    const serialized = JSON.stringify(candidate);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > this.maxBytes) {
      throw new Error("Snapshot size limit exceeded");
    }
    // Validate precisely the representation that survives a process restart.
    const committed = this.options.validate(JSON.parse(serialized));
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const handle = await filesystem.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await filesystem.rename(temporary, this.path);
      renamed = true;
      const directory = await filesystem.open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.state = structuredClone(committed);
    } catch (error) {
      // Rename may have committed even if directory sync failed. Never overwrite
      // that state from the old in-memory copy; reopen to recover explicitly.
      if (renamed) this.poisoned = true;
      throw error;
    } finally {
      if (!renamed) await filesystem.unlink(temporary).catch(() => undefined);
    }
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    if (this.closed) return Promise.reject(new Error("Snapshot is closed"));
    const pending = this.queue.then(async () => {
      await this.ready;
      if (this.poisoned) throw new Error("Snapshot requires reopening after an uncertain commit");
      return operation();
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  read<R>(fn: (state: Readonly<T>) => R): Promise<R> {
    return this.enqueue(async () => structuredClone(fn(structuredClone(this.state))));
  }

  // Callback operates on detached memory only: no network, notifications or I/O.
  transaction<R>(fn: (draft: T) => R | Promise<R>): Promise<R> {
    return this.enqueue(async () => {
      const draft = structuredClone(this.state);
      const result = structuredClone(await fn(draft));
      await this.persist(draft);
      return result;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.ready.catch(() => undefined);
    activePaths.delete(this.path);
  }
}
