import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  NetworkName,
} from "@railgun-community/shared-models";
import { createHttpApp } from "../src/http-app.js";
import type {
  LightApiOptions,
  LightIndexSource,
  LightRpcProvider,
  LightTreeSource,
} from "../src/light-api.js";

const withServer = async (
  light: LightApiOptions,
  run: (base: string) => Promise<void>,
  trustProxyHops = 0,
): Promise<void> => {
  const { app } = createHttpApp({ light, trustProxyHops });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
  }
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
};

const sourceWithReadiness = (ready: boolean): LightIndexSource => {
  const tree: LightTreeSource = {
    async getLatestTreeAndIndex() {
      return { tree: 0, index: -1 };
    },
    async getTreeLength() {
      return 0;
    },
    async getRoot() {
      return "0".repeat(64);
    },
    async getCommitmentRange() {
      return [];
    },
    async getNullifiers() {
      return [];
    },
    async getMerkleProof() {
      throw new Error("not used");
    },
  };
  const provider: LightRpcProvider = {
    async call() {
      return "0x";
    },
    async getBlockNumber() {
      return 100;
    },
    async sendRawTransaction() {
      return `0x${"00".repeat(32)}`;
    },
    async getTransactionCount() {
      return 1;
    },
    async getBalance() {
      return 1n;
    },
    async feeData() {
      return {
        baseFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        maxFeePerGas: 2n,
      };
    },
    async estimateGas() {
      return 21_000n;
    },
    async getTransactionReceipt() {
      return null;
    },
  };
  return {
    isRunning: () => true,
    isNetworkLoaded: () => true,
    readiness: () => ({
      ready,
      state: ready ? "ready" : "syncing",
      retryAttempt: ready ? 0 : 1,
      lastCompletedAt: ready ? 1 : null,
    }),
    scanActivity: () => ({ utxo: false, txid: false }),
    lastSyncedBlock: async () => 100,
    tree: () => tree,
    provider: () => provider,
  };
};

test("HTTP app describes the service at / and fails the light API closed by default", async () => {
  await withServer({ enabled: false }, async (base) => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    const body = await root.json() as {
      service?: string;
      version?: string;
      health?: string;
      networks?: string[];
      lightApi?: {
        enabled?: boolean;
        protocol?: number;
        prefix?: string | null;
        status?: string | null;
      };
    };
    assert.equal(body.service, "hush-node");
    assert.match(body.version ?? "", /^\d+\.\d+\.\d+$/);
    assert.equal(body.health, "/health");
    assert.deepEqual(body.networks, ["ethereum", "arbitrum"]);
    assert.equal(body.lightApi?.enabled, false);
    assert.equal(body.lightApi?.protocol, 1);
    assert.equal(body.lightApi?.prefix, null);
    assert.equal(body.lightApi?.status, null);
    assert.equal(root.headers.get("cache-control"), "no-store");

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(
      (await health.json() as { service?: string }).service,
      "hush-node",
    );
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");

    const light = await fetch(`${base}/api/light/v1/status`);
    assert.equal(light.status, 404);
    assert.equal(
      (await light.json() as { code?: string }).code,
      "LIGHT_API_DISABLED",
    );

    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(
      (await missing.json() as { code?: string }).code,
      "NOT_FOUND",
    );
  });
});

test("HTTP app advertises the light API at / when enabled", async () => {
  await withServer({ enabled: true }, async (base) => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    const body = await root.json() as {
      lightApi?: {
        enabled?: boolean;
        protocol?: number;
        prefix?: string | null;
        status?: string | null;
      };
    };
    assert.equal(body.lightApi?.enabled, true);
    assert.equal(body.lightApi?.protocol, 1);
    assert.equal(body.lightApi?.prefix, "/api/light/v1");
    assert.equal(
      body.lightApi?.status,
      "/api/light/v1/status?network=ethereum&txidVersion=V2_PoseidonMerkle",
    );
  });
});

test("liveness stays 200 while readiness fails closed until every network syncs", async () => {
  await withServer(
    {
      enabled: true,
      source: sourceWithReadiness(false),
    },
    async (base) => {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      const healthBody = (await health.json()) as {
        ready?: boolean;
        lightApi?: { ready?: boolean };
      };
      assert.equal(healthBody.ready, false);
      assert.equal(healthBody.lightApi?.ready, false);

      const ready = await fetch(`${base}/readyz`);
      assert.equal(ready.status, 503);
      const readyBody = (await ready.json()) as {
        ready?: boolean;
        networks?: Record<
          string,
          { ready?: boolean; state?: string; retryAttempt?: number }
        >;
      };
      assert.equal(readyBody.ready, false);
      assert.equal(readyBody.networks?.[NetworkName.Ethereum]?.ready, false);
      assert.equal(readyBody.networks?.[NetworkName.Ethereum]?.state, "syncing");
      assert.equal(
        readyBody.networks?.[NetworkName.Arbitrum]?.retryAttempt,
        1,
      );
    },
  );

  await withServer(
    {
      enabled: true,
      source: sourceWithReadiness(true),
    },
    async (base) => {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.equal(
        ((await health.json()) as { ready?: boolean }).ready,
        true,
      );

      const ready = await fetch(`${base}/readyz`);
      assert.equal(ready.status, 200);
      const body = (await ready.json()) as {
        ready?: boolean;
        networks?: Record<string, { ready?: boolean }>;
      };
      assert.equal(body.ready, true);
      assert.equal(body.networks?.[NetworkName.Ethereum]?.ready, true);
      assert.equal(body.networks?.[NetworkName.Arbitrum]?.ready, true);
    },
  );

  await withServer(
    { enabled: false },
    async (base) => {
      const ready = await fetch(`${base}/readyz`);
      assert.equal(ready.status, 200);
      assert.equal(
        ((await ready.json()) as { ready?: boolean }).ready,
        true,
      );
    },
  );
});

test("trusted proxy hops isolate client rate-limit buckets", async () => {
  const callGas = (
    base: string,
    forwardedFor: string,
  ): Promise<Response> =>
    fetch(`${base}/api/light/v1/evm/gas?network=arbitrum`, {
      headers: { "x-forwarded-for": forwardedFor },
    });

  await withServer(
    {
      enabled: true,
      source: sourceWithReadiness(true),
      evmRatePerMinute: 1,
    },
    async (base) => {
      assert.equal((await callGas(base, "203.0.113.1")).status, 200);
      assert.equal((await callGas(base, "203.0.113.1")).status, 429);
      assert.equal((await callGas(base, "203.0.113.2")).status, 200);
    },
    1,
  );

  await withServer(
    {
      enabled: true,
      source: sourceWithReadiness(true),
      evmRatePerMinute: 1,
    },
    async (base) => {
      assert.equal((await callGas(base, "203.0.113.1")).status, 200);
      assert.equal((await callGas(base, "203.0.113.2")).status, 429);
    },
  );
});

test("readiness fails closed when the index runtime throws", async () => {
  const source = sourceWithReadiness(true);
  source.isRunning = () => {
    throw new Error("engine state unavailable");
  };
  source.readiness = () => {
    throw new Error("readiness unavailable");
  };

  await withServer(
    { enabled: true, source },
    async (base) => {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.equal(
        ((await health.json()) as { ready?: boolean }).ready,
        false,
      );

      const ready = await fetch(`${base}/readyz`);
      assert.equal(ready.status, 503);
      const body = (await ready.json()) as {
        ready?: boolean;
        networks?: Record<string, { state?: string }>;
      };
      assert.equal(body.ready, false);
      assert.equal(body.networks?.[NetworkName.Arbitrum]?.state, "degraded");
    },
  );
});
