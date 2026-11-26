import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { closeHttpServer } from "../src/http-shutdown.js";

const listen = async (server: http.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
};

test("HTTP shutdown closes idle keep-alive connections immediately", async () => {
  const server = http.createServer((_request, response) => {
    response.end("ok");
  });
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port, agent },
        (response) => {
          response.resume();
          response.on("end", resolve);
        },
      );
      request.on("error", reject);
    });
    const startedAt = performance.now();
    await closeHttpServer(server, { drainTimeoutMs: 5_000 });
    assert.ok(performance.now() - startedAt < 1_000);
  } finally {
    agent.destroy();
  }
});

test("HTTP shutdown force-closes connections after the drain timeout", async () => {
  let requestReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    requestReady = resolve;
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.flushHeaders();
    requestReady?.();
  });
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port, agent },
        (response) => {
          response.on("error", () => undefined);
          response.resume();
          resolve();
        },
      );
      request.on("error", reject);
    });
    await ready;
    const startedAt = performance.now();
    await closeHttpServer(server, { drainTimeoutMs: 50 });
    assert.ok(performance.now() - startedAt >= 40);
  } finally {
    agent.destroy();
  }
});
