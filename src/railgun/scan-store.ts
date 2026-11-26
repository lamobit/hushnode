import { Database } from "@railgun-community/engine";
import { createRequire } from "node:module";
import LevelDOWN from "leveldown";
import type { MemDown } from "memdown";

const MemDOWN = createRequire(import.meta.url)("memdown") as new () => MemDown<
  Buffer,
  Buffer
>;

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

type DBPath = Parameters<Database["put"]>[0];
type Encoding = NonNullable<Parameters<Database["put"]>[2]>;
type Batch = Parameters<Database["batch"]>[0];

type RawEntry = {
  key: Buffer | string;
  value: Buffer | string;
};

type LevelStream = NodeJS.EventEmitter;

export type ScanStoreOptions = {
  maxBytes?: number;
  location?: string;
};

const sizeOf = (value: unknown, encoding: Encoding): number => {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (encoding === "json") return Buffer.byteLength(JSON.stringify(value));
  return Buffer.byteLength(String(value), encoding);
};

/** Private wallet state never shares a backing store with the public index. */
export class ScanStore extends Database {
  private readonly sizes = new Map<string, number>();
  private mutationTail: Promise<void> = Promise.resolve();
  private bytes = 0;
  private failure?: Error;
  private closed = false;
  private closePromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private readonly maxBytes: number;

  constructor(maxBytesOrOptions: number | ScanStoreOptions = {}) {
    const options =
      typeof maxBytesOrOptions === "number"
        ? { maxBytes: maxBytesOrOptions }
        : maxBytesOrOptions;
    super(options.location ? new LevelDOWN(options.location) : new MemDOWN());
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.level.on("error", (error: unknown) => {
      this.failure =
        error instanceof Error
          ? error
          : new Error("Remote scan storage failed.");
    });
  }

  static async open(
    location: string,
    maxBytes = DEFAULT_MAX_BYTES,
  ): Promise<ScanStore> {
    const store = new ScanStore({ location, maxBytes });
    try {
      await store.waitUntilOpen();
      await store.rebuildLedger();
      return store;
    } catch (error) {
      await store.level.close().catch(() => undefined);
      throw error;
    }
  }

  get usedBytes(): number {
    return this.bytes;
  }

  assertHealthy(): void {
    if (this.closed) {
      throw new Error("Remote scan storage is closed.");
    }
    if (this.failure) throw this.failure;
  }

  private async waitUntilOpen(): Promise<void> {
    if (this.failure) throw this.failure;
    const level = this.level as unknown as {
      isOpen: () => boolean;
      once: (event: string, listener: (...args: never[]) => void) => void;
      removeListener: (
        event: string,
        listener: (...args: never[]) => void,
      ) => void;
    };
    if (level.isOpen()) return;
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        level.removeListener("open", onOpen as () => void);
        level.removeListener("error", onError as (error: Error) => void);
      };
      level.once("open", onOpen as () => void);
      level.once("error", onError as (error: Error) => void);
    });
    if (this.failure) throw this.failure;
  }

  private async rebuildLedger(): Promise<void> {
    const stream = this.level.createReadStream({
      keys: true,
      values: true,
    }) as unknown as LevelStream;
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (entry: RawEntry) => {
        const key = Buffer.isBuffer(entry.key)
          ? entry.key.toString()
          : String(entry.key);
        const valueBytes = Buffer.isBuffer(entry.value)
          ? entry.value.byteLength
          : Buffer.byteLength(String(entry.value));
        const size = Buffer.byteLength(key) + valueBytes;
        this.sizes.set(key, size);
        this.bytes += size;
      });
      stream.once("error", reject);
      stream.once("end", resolve);
    });
    if (this.bytes > this.maxBytes) {
      this.failure = new Error(
        "Remote scan private storage limit exceeded.",
      );
      throw this.failure;
    }
  }

  private projectedBytes(changes: Map<string, number>): number {
    this.assertHealthy();
    let next = this.bytes;
    for (const [key, size] of changes) {
      next += size - (this.sizes.get(key) ?? 0);
    }
    return next;
  }

  private commit(changes: Map<string, number>, next: number): void {
    this.bytes = next;
    for (const [key, size] of changes) {
      if (size === 0) this.sizes.delete(key);
      else this.sizes.set(key, size);
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async mutate(
    changes: Map<string, number>,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    this.assertHealthy();
    const next = this.projectedBytes(changes);
    if (next > this.maxBytes) {
      this.failure = new Error("Remote scan private storage limit exceeded.");
      throw this.failure;
    }
    try {
      await operation();
    } catch (error) {
      this.failure =
        error instanceof Error
          ? error
          : new Error("Remote scan storage write failed.");
      throw error;
    }
    this.commit(changes, next);
  }

  override async put(path: DBPath, value: unknown, encoding: Encoding = "hex") {
    const key = Database.pathToKey(path);
    const changes = new Map([
      [key, Buffer.byteLength(key) + sizeOf(value, encoding)],
    ]);
    await this.enqueueMutation(() =>
      this.mutate(changes, () => super.put(path, value, encoding)),
    );
  }

  override async batch(operations: Batch, encoding: Encoding = "hex") {
    await this.enqueueMutation(() => {
      const changes = new Map<string, number>();
      for (const operation of operations) {
        const key = String(operation.key);
        changes.set(
          key,
          operation.type === "del"
            ? 0
            : Buffer.byteLength(key) + sizeOf(operation.value, encoding),
        );
      }
      return this.mutate(changes, () => super.batch(operations, encoding));
    });
  }

  override async del(path: DBPath, encoding: Encoding = "hex") {
    const changes = new Map([[Database.pathToKey(path), 0]]);
    await this.enqueueMutation(() =>
      this.mutate(changes, () => super.del(path, encoding)),
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.enqueueMutation(async () => {
      try {
        await this.level.close();
      } finally {
        this.sizes.clear();
        this.bytes = 0;
      }
    });
    return this.closePromise;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.closePromise) {
      this.disposePromise = this.closePromise.then(() => undefined);
      return this.disposePromise;
    }
    this.closed = true;
    this.disposePromise = this.enqueueMutation(async () => {
      const errors: Error[] = [];
      try {
        await this.level.clear();
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error
            : new Error("Remote scan storage clear failed."),
        );
      }
      try {
        await super.close();
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error
            : new Error("Remote scan storage close failed."),
        );
      } finally {
        this.sizes.clear();
        this.bytes = 0;
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "Remote scan private storage cleanup was incomplete.",
        );
      }
    });
    return this.disposePromise;
  }
}
