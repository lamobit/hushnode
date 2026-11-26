import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ChainType,
  TXIDVersion,
} from "@railgun-community/shared-models";
import {
  ScanCache,
  SCAN_CACHE_SCHEMA_VERSION,
  type ScanCacheMeta,
} from "../src/railgun/scan-cache.js";

const chain = { type: ChainType.EVM, id: 42161 };
const version = TXIDVersion.V2_PoseidonMerkle;
const cacheKey = (fill: string): string => fill.repeat(64);

const withRoot = async (
  run: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hush-scan-cache-"),
  );
  try {
    await run(root);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
};

const meta = (
  overrides: Partial<ScanCacheMeta> = {},
): ScanCacheMeta => ({
  schemaVersion: SCAN_CACHE_SCHEMA_VERSION,
  chainType: chain.type,
  chainId: chain.id,
  txidVersion: version,
  fromBlock: 100,
  lastSyncedBlock: 500,
  createdAt: 1,
  updatedAt: 1,
  bytes: 10,
  ...overrides,
});

test("cache metadata round-trips and rejects incompatible identities", async () => {
  await withRoot(async (root) => {
    const cache = new ScanCache({ rootDir: root, ttlMs: 1_000 });
    const key = cacheKey("a");
    await cache.write(key, meta());

    const stored = await cache.read(key);
    assert.deepEqual(stored, meta());
    const stat = await fs.promises.lstat(cache.directoryFor(key));
    assert.equal(stat.mode & 0o777, 0o700);

    const identity = {
      chain,
      txidVersion: version,
      fromBlock: 100,
      lastSyncedBlock: 500,
    };
    assert.equal(cache.matches(stored!, identity), true);
    assert.equal(
      cache.matches(stored!, { ...identity, fromBlock: 99 }),
      false,
    );
    assert.equal(
      cache.matches(stored!, { ...identity, lastSyncedBlock: 499 }),
      false,
    );
    assert.equal(
      cache.matches(stored!, {
        ...identity,
        chain: { ...chain, id: 1 },
      }),
      false,
    );
    assert.equal(
      cache.matches(stored!, {
        ...identity,
        txidVersion: TXIDVersion.V3_PoseidonMerkle,
      }),
      false,
    );
    assert.throws(
      () => cache.directoryFor("../escape"),
      /Invalid remote scan cache key/,
    );
  });
});

test("expired buckets are removed but active buckets survive", async () => {
  await withRoot(async (root) => {
    let now = 0;
    const cache = new ScanCache({
      rootDir: root,
      ttlMs: 100,
      maxBuckets: 10,
      now: () => now,
    });
    const active = cacheKey("a");
    const expired = cacheKey("b");
    await cache.write(active, meta({ updatedAt: 0 }));
    await cache.write(expired, meta({ updatedAt: 0 }));

    now = 100;
    assert.equal(await cache.gc(new Set([active])), 1);
    assert.notEqual(await cache.read(active), undefined);
    assert.equal(await cache.read(expired), undefined);
  });
});

test("bucket and byte quotas evict the oldest inactive buckets", async () => {
  await withRoot(async (root) => {
    let now = 0;
    const cache = new ScanCache({
      rootDir: root,
      ttlMs: 0,
      maxBuckets: 2,
      maxTotalBytes: 25,
      now: () => now,
    });
    const oldest = cacheKey("a");
    const middle = cacheKey("b");
    const newest = cacheKey("c");
    await cache.write(oldest, meta({ updatedAt: 1, bytes: 10 }));
    now = 1;
    await cache.write(middle, meta({ updatedAt: 2, bytes: 10 }));
    now = 2;
    await cache.write(newest, meta({ updatedAt: 3, bytes: 10 }));

    assert.equal(await cache.gc(new Set()), 1);
    assert.equal(await cache.read(oldest), undefined);
    assert.notEqual(await cache.read(middle), undefined);
    assert.notEqual(await cache.read(newest), undefined);
  });
});

test("has() reports a written bucket without reading it", async () => {
  await withRoot(async (root) => {
    const cache = new ScanCache({ rootDir: root, ttlMs: 1_000 });
    const key = cacheKey("e");
    assert.equal(cache.has(key), false);
    await cache.write(key, meta());
    assert.equal(cache.has(key), true);
    await cache.remove(key);
    assert.equal(cache.has(key), false);
  });
});
