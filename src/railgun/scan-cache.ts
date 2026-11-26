import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  Chain,
  ChainType,
  TXIDVersion,
} from "@railgun-community/shared-models";
import { createLogger } from "../logger.js";
import {
  ensurePrivateDirectory,
  ensurePrivateDirectoryWithin,
} from "../private-directory.js";

const log = createLogger("scan-cache");

const BUCKET_KEY_PATTERN = /^[0-9a-f]{64}$/;
const META_FILE = "meta.json";
const MAX_META_BYTES = 64 * 1024;
const DEFAULT_MAX_BUCKETS = 64;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;

export const SCAN_CACHE_SCHEMA_VERSION = 1;

export type ScanCacheMeta = {
  schemaVersion: number;
  chainType: ChainType;
  chainId: number;
  txidVersion: string;
  fromBlock: number;
  lastSyncedBlock: number | null;
  createdAt: number;
  updatedAt: number;
  bytes: number;
};

export type ScanCacheIdentity = {
  chain: Chain;
  txidVersion: TXIDVersion;
  fromBlock: number;
  lastSyncedBlock?: number;
};

export type ScanCacheOptions = {
  rootDir: string;
  ttlMs?: number;
  maxBuckets?: number;
  maxTotalBytes?: number;
  now?: () => number;
};

export type ScanCacheEntry = {
  key: string;
  directory: string;
  meta: ScanCacheMeta;
  bytes: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const parseMeta = (value: unknown): ScanCacheMeta | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    value.schemaVersion !== SCAN_CACHE_SCHEMA_VERSION ||
    !safeInteger(value.chainType) ||
    !safeInteger(value.chainId) ||
    typeof value.txidVersion !== "string" ||
    !safeInteger(value.fromBlock) ||
    !safeInteger(value.createdAt) ||
    !safeInteger(value.updatedAt) ||
    !safeInteger(value.bytes) ||
    !(
      value.lastSyncedBlock === null ||
      safeInteger(value.lastSyncedBlock)
    )
  ) {
    return undefined;
  }
  return {
    schemaVersion: value.schemaVersion,
    chainType: value.chainType as ChainType,
    chainId: value.chainId,
    txidVersion: value.txidVersion,
    fromBlock: value.fromBlock,
    lastSyncedBlock: value.lastSyncedBlock ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    bytes: value.bytes,
  };
};

const directoryBytes = async (directory: string): Promise<number> => {
  let total = 0;
  const entries = await fs.promises.readdir(directory, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(target);
    } else if (entry.isFile()) {
      const stat = await fs.promises.lstat(target);
      total += stat.size;
    }
  }
  return total;
};

/**
 * Disk layout and quota management for remote scan wallet databases.
 * Each bucket is one wallet/chain/version combination keyed by a hash so the
 * viewing key never becomes part of a path or log line.
 */
export class ScanCache {
  private readonly ttlMs: number;
  private readonly maxBuckets: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;

  constructor(private readonly options: ScanCacheOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxBuckets = Math.max(1, options.maxBuckets ?? DEFAULT_MAX_BUCKETS);
    this.maxTotalBytes = Math.max(
      1,
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    );
    this.now = options.now ?? Date.now;
    ensurePrivateDirectory(options.rootDir);
  }

  get root(): string {
    return this.options.rootDir;
  }

  directoryFor(key: string): string {
    if (!BUCKET_KEY_PATTERN.test(key)) {
      throw new Error("Invalid remote scan cache key.");
    }
    return path.join(this.root, key.slice(0, 2), key);
  }

  prepare(key: string): string {
    const directory = this.directoryFor(key);
    ensurePrivateDirectoryWithin(this.root, directory);
    return directory;
  }

