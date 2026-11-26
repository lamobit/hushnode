import assert from "node:assert/strict";
import test from "node:test";
import { readJsonWithLimit } from "../src/json-response.js";

test("bounded JSON reads parse normal responses", async () => {
  const value = await readJsonWithLimit(
    Response.json({ ok: true }),
    1_024,
  );
  assert.deepEqual(value, { ok: true });
});

test("bounded JSON reads reject oversized declared bodies", async () => {
  const response = new Response('{"items":[]}', {
    headers: { "content-length": "100" },
  });
  await assert.rejects(
    readJsonWithLimit(response, 10),
    /size limit/,
  );
});

test("bounded JSON reads stop oversized streamed bodies", async () => {
  await assert.rejects(
    readJsonWithLimit(new Response("x".repeat(64)), 16),
    /size limit/,
  );
});

test("bounded JSON reads reject invalid limits and invalid JSON", async () => {
  await assert.rejects(
    readJsonWithLimit(Response.json({}), 0),
    /positive integer/,
  );
  await assert.rejects(
    readJsonWithLimit(new Response("{"), 1_024),
    SyntaxError,
  );
});

test("bounded JSON reads abort pending response streams", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull: async () => await new Promise<void>(() => undefined),
    cancel: () => {
      cancelled = true;
    },
  });
  const pending = readJsonWithLimit(
    new Response(body),
    1_024,
    abort.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort(new Error("client disconnected"));
  await assert.rejects(pending, /client disconnected/);
  assert.equal(cancelled, true);
});
