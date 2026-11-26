import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../src/concurrency.js";

test("concurrency mapper preserves order and bounds active work", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency(
    Array.from({ length: 12 }, (_, index) => index),
    3,
    async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    },
  );

  assert.deepEqual(
    results,
    Array.from({ length: 12 }, (_, index) => index * 2),
  );
  assert.equal(maxActive, 3);
  assert.equal(active, 0);
});

test("concurrency mapper rejects invalid limits and propagates failures", async () => {
  await assert.rejects(
    mapWithConcurrency([1], 0, async (value) => value),
    /positive integer/,
  );
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error("mapper failed");
      return value;
    }),
    /mapper failed/,
  );
});