  async read(key: string): Promise<ScanCacheMeta | undefined> {
    const directory = this.directoryFor(key);
    const target = path.join(directory, META_FILE);
    try {
      const stat = await fs.promises.lstat(target);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size > MAX_META_BYTES
      ) {
        return undefined;
      }
      const text = await fs.promises.readFile(target, "utf8");
      return parseMeta(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  /**
   * Cheap existence probe used for queue admission. A stale bucket still
   * counts as warm; the scan itself revalidates progress before reusing it.
   */
  has(key: string): boolean {
    try {
      return fs.existsSync(path.join(this.directoryFor(key), META_FILE));
    } catch {
      return false;
    }
  }

  async write(key: string, meta: ScanCacheMeta): Promise<void> {
    const directory = this.prepare(key);
    const target = path.join(directory, META_FILE);
    const partial = `${target}.${process.pid}.${randomBytes(5).toString("hex")}.partial`;
    try {
      await fs.promises.writeFile(partial, JSON.stringify(meta), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.promises.rename(partial, target);
    } catch (error) {
      await fs.promises.rm(partial, { force: true });
      throw error;
    }
  }

  matches(meta: ScanCacheMeta, identity: ScanCacheIdentity): boolean {
    if (
      meta.chainType !== identity.chain.type ||
      meta.chainId !== identity.chain.id ||
      meta.txidVersion !== identity.txidVersion ||
      meta.fromBlock > identity.fromBlock
    ) {
      return false;
    }
    return !(
      meta.lastSyncedBlock !== null &&
      identity.lastSyncedBlock !== undefined &&
      meta.lastSyncedBlock > identity.lastSyncedBlock
    );
  }

  async remove(key: string): Promise<void> {
    const directory = this.directoryFor(key);
    await fs.promises.rm(directory, { recursive: true, force: true });
    const shard = path.dirname(directory);
    await fs.promises.rmdir(shard).catch(() => undefined);
  }

  private async list(
    activeKeys: ReadonlySet<string>,
  ): Promise<ScanCacheEntry[]> {
    const entries: ScanCacheEntry[] = [];
    const shards = await fs.promises.readdir(this.root, {
      withFileTypes: true,
    });
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardPath = path.join(this.root, shard.name);
      let buckets: fs.Dirent[];
      try {
        buckets = await fs.promises.readdir(shardPath, {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const bucket of buckets) {
        if (!bucket.isDirectory()) continue;
        const key = bucket.name;
        if (!BUCKET_KEY_PATTERN.test(key)) continue;
        const meta = await this.read(key);
        if (!meta) {
          if (!activeKeys.has(key)) {
            await this.remove(key).catch(() => undefined);
          }
          continue;
        }
        entries.push({
          key,
          directory: path.join(shardPath, key),
          meta,
          bytes: meta.bytes,
        });
      }
    }
    return entries;
  }

  /**
   * Drops expired, malformed, and over-quota buckets. Open buckets are never
   * removed; the caller passes their keys as active.
   */
  async gc(activeKeys: ReadonlySet<string>): Promise<number> {
    const now = this.now();
    const entries = await Promise.all(
      (await this.list(activeKeys)).map(async (entry) =>
        entry.bytes > 0
          ? entry
          : {
              ...entry,
              bytes: await directoryBytes(entry.directory).catch(() => 0),
            },
      ),
    );

    let removed = 0;
    const remove = async (entry: ScanCacheEntry): Promise<void> => {
      try {
        await this.remove(entry.key);
        removed += 1;
      } catch (error) {
        log.warn(
          `failed to remove expired scan cache bucket (${entry.key.slice(0, 8)})`,
          error,
        );
      }
    };

    const remaining: ScanCacheEntry[] = [];
    for (const entry of entries) {
      if (activeKeys.has(entry.key)) {
        remaining.push(entry);
        continue;
      }
      if (this.ttlMs > 0 && now - entry.meta.updatedAt >= this.ttlMs) {
        await remove(entry);
      } else {
        remaining.push(entry);
      }
    }

    const evictable = remaining
      .filter((entry) => !activeKeys.has(entry.key))
      .sort(
        (left, right) => left.meta.updatedAt - right.meta.updatedAt,
      );
    let totalBytes = remaining.reduce((sum, entry) => sum + entry.bytes, 0);
    let index = 0;
    while (
      index < evictable.length &&
      (remaining.length > this.maxBuckets ||
        totalBytes > this.maxTotalBytes)
    ) {
      const entry = evictable[index]!;
      index += 1;
      await remove(entry);
      totalBytes -= entry.bytes;
      const position = remaining.indexOf(entry);
      if (position >= 0) remaining.splice(position, 1);
    }

    if (
      remaining.length > this.maxBuckets ||
      totalBytes > this.maxTotalBytes
    ) {
      log.warn(
        "scan cache quota remains exceeded because active buckets cannot be evicted",
      );
    }
    return removed;
  }
}
