import assert from "node:assert/strict";
import test from "node:test";
import { TtlCache } from "../src/ttl-cache.js";

test("TTL cache expires entries and supports per-entry lifetimes", () => {
  let now = 1_000;
  const cache = new TtlCache<string, number>(100, 10, () => now);
  cache.set("short", 1, 50);
  cache.set("long", 2, 500);
  assert.equal(cache.get("short"), 1);
  now = 1_050;
  assert.equal(cache.get("short"), undefined);
  assert.equal(cache.get("long"), 2);
  now = 1_500;
  assert.equal(cache.get("long"), undefined);
  assert.equal(cache.size, 0);
});

test("TTL cache bounds entries with insertion-order eviction", () => {
  const cache = new TtlCache<string, number>(1_000, 2);
  cache.set("first", 1);
  cache.set("second", 2);
  cache.set("third", 3);
  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.get("second"), 2);
  assert.equal(cache.get("third"), 3);

  cache.set("second", 20);
  cache.set("fourth", 4);
  assert.equal(cache.get("second"), 20);
  assert.equal(cache.get("third"), undefined);
});

test("TTL cache enforces byte budgets and rejects oversized values", () => {
  const sizeOf = (value: string): number => Buffer.byteLength(value);
  const cache = new TtlCache<string, string>(1_000, 10, {
    maxBytes: 10,
    sizeOf,
  });
  assert.equal(cache.set("first", "123456"), true);
  assert.equal(cache.set("second", "7890"), true);
  assert.equal(cache.sizeBytes, 10);

  assert.equal(cache.set("third", "x"), true);
  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.get("second"), "7890");
  assert.equal(cache.sizeBytes, 5);

  assert.equal(cache.set("huge", "12345678901"), false);
  assert.equal(cache.get("second"), "7890");
  assert.equal(cache.sizeBytes, 5);

  assert.equal(cache.set("second", "x".repeat(11)), false);
  assert.equal(cache.get("second"), "7890");
  assert.equal(cache.sizeBytes, 5);

  cache.delete("second");
  assert.equal(cache.sizeBytes, 1);
  cache.clear();
  assert.equal(cache.sizeBytes, 0);
});

test("TTL cache releases byte accounting on expiry", () => {
  let now = 0;
  const cache = new TtlCache<string, string>(100, 10, {
    now: () => now,
    maxBytes: 5,
    sizeOf: (value) => Buffer.byteLength(value),
  });
  cache.set("value", "12345");
  assert.equal(cache.sizeBytes, 5);
  now = 100;
  assert.equal(cache.get("value"), undefined);
  assert.equal(cache.sizeBytes, 0);
});

test("TTL cache rejects invalid capacities", () => {
  assert.throws(() => new TtlCache(0, 1), /ttlMs/);
  assert.throws(() => new TtlCache(1, 0), /maxEntries/);
  assert.throws(
    () => new TtlCache(1, 1, { maxBytes: 0, sizeOf: () => 0 }),
    /maxBytes/,
  );
  assert.throws(
    () => new TtlCache(1, 1, { maxBytes: 1 }),
    /provided together/,
  );
  const cache = new TtlCache(100, 1);
  assert.throws(() => cache.set("key", "value", 0), /positive/);
});
