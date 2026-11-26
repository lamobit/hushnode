import assert from "node:assert/strict";
import test from "node:test";
import { SingleFlight } from "../src/single-flight.js";

test("pending work is shared per key and released after success", async () => {
  const requests = new SingleFlight<string, number>();
  let calls = 0;
  let finish!: (value: number) => void;
  const load = () => {
    calls += 1;
    return new Promise<number>((resolve) => { finish = resolve; });
  };
  const first = requests.run("a", load);
  const second = requests.run("a", load);
  assert.equal(first, second);
  assert.equal(await requests.run("b", async () => 2), 2);
  assert.equal(calls, 1);
  finish(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(await requests.run("a", async () => 3), 3);
});

test("failed work is shared and retryable, including synchronous throws", async () => {
  const requests = new SingleFlight<string, number>();
  const failure = new Error("upstream unavailable");
  const first = requests.run("a", () => { throw failure; });
  const second = requests.run("a", async () => 1);
  assert.equal(first, second);
  const results = await Promise.allSettled([first, second]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, failure);
  }
  assert.equal(await requests.run("a", async () => 2), 2);
});

test("cancellable subscribers detach independently and release abandoned work", async () => {
  const requests = new SingleFlight<string, number>();
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  let loadSignal: AbortSignal | undefined;
  let release!: (value: number) => void;
  let loads = 0;
  const load = (signal: AbortSignal): Promise<number> => {
    loads += 1;
    loadSignal = signal;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  };

  const first = requests.runWithSignal("a", load, firstAbort.signal);
  const second = requests.runWithSignal("a", load, secondAbort.signal);
  await Promise.resolve();
  assert.notEqual(first, second);
  assert.equal(loads, 1);

  firstAbort.abort(new Error("first caller left"));
  await assert.rejects(first, /first caller left/);
  assert.equal(loadSignal?.aborted, false);

  secondAbort.abort(new Error("last caller left"));
  await assert.rejects(second, /last caller left/);
  assert.equal(loadSignal?.aborted, true);
  assert.equal(
    loadSignal?.reason instanceof Error ? loadSignal.reason.message : "",
    "last caller left",
  );

  assert.equal(
    await requests.runWithSignal(
      "a",
      async () => {
        loads += 1;
        return 9;
      },
      new AbortController().signal,
    ),
    9,
  );
  assert.equal(loads, 2);
  release(1);
  await new Promise((resolve) => setImmediate(resolve));
});

test("plain subscribers keep shared work alive after cancellable callers leave", async () => {
  const requests = new SingleFlight<string, number>();
  const abort = new AbortController();
  let loadSignal: AbortSignal | undefined;
  let release!: (value: number) => void;
  const cancellable = requests.runWithSignal(
    "a",
    (signal) => {
      loadSignal = signal;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    },
    abort.signal,
  );
  const pinned = requests.run("a", async () => 99);

  abort.abort(new Error("request disconnected"));
  await assert.rejects(cancellable, /request disconnected/);
  assert.equal(loadSignal?.aborted, false);

  release(7);
  assert.equal(await pinned, 7);
});

test("already-aborted subscribers never start shared work", async () => {
  const requests = new SingleFlight<string, number>();
  const abort = new AbortController();
  abort.abort(new Error("timed out"));
  let loads = 0;

  await assert.rejects(
    requests.runWithSignal(
      "a",
      async () => {
        loads += 1;
        return 1;
      },
      abort.signal,
    ),
    /timed out/,
  );
  assert.equal(loads, 0);
});
