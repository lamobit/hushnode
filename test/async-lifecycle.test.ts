import assert from "node:assert/strict";
import test from "node:test";
import {
  settleCleanup,
  settleWithin,
  withTimeout,
} from "../src/async-lifecycle.js";

test("withTimeout forwards values and failures before the deadline", async () => {
  assert.equal(
    await withTimeout(Promise.resolve("value"), 100, "operation timed out"),
    "value",
  );
  await assert.rejects(
    withTimeout(
      Promise.reject(new Error("operation failed")),
      100,
      "operation timed out",
    ),
    /operation failed/,
  );
});

test("withTimeout rejects operations that miss the deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;
  const pending = new Promise<string>((resolve) => {
    release = () => resolve("late value");
  });

  const result = withTimeout(pending, 25, "operation timed out");
  context.mock.timers.tick(25);
  await assert.rejects(result, /operation timed out/);
  release();
  assert.equal(await pending, "late value");
});

test("settleCleanup captures successful and failed cleanup", async () => {
  assert.deepEqual(
    await settleCleanup(() => undefined, 100, "cleanup timed out"),
    { ok: true },
  );
  assert.deepEqual(
    await settleCleanup(async () => undefined, 100, "cleanup timed out"),
    { ok: true },
  );

  const failure = await settleCleanup(
    () => {
      throw new Error("cleanup failed");
    },
    100,
    "cleanup timed out",
  );
  assert.equal(failure.ok, false);
  assert.match(
    !failure.ok && failure.error instanceof Error
      ? failure.error.message
      : "",
    /cleanup failed/,
  );
});

test("settleCleanup reports cleanup that misses the deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  const result = settleCleanup(() => pending, 25, "cleanup timed out");
  context.mock.timers.tick(25);
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.match(
    !outcome.ok && outcome.error instanceof Error
      ? outcome.error.message
      : "",
    /cleanup timed out/,
  );
  release();
  await pending;
});

test("settleWithin handles empty and failed operations", async () => {
  assert.equal(await settleWithin([], 100), true);
  assert.equal(
    await settleWithin(
      [
        Promise.resolve(),
        Promise.reject(new Error("expected failure")),
      ],
      100,
    ),
    true,
  );
});

test("settleWithin reports operations that miss the deadline", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  assert.equal(await settleWithin([pending], 5), false);
  release();
  await pending;
});
