import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { asyncRoute } from "../src/light-api/http.js";

const withServer = async (
  createApp: () => express.Express,
  run: (base: string) => Promise<void>,
): Promise<void> => {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
};

const withTimeout = async <Value>(
  promise: Promise<Value>,
  message: string,
): Promise<Value> =>
  await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), 2_000).unref();
    }),
  ]);

test("async routes abort on premature disconnect without invoking error middleware", async () => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  let errorHandlerCalls = 0;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });

  await withServer(
    () => {
      const app = express();
      app.get(
        "/wait",
        asyncRoute(async (_request, _response, signal) => {
          markStarted();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                markAborted();
                resolve();
              },
              { once: true },
            );
          });
          throw new Error("client is gone");
        }),
      );
      app.use(
        (
          _error: unknown,
          _request: Request,
          response: Response,
          _next: NextFunction,
        ) => {
          errorHandlerCalls += 1;
          response.status(500).end();
        },
      );
      return app;
    },
    async (base) => {
      const request = http.get(`${base}/wait`);
      request.on("error", () => undefined);
      await withTimeout(started, "request handler did not start");
      request.destroy();
      await withTimeout(aborted, "request abort was not propagated");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(errorHandlerCalls, 0);
    },
  );
});

test("successful responses do not abort their request signal", async () => {
  let observedAbort = false;
  await withServer(
    () => {
      const app = express();
      app.get(
        "/finish",
        asyncRoute(async (_request, response, signal) => {
          response.json({ ok: true });
          await new Promise((resolve) => setTimeout(resolve, 30));
          observedAbort = signal.aborted;
        }),
      );
      return app;
    },
    async (base) => {
      const response = await fetch(`${base}/finish`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(observedAbort, false);
    },
  );
});
