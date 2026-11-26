import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import {
  NETWORK_CONFIG,
  NetworkName,
  TXIDVersion,
} from "@railgun-community/shared-models";
import { Interface } from "ethers";
import {
  createLightApiRouter,
  type LightIndexSource,
  type LightCommitment,
  type LightRpcProvider,
  type LightTreeSource,
  type LightTransactionReceipt,
} from "../src/light-api.js";
import type { IndexReadiness } from "../src/index-readiness.js";
import { RemoteScanService } from "../src/light-scan.js";
import { networkFor } from "../src/networks.js";
import type {
  PublicActivityItem,
  PublicActivityResult,
} from "../src/public-activity.js";
import {
  createFiatPriceSource,
  type FiatPriceSource,
} from "../src/prices.js";

const hash = (value: number): string =>
  value.toString(16).padStart(64, "0");

const nullifier = (value: number): string => hash(0x9000 + value);

const ANCHOR_ABI = new Interface([
  "function merkleRoot() view returns (bytes32)",
  "function accumulatorRoot() view returns (bytes32)",
  "function rootHistory(uint256 tree, bytes32 root) view returns (bool)",
]);
const ROOT_HISTORY_SELECTOR =
  ANCHOR_ABI.getFunction("rootHistory")!.selector;
const MERKLE_ROOT_SELECTOR = ANCHOR_ABI.getFunction("merkleRoot")!.selector;
const ACCUMULATOR_ROOT_SELECTOR =
  ANCHOR_ABI.getFunction("accumulatorRoot")!.selector;
const FEE_SELECTORS = new Set(["0x01c37790", "0x053ed12a", "0x9071adc0"]);

const fakeTree = (lengths: number[]): LightTreeSource => ({
  async getLatestTreeAndIndex() {
    return { tree: lengths.length - 1, index: (lengths.at(-1) ?? 0) - 1 };
  },
  async getTreeLength(tree) {
    return lengths[tree] ?? 0;
  },
  async getRoot(tree) {
    return hash(0x100 + tree);
  },
  async getCommitmentRange(tree, start, end) {
    const lastLeaf = Math.min(end, (lengths[tree] ?? 0) - 1);
    return Array.from({ length: lastLeaf - start + 1 }, (_, offset) => ({
      hash: hash(tree * 1_000 + start + offset),
      commitmentType: "TransactCommitmentV2",
      txid: hash(0x7000 + tree * 1_000 + start + offset),
      blockNumber: 10_000 + start + offset,
      utxoTree: tree,
      utxoIndex: start + offset,
      ciphertext: {
        ciphertext: ["0xaa", "0xbb", "0xcc", "0xdd"],
        blindedSenderViewingKey: hash(0x6000 + offset),
        blindedReceiverViewingKey: hash(0x5000 + offset),
        annotationData: "0xannotation",
        memo: "0xmemo",
      },
    }));
  },
  async getNullifiers(tree, after, limit) {
    const count = Math.min(lengths[tree] ?? 0, 8);
    return Array.from({ length: count }, (_, index) =>
      nullifier(tree * 100 + index),
    )
      .filter((value) => (after ? value > after : true))
      .slice(0, limit);
  },
  async getMerkleProof(tree, leaf) {
    return {
      leaf: hash(tree * 1_000 + leaf),
      elements: Array.from({ length: 16 }, (_, level) => hash(level)),
      indices: hash(leaf),
      root: hash(0x100 + tree),
    };
  },
});

type FakeSourceOptions = {
  feeError?: boolean;
  feeCalls?: string[];
  nullifierError?: boolean;
  anchorCalls?: Array<{ to: string; data: string }>;
  anchorError?: boolean;
  anchored?: boolean;
  chainRoot?: string;
  anchorBlock?: number;
  anchorDelayMs?: number;
  relayError?: boolean;
  relayFailure?: unknown;
  relayHash?: string;
  relayCalls?: string[];
  accountNonce?: number;
  accountBalance?: bigint;
  accountError?: boolean;
  accountCalls?: Array<{
    method: "getTransactionCount" | "getBalance";
    address: string;
    tag: string;
  }>;
  evmFeeData?: {
    baseFeePerGas: bigint | null;
    maxPriorityFeePerGas: bigint | null;
    maxFeePerGas: bigint | null;
  };
  evmFeeError?: boolean;
  evmCallResult?: string;
  evmCallError?: boolean;
  evmCallCalls?: Array<{ to: string; data: string }>;
  estimateGasResult?: bigint;
  estimateGasError?: boolean;
  estimateGasCalls?: Array<{
    from: string;
    to: string;
    data: string;
    value?: bigint;
  }>;
  receipt?: LightTransactionReceipt | null;
  receiptError?: boolean;
  receiptCalls?: string[];
  ready?: boolean;
  readiness?: IndexReadiness;
  running?: boolean;
  networkLoaded?: boolean;
  lastSyncedBlock?: number | null;
  lastSyncedBlockCalls?: Array<{
    network: NetworkName;
    txidVersion: TXIDVersion;
  }>;
};

const fakeSource = (
  lengths = [3, 0, 4],
  options: FakeSourceOptions = {},
): LightIndexSource => {
  const baseTree = fakeTree(lengths);
  const tree: LightTreeSource = options.nullifierError
    ? {
        ...baseTree,
        async getNullifiers() {
          throw new Error("nullifier db unavailable");
        },
      }
    : baseTree;
  const provider: LightRpcProvider = {
    call: async ({ to, data }) => {
      const selector = data.slice(0, 10);
      if (
        selector === ROOT_HISTORY_SELECTOR ||
        selector === MERKLE_ROOT_SELECTOR ||
        selector === ACCUMULATOR_ROOT_SELECTOR
      ) {
        options.anchorCalls?.push({ to, data });
        if (options.anchorDelayMs) {
          await delay(options.anchorDelayMs);
        }
        if (options.anchorError) {
          throw new Error("RPC https://secret.example unavailable");
        }
        if (selector === ROOT_HISTORY_SELECTOR) {
          return ANCHOR_ABI.encodeFunctionResult("rootHistory", [
            options.anchored ?? true,
          ]);
        }
        if (selector === MERKLE_ROOT_SELECTOR) {
          return ANCHOR_ABI.encodeFunctionResult("merkleRoot", [
            options.chainRoot ?? `0x${hash(0x999)}`,
          ]);
        }
        return ANCHOR_ABI.encodeFunctionResult("accumulatorRoot", [
          options.chainRoot ?? `0x${hash(0x999)}`,
        ]);
      }
      if (FEE_SELECTORS.has(selector)) {
        options.feeCalls?.push(data);
        if (options.feeError) {
          throw new Error("fee RPC unavailable");
        }
        const fees: Record<string, string> = {
          "0x01c37790": "0x64",
          "0x053ed12a": "0xc8",
          "0x9071adc0": "0x12c",
        };
        return fees[selector] ?? "0x";
      }
      options.evmCallCalls?.push({ to, data });
      if (options.evmCallError) {
        throw new Error("RPC https://secret.example unavailable");
      }
      return options.evmCallResult ?? "0x";
    },
    getBlockNumber: async () => options.anchorBlock ?? 54_321,
    sendRawTransaction: async (raw) => {
      options.relayCalls?.push(raw);
      if (options.relayError || options.relayFailure !== undefined) {
        throw options.relayFailure ??
          new Error("RPC https://secret.example unavailable");
      }
      return options.relayHash ?? `0x${hash(0x7777)}`;
    },
    getTransactionCount: async (address, tag) => {
      options.accountCalls?.push({
        method: "getTransactionCount",
        address,
        tag,
      });
      if (options.accountError) {
        throw new Error("RPC https://secret.example unavailable");
      }
      return options.accountNonce ?? 7;
    },
    getBalance: async (address, tag) => {
      options.accountCalls?.push({
        method: "getBalance",
        address,
        tag,
      });
      if (options.accountError) {
        throw new Error("RPC https://secret.example unavailable");
      }
      return options.accountBalance ?? 1_000_000_000_000_000_000n;
    },
    feeData: async () => {
      if (options.evmFeeError) {
        throw new Error("RPC https://secret.example unavailable");
      }
      return options.evmFeeData ?? {
        baseFeePerGas: 100_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
        maxFeePerGas: 300_000_000n,
      };
    },
    estimateGas: async (transaction) => {
      options.estimateGasCalls?.push(transaction);
      if (options.estimateGasError) {
        throw new Error("RPC https://secret.example unavailable");
      }
      return options.estimateGasResult ?? 123_456n;
    },
    getTransactionReceipt: async (txHash) => {
      options.receiptCalls?.push(txHash);
      if (options.receiptError) {
        throw new Error("RPC https://secret.example unavailable");
      }
      return options.receipt ?? null;
    },
  };
  return {
    isRunning: () => options.running ?? true,
    isNetworkLoaded: () => options.networkLoaded ?? true,
    readiness: () =>
      options.readiness ?? {
        ready: options.ready ?? true,
        state: options.ready === false ? "syncing" : "ready",
        retryAttempt: 0,
        lastCompletedAt: options.ready === false ? null : 1,
      },
    scanActivity: () => ({ utxo: false, txid: false }),
    lastSyncedBlock: async (network, txidVersion) => {
      options.lastSyncedBlockCalls?.push({ network, txidVersion });
      if (options.lastSyncedBlock === null) return undefined;
      return options.lastSyncedBlock ??
        (txidVersion === TXIDVersion.V3_PoseidonMerkle ? 77_777 : 12_345);
    },
    tree: () => tree,
    provider: () => provider,
  };
};

const withServer = async (
  source: LightIndexSource | undefined,
  run: (base: string) => Promise<void>,
  options: {
    enabled?: boolean;
    corsOrigins?: string[];
    maxTrees?: number;
    relayEnabled?: boolean;
    relayMaxBytes?: number;
    relayRatePerMinute?: number;
    evmRatePerMinute?: number;
    anchorRatePerMinute?: number;
    readRatePerMinute?: number;
    extraAllowedEvmTargets?: Partial<
      Record<NetworkName, readonly string[]>
    >;
    publicActivityFetcher?: (
      network: NetworkName,
      address: string,
    ) => Promise<PublicActivityResult>;
    onRequest?: () => void;
    scan?: RemoteScanService;
    isNetworkReady?: (network: NetworkName) => boolean;
    priceSource?: FiatPriceSource;
  } = {},
) => {
  const app = express();
  app.use(
    "/api/light/v1",
    createLightApiRouter({
      enabled: options.enabled ?? true,
      source,
      corsOrigins: options.corsOrigins,
      maxTrees: options.maxTrees,
      relayEnabled: options.relayEnabled,
      relayMaxBytes: options.relayMaxBytes,
      relayRatePerMinute: options.relayRatePerMinute,
      evmRatePerMinute: options.evmRatePerMinute,
      anchorRatePerMinute: options.anchorRatePerMinute,
      readRatePerMinute: options.readRatePerMinute,
      extraAllowedEvmTargets: options.extraAllowedEvmTargets,
      publicActivityFetcher: options.publicActivityFetcher,
      scan: options.scan,
      isNetworkReady: options.isNetworkReady,
      priceSource: options.priceSource,
    }),
  );
  const server = http.createServer(app);
  server.on("request", () => options.onRequest?.());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
  }
  try {
    await run(`http://127.0.0.1:${address.port}/api/light/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
};

const query = `network=arbitrum&txidVersion=${TXIDVersion.V2_PoseidonMerkle}`;

test("concurrent cache misses share fees, prices and activity upstream work", async () => {
  let feeCalls = 0;
  let priceCalls = 0;
  let activityCalls = 0;
  let fail = false;
  let upstreamGate = Promise.resolve();
  let releaseUpstream = (): void => undefined;
  let observeRequest: (() => void) | undefined;
  const source = fakeSource();
  const provider = source.provider(NetworkName.Arbitrum);
  const call = provider.call;
  provider.call = async (transaction) => {
    feeCalls += 1;
    await upstreamGate;
    if (fail) throw new Error("upstream unavailable");
    return call(transaction);
  };
  await withServer(source, async (base) => {
    const paths = [
      "/fees?network=arbitrum",
      "/prices?network=arbitrum&currency=usd",
      `/evm/activity?network=arbitrum&address=0x${"11".repeat(20)}`,
    ];
    const batch = () => Promise.all(paths.map(async (path) => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => fetch(`${base}${path}`)),
      );
      const bodies = await Promise.all(responses.map((response) => response.json()));
      for (const body of bodies) assert.deepEqual(body, bodies[0]);
      return responses.map((response) => response.status);
    }));

    const runBatch = async () => {
      let arrivals = 0;
      let resolveArrived!: () => void;
      const arrived = new Promise<void>((resolve) => {
        resolveArrived = resolve;
      });
      upstreamGate = new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      observeRequest = () => {
        arrivals += 1;
        if (arrivals === paths.length * 8) resolveArrived();
      };
      const requests = batch();
      await Promise.race([
        arrived,
        delay(2_000).then(() => {
          throw new Error("concurrent requests did not reach the server");
        }),
      ]);
      releaseUpstream();
      const result = await requests;
      observeRequest = undefined;
      return result;
    };

    fail = true;
    assert.deepEqual(await runBatch(), paths.map(() => Array(8).fill(503)));
    assert.deepEqual([feeCalls, priceCalls, activityCalls], [3, 1, 1]);
    fail = false;
    assert.deepEqual(await runBatch(), paths.map(() => Array(8).fill(200)));
    assert.deepEqual([feeCalls, priceCalls, activityCalls], [6, 2, 2]);
    assert.deepEqual(await runBatch(), paths.map(() => Array(8).fill(200)));
    assert.deepEqual([feeCalls, priceCalls, activityCalls], [6, 2, 2]);
  }, {
    onRequest: () => observeRequest?.(),
    priceSource: async (_network, _currency, addresses) => {
      priceCalls += 1;
      await upstreamGate;
      if (fail) throw new Error("upstream unavailable");
      return Object.fromEntries(addresses.map((address) => [address, 1]));
    },
    publicActivityFetcher: async () => {
      activityCalls += 1;
      await upstreamGate;
      if (fail) throw new Error("upstream unavailable");
      return { items: [], complete: true, warnings: [] };
    },
  });
});

test("client disconnects cancel abandoned shared price loads", async () => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  let upstreamSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });

  await withServer(
    fakeSource(),
    async (base) => {
      const request = http.get(
        `${base}/prices?${query}&currency=usd`,
      );
      request.on("error", () => undefined);
      await Promise.race([
        started,
        delay(2_000).then(() => {
          throw new Error("price upstream did not start");
        }),
      ]);
      request.destroy();
      await Promise.race([
        aborted,
        delay(2_000).then(() => {
          throw new Error("price upstream was not cancelled");
        }),
      ]);
    },
    {
      priceSource: async (_network, _currency, _addresses, options) => {
        upstreamSignal = options?.signal;
        markStarted();
        return await new Promise<Record<string, number>>(
          (_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                markAborted();
                reject(options.signal?.reason);
              },
              { once: true },
            );
          },
        );
      },
    },
  );
  assert.equal(upstreamSignal?.aborted, true);
});

test("light status reports the latest tree and chain head", async () => {
  await withServer(fakeSource(), async (base) => {
    const response = await fetch(`${base}/status?${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-hush-light-protocol"), "1");
    const body = (await response.json()) as {
      protocol: number;
      network: string;
      chainId: number;
      block: number;
      tree: { latest: number; leaves: number; root: string };
      currencies: string[];
    };
    assert.equal(body.protocol, 1);
    assert.equal(body.network, "arbitrum");
    assert.equal(body.chainId, 42_161);
    assert.equal(body.block, 12_345);
    assert.equal(body.tree.latest, 2);
    assert.equal(body.tree.leaves, 4);
    assert.equal(body.tree.root, hash(0x102));
    assert.deepEqual(body.currencies, [
      "usd",
      "cny",
      "eur",
      "jpy",
      "gbp",
      "hkd",
      "sgd",
      "krw",
      "cad",
      "aud",
      "chf",
    ]);
  });
});

test("status exposes truthful readiness and a null unknown block height", async () => {
  const calls: Array<{
    network: NetworkName;
    txidVersion: TXIDVersion;
  }> = [];
  await withServer(
    fakeSource(undefined, {
      ready: false,
      lastSyncedBlock: null,
      lastSyncedBlockCalls: calls,
    }),
    async (base) => {
      const response = await fetch(`${base}/status?${query}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        block: number | null;
        ready: boolean;
        state: string;
        retryAttempt: number;
        lastCompletedAt: number | null;
        engine: { networkLoaded: boolean };
        tree: { latest: number } | null;
      };
      assert.equal(body.block, null);
      assert.equal(body.ready, false);
      assert.equal(body.state, "syncing");
      assert.equal(body.retryAttempt, 0);
      assert.equal(body.lastCompletedAt, null);
      assert.equal(body.engine.networkLoaded, true);
      assert.equal(body.tree?.latest, 2);
      assert.deepEqual(calls, [
        {
          network: NetworkName.Arbitrum,
          txidVersion: TXIDVersion.V2_PoseidonMerkle,
        },
      ]);
    },
  );

  const v3Calls: Array<{
    network: NetworkName;
    txidVersion: TXIDVersion;
  }> = [];
  await withServer(
    fakeSource(undefined, { lastSyncedBlockCalls: v3Calls }),
    async (base) => {
      const response = await fetch(
        `${base}/status?network=arbitrum&txidVersion=${TXIDVersion.V3_PoseidonMerkle}`,
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { block: number | null };
      assert.equal(body.block, 77_777);
      assert.deepEqual(v3Calls, [
        {
          network: NetworkName.Arbitrum,
          txidVersion: TXIDVersion.V3_PoseidonMerkle,
        },
      ]);
    },
  );

  await withServer(
    fakeSource(undefined, {
      running: false,
      networkLoaded: false,
      lastSyncedBlock: null,
    }),
    async (base) => {
      const response = await fetch(`${base}/status?${query}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        block: number | null;
        ready: boolean;
        state: string;
        tree: unknown;
        engine: { running: boolean; networkLoaded: boolean };
      };
      assert.equal(body.block, null);
      assert.equal(body.ready, false);
      assert.equal(body.state, "degraded");
      assert.equal(body.tree, null);
      assert.equal(body.engine.running, false);
      assert.equal(body.engine.networkLoaded, false);
    },
  );
});

test("tree queries require a completed sync while status and stateless reads stay available", async () => {
  const source = fakeSource(undefined, { ready: false });
  await withServer(source, async (base) => {
    for (const path of [
      "/trees",
      "/trees/2/notes?start=0&limit=1",
      "/trees/2/nullifiers?limit=1",
      "/trees/2/proof/0",
      "/anchor?tree=2",
    ]) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`${base}${path}${separator}${query}`);
      assert.equal(response.status, 503, path);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "LIGHT_INDEX_SYNCING",
        path,
      );
    }

    assert.equal((await fetch(`${base}/status?${query}`)).status, 200);
    assert.equal(
      (await fetch(`${base}/fees?network=arbitrum`)).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/evm/gas?network=arbitrum`)).status,
      200,
    );
  });
});

test("index state failures fail closed instead of leaking a 500", async () => {
  const runningSource = fakeSource();
  runningSource.isRunning = () => {
    throw new Error("engine state unavailable");
  };
  await withServer(runningSource, async (base) => {
    const response = await fetch(`${base}/fees?network=arbitrum`);
    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "LIGHT_INDEX_UNAVAILABLE",
    );
  });

  const loadedSource = fakeSource();
  loadedSource.isNetworkLoaded = () => {
    throw new Error("network state unavailable");
  };
  await withServer(loadedSource, async (base) => {
    const response = await fetch(`${base}/fees?network=arbitrum`);
    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "LIGHT_INDEX_UNAVAILABLE",
    );
  });
});

test("tree source acquisition failures fail closed", async () => {
  const source = fakeSource();
  source.tree = () => {
    throw new Error("engine tree is unavailable");
  };
  await withServer(source, async (base) => {
    for (const path of [
      "/trees",
      "/trees/2/notes?start=0&limit=1",
      "/trees/2/nullifiers?limit=1",
      "/trees/2/proof/0",
      "/anchor?tree=2",
    ]) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`${base}${path}${separator}${query}`);
      assert.equal(response.status, 503, path);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "LIGHT_INDEX_UNAVAILABLE",
        path,
      );
    }

    const status = await fetch(`${base}/status?${query}`);
    assert.equal(status.status, 200);
    assert.equal(
      ((await status.json()) as { tree: unknown }).tree,
      null,
    );
  });
});

test("malformed tree reads fail closed", async () => {
  const source = fakeSource();
  const tree = source.tree(
    NetworkName.Arbitrum,
    TXIDVersion.V2_PoseidonMerkle,
  );
  tree.getRoot = async () => "not-a-root";
  tree.getNullifiers = async () => ["not-a-nullifier"];
  tree.getCommitmentRange = async () => [];

  await withServer(source, async (base) => {
    for (const path of ["/trees", "/anchor?tree=2"]) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`${base}${path}${separator}${query}`);
      assert.equal(response.status, 503, path);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "LIGHT_INDEX_UNAVAILABLE",
        path,
      );
    }

    const notes = await fetch(
      `${base}/trees/2/notes?start=1&limit=2&${query}`,
    );
    assert.equal(notes.status, 503);
    assert.equal(
      ((await notes.json()) as { code: string }).code,
      "LIGHT_INDEX_UNAVAILABLE",
    );

    const nullifiers = await fetch(
      `${base}/trees/2/nullifiers?limit=2&${query}`,
    );
    assert.equal(nullifiers.status, 503);
    assert.equal(
      ((await nullifiers.json()) as { code: string }).code,
      "NULLIFIER_INDEX_UNAVAILABLE",
    );
  });
});

test("sparse and oversized index responses fail closed", async () => {
  const source = fakeSource();
  const tree = source.tree(
    NetworkName.Arbitrum,
    TXIDVersion.V2_PoseidonMerkle,
  );
  tree.getCommitmentRange = async () =>
    Array(2) as unknown as LightCommitment[];
  tree.getNullifiers = async () => Array(2) as unknown as string[];
  tree.getMerkleProof = async () => ({
    leaf: hash(1),
    elements: Array(16),
    indices: hash(3),
    root: hash(4),
  });

  await withServer(source, async (base) => {
    for (const path of [
      "/trees/2/notes?start=1&limit=2",
      "/trees/2/nullifiers?limit=2",
      "/trees/2/proof/0",
    ]) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(
        `${base}${path}${separator}${query}`,
      );
      assert.equal(response.status, 503, path);
      const body = (await response.json()) as { code: string };
      assert.match(
        body.code,
        /LIGHT_INDEX_UNAVAILABLE|NULLIFIER_INDEX_UNAVAILABLE/,
      );
    }

    tree.getNullifiers = async () => [
      nullifier(200),
      nullifier(201),
      nullifier(202),
      nullifier(203),
    ];
    const oversized = await fetch(
      `${base}/trees/2/nullifiers?limit=2&${query}`,
    );
    assert.equal(oversized.status, 503);
    assert.equal(
      ((await oversized.json()) as { code: string }).code,
      "NULLIFIER_INDEX_UNAVAILABLE",
    );
  });
});

test("light trees are capped to the most recent window", async () => {
  const lengths = Array.from({ length: 10 }, (_, index) => index + 1);
  await withServer(
    fakeSource(lengths),
    async (base) => {
      const response = await fetch(`${base}/trees?${query}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        latestTree: number;
        trees: Array<{ tree: number; leaves: number }>;
      };
      assert.equal(body.latestTree, 9);
      assert.equal(body.trees.length, 3);
      assert.deepEqual(
        body.trees.map((entry) => entry.tree),
        [7, 8, 9],
      );
      assert.deepEqual(
        body.trees.map((entry) => entry.leaves),
        [8, 9, 10],
      );
    },
    { maxTrees: 3 },
  );
});

test("removed commitment hash endpoint is not exposed", async () => {
  await withServer(fakeSource(), async (base) => {
    const response = await fetch(
      `${base}/trees/2/commitments?start=1&limit=10&${query}`,
    );
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "NOT_FOUND");
  });
});

test("notes return full commitments with absolute leaf indexes", async () => {
  await withServer(fakeSource(), async (base) => {
    const response = await fetch(
      `${base}/trees/2/notes?start=1&limit=2&${query}`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      tree: number;
      start: number;
      leaves: number;
      notes: Array<{
        hash: string;
        index: number;
        commitmentType: string;
        ciphertext: { memo: string };
      }>;
      next: number | null;
    };
    assert.equal(body.tree, 2);
    assert.equal(body.start, 1);
    assert.equal(body.leaves, 4);
    assert.deepEqual(
      body.notes.map((note) => note.index),
      [1, 2],
    );
    assert.deepEqual(
      body.notes.map((note) => note.hash),
      [hash(2_001), hash(2_002)],
    );
    assert.equal(body.notes[0]?.commitmentType, "TransactCommitmentV2");
    assert.equal(body.notes[0]?.ciphertext.memo, "0xmemo");
    assert.equal(body.next, 3);

    const last = await fetch(
      `${base}/trees/2/notes?start=3&limit=2&${query}`,
    );
    const lastBody = (await last.json()) as {
      notes: Array<{ index: number }>;
      next: number | null;
    };
    assert.deepEqual(
      lastBody.notes.map((note) => note.index),
      [3],
    );
    assert.equal(lastBody.next, null);
  });
});

test("notes reject invalid parameters and unknown trees", async () => {
  await withServer(fakeSource(), async (base) => {
    for (const path of [
      "/trees/9/notes?start=0&limit=1",
      "/trees/2/notes?start=-1&limit=1",
      "/trees/2/notes?start=0&limit=0",
      "/trees/2/notes?start=0&limit=257",
    ]) {
      const response = await fetch(`${base}${path}&${query}`);
      assert.ok(
        response.status === 400 || response.status === 404,
        `${path} returned ${response.status}`,
      );
      const body = (await response.json()) as { code: string };
      assert.match(body.code, /INVALID_REQUEST|TREE_NOT_FOUND/);
    }
  });
});

test("nullifiers use a stable cursor and expose the last item as next", async () => {
  await withServer(fakeSource(), async (base) => {
    const first = await fetch(`${base}/trees/2/nullifiers?limit=2&${query}`);
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      tree: number;
      nullifiers: string[];
      next: string | null;
    };
    assert.equal(firstBody.tree, 2);
    assert.deepEqual(firstBody.nullifiers, [
      nullifier(200),
      nullifier(201),
    ]);
    assert.equal(firstBody.next, nullifier(201));

    const second = await fetch(
      `${base}/trees/2/nullifiers?limit=2&after=${firstBody.next}&${query}`,
    );
    const secondBody = (await second.json()) as {
      nullifiers: string[];
      next: string | null;
    };
    assert.deepEqual(secondBody.nullifiers, [
      nullifier(202),
      nullifier(203),
    ]);
    assert.equal(secondBody.next, null);
  });
});

test("nullifiers accept 0x cursors and reject malformed requests", async () => {
  await withServer(fakeSource(), async (base) => {
    const response = await fetch(
      `${base}/trees/2/nullifiers?limit=2&after=0x${nullifier(200)}&${query}`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      nullifiers: string[];
    };
    assert.deepEqual(body.nullifiers, [
      nullifier(201),
      nullifier(202),
    ]);

    for (const path of [
      "/trees/9/nullifiers?limit=1",
      "/trees/2/nullifiers?limit=0",
      "/trees/2/nullifiers?limit=2001",
      "/trees/2/nullifiers?after=nope",
    ]) {
      const invalid = await fetch(`${base}${path}&${query}`);
      assert.ok(
        invalid.status === 400 || invalid.status === 404,
        `${path} returned ${invalid.status}`,
      );
      const error = (await invalid.json()) as { code: string };
      assert.match(error.code, /INVALID_REQUEST|TREE_NOT_FOUND/);
    }
  });
});

test("nullifier index failures fail closed with a specific code", async () => {
  await withServer(
    fakeSource([3, 0, 4], { nullifierError: true }),
    async (base) => {
      const response = await fetch(
        `${base}/trees/2/nullifiers?limit=2&${query}`,
      );
      assert.equal(response.status, 503);
      const body = (await response.json()) as { code: string };
      assert.equal(body.code, "NULLIFIER_INDEX_UNAVAILABLE");
    },
  );
});

test("proof returns the RAILGUN-style witness", async () => {
  await withServer(fakeSource(), async (base) => {
    const response = await fetch(`${base}/trees/2/proof/3?${query}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      tree: number;
      leaf: number;
      proof: { leaf: string; elements: string[]; indices: string; root: string };
    };
    assert.equal(body.tree, 2);
    assert.equal(body.leaf, 3);
    assert.equal(body.proof.elements.length, 16);
    assert.equal(body.proof.leaf, hash(2_003));

    const missing = await fetch(`${base}/trees/2/proof/4?${query}`);
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { code: string }).code,
      "LEAF_NOT_FOUND",
    );
  });
});

test("proof values are normalized and malformed proofs fail closed", async () => {
  const source = fakeSource();
  const tree = source.tree(
    NetworkName.Arbitrum,
    TXIDVersion.V2_PoseidonMerkle,
  );
  tree.getMerkleProof = async () => ({
    leaf: `0x${hash(1).toUpperCase()}`,
    elements: Array.from(
      { length: 16 },
      () => `0x${hash(2).toUpperCase()}`,
    ),
    indices: `0x${hash(3).toUpperCase()}`,
    root: `0x${hash(4).toUpperCase()}`,
  });
  await withServer(source, async (base) => {
    const response = await fetch(`${base}/trees/2/proof/0?${query}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      proof: {
        leaf: string;
        elements: string[];
        indices: string;
        root: string;
      };
    };
    assert.equal(body.proof.leaf, hash(1));
    assert.deepEqual(body.proof.elements, Array(16).fill(hash(2)));
    assert.equal(body.proof.indices, hash(3));
    assert.equal(body.proof.root, hash(4));
  });

  tree.getMerkleProof = async () => ({
    leaf: hash(1),
    elements: [],
    indices: hash(3),
    root: hash(4),
  });
  await withServer(source, async (base) => {
    const response = await fetch(`${base}/trees/2/proof/0?${query}`);
    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "LIGHT_INDEX_UNAVAILABLE",
    );
  });
});

test("negative latest tree pointers fail closed", async () => {
  const source = fakeSource();
  const tree = source.tree(
    NetworkName.Arbitrum,
    TXIDVersion.V2_PoseidonMerkle,
  );
  tree.getLatestTreeAndIndex = async () => ({ tree: -1, index: 0 });
  await withServer(source, async (base) => {
    const response = await fetch(`${base}/trees?${query}`);
    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "LIGHT_INDEX_UNAVAILABLE",
    );
  });
});

test("prices return allowlist quotes and reuse the cached source", async () => {
  const priceCalls: Array<{
    network: string;
    currency: string;
    addresses: readonly string[];
  }> = [];
  const priceSource: FiatPriceSource = async (
    network,
    currency,
    addresses,
  ) => {
    priceCalls.push({ network, currency, addresses });
    return Object.fromEntries(
      addresses.map((address) => [address.toLowerCase(), 1.5]),
    );
  };
  await withServer(
    fakeSource(),
    async (base) => {
      const response = await fetch(`${base}/prices?${query}&currency=usd`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        ok: boolean;
        network: string;
        currency: string;
        prices: Record<string, number>;
        updatedAt: number;
      };
      assert.equal(body.ok, true);
      assert.equal(body.network, "arbitrum");
      assert.equal(body.currency, "usd");
      assert.equal(
        body.prices["0x0000000000000000000000000000000000000000"],
        1.5,
      );
      assert.ok(Object.keys(body.prices).length > 1);
      assert.equal(typeof body.updatedAt, "number");

      await fetch(`${base}/prices?${query}&currency=usd`);
      assert.equal(priceCalls.length, 1);
      assert.ok(priceCalls[0]!.addresses.includes("0x0000000000000000000000000000000000000000"));
      assert.ok(priceCalls[0]!.addresses.length > 1);

      const invalid = await fetch(`${base}/prices?${query}&currency=twd`);
      assert.equal(invalid.status, 400);
      assert.equal(
        ((await invalid.json()) as { code: string }).code,
        "INVALID_REQUEST",
      );
    },
    { priceSource },
  );
});

test("price source failures fail closed", async () => {
  await withServer(
    fakeSource(),
    async (base) => {
      const response = await fetch(`${base}/prices?${query}&currency=usd`);
      assert.equal(response.status, 503);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "PRICE_UNAVAILABLE",
      );
    },
    {
      priceSource: async () => {
        throw new Error("upstream unavailable");
      },
    },
  );
});

test("fiat price source reads llama quotes and converts fiat", async () => {
  const calls: string[] = [];
  const redirects: Array<RequestInit["redirect"]> = [];
  const source = createFiatPriceSource({
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      redirects.push(init?.redirect);
      const payload = String(url).includes("frankfurter")
        ? { base: "USD", rates: { CNY: 7, KRW: 1400 } }
        : {
            coins: {
              "arbitrum:0x0000000000000000000000000000000000000000": { price: 3000 },
              "arbitrum:0x1111111111111111111111111111111111111111": { price: 1.5 },
            },
          };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch,
  });
  const usd = await source("arbitrum", "usd", [
    "0x0000000000000000000000000000000000000000",
    "0x1111111111111111111111111111111111111111",
  ]);
  assert.equal(usd["0x0000000000000000000000000000000000000000"], 3000);
  assert.equal(
    usd["0x1111111111111111111111111111111111111111"],
    1.5,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(redirects, ["error"]);
  assert.ok(calls[0]!.includes("coins.llama.fi"));
  assert.ok(calls[0]!.includes("arbitrum:0x0000000000000000000000000000000000000000"));

  const cny = await source("arbitrum", "cny", ["0x0000000000000000000000000000000000000000"]);
  assert.equal(cny["0x0000000000000000000000000000000000000000"], 21_000);
  assert.equal(calls.length, 3);
  assert.ok(calls[2]!.includes("symbols=CNY"));

  const krw = await source("arbitrum", "krw", ["0x0000000000000000000000000000000000000000"]);
  assert.equal(krw["0x0000000000000000000000000000000000000000"], 4_200_000);
  assert.equal(calls.length, 5);
  assert.ok(calls[4]!.includes("symbols=KRW"));
});

test("fiat price requests abort peers after the first failure", async () => {
  let peerAborted = false;
  const source = createFiatPriceSource({
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (String(url).includes("frankfurter")) {
        throw new Error("fx unavailable");
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            peerAborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }) as typeof fetch,
  });
  await assert.rejects(
    source("arbitrum", "cny", [
      "0x0000000000000000000000000000000000000000",
    ]),
    /fx unavailable/,
  );
  assert.equal(peerAborted, true);
});

test("anchor verifies the local root through proxy rootHistory", async () => {
  const anchorCalls: Array<{ to: string; data: string }> = [];
  await withServer(
    fakeSource(undefined, {
      anchorCalls,
      anchored: true,
      chainRoot: `0x${hash(0x999)}`,
    }),
    async (base) => {
      const response = await fetch(`${base}/anchor?${query}&tree=2`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        network: string;
        txidVersion: string;
        tree: number;
        leaves: number;
        localRoot: string;
        root: string;
        anchored: boolean;
        chainRoot: string;
        block: number;
        checkedAt: number;
      };
      assert.equal(body.network, "arbitrum");
      assert.equal(body.txidVersion, TXIDVersion.V2_PoseidonMerkle);
      assert.equal(body.tree, 2);
      assert.equal(body.leaves, 4);
      assert.equal(body.localRoot, hash(0x102));
      assert.equal(body.root, hash(0x102));
      assert.equal(body.anchored, true);
      assert.equal(body.chainRoot, hash(0x999));
      assert.equal(body.block, 54_321);
      assert.equal(typeof body.checkedAt, "number");

      const proxyContract =
        NETWORK_CONFIG[NetworkName.Arbitrum].proxyContract;
      assert.ok(anchorCalls.every((call) => call.to === proxyContract));
      assert.ok(
        anchorCalls.some(
          (call) =>
            call.data ===
            ANCHOR_ABI.encodeFunctionData("rootHistory", [
              2n,
              `0x${hash(0x102)}`,
            ]),
        ),
      );
      assert.ok(
        anchorCalls.some(
          (call) =>
            call.data === ANCHOR_ABI.encodeFunctionData("merkleRoot"),
        ),
      );

      const callCount = anchorCalls.length;
      const cached = await fetch(`${base}/anchor?${query}&tree=2`);
      assert.equal(cached.status, 200);
      const cachedBody = (await cached.json()) as { checkedAt: number };
      assert.equal(cachedBody.checkedAt, body.checkedAt);
      assert.equal(anchorCalls.length, callCount);
    },
  );
});

test("anchor checks an explicit query root and reports false", async () => {
  const anchorCalls: Array<{ to: string; data: string }> = [];
  const requestedRoot = hash(0xdead);
  await withServer(
    fakeSource(undefined, { anchorCalls, anchored: false }),
    async (base) => {
      const response = await fetch(
        `${base}/anchor?${query}&tree=2&root=0x${requestedRoot}`,
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        localRoot: string;
        root: string;
        anchored: boolean;
      };
      assert.equal(body.localRoot, hash(0x102));
      assert.equal(body.root, requestedRoot);
      assert.equal(body.anchored, false);
      assert.ok(
        anchorCalls.some(
          (call) =>
            call.data ===
            ANCHOR_ABI.encodeFunctionData("rootHistory", [
              2n,
              `0x${requestedRoot}`,
            ]),
        ),
      );
    },
  );
});

test("anchor cache does not hide updated local tree metadata", async () => {
  const lengths = [3, 0, 1];
  const anchorCalls: Array<{ to: string; data: string }> = [];
  const requestedRoot = hash(0xdead);
  await withServer(
    fakeSource(lengths, { anchorCalls }),
    async (base) => {
      const request = (): Promise<Response> =>
        fetch(`${base}/anchor?${query}&tree=2&root=${requestedRoot}`);

      const first = await request();
      assert.equal(first.status, 200);
      assert.equal(
        ((await first.json()) as { leaves: number }).leaves,
        1,
      );

      lengths[2] = 4;
      const second = await request();
      assert.equal(second.status, 200);
      assert.equal(
        ((await second.json()) as { leaves: number }).leaves,
        4,
      );
      assert.equal(anchorCalls.length, 4);
    },
  );
});

test("anchor uses the zero root for an empty tree", async () => {
  const anchorCalls: Array<{ to: string; data: string }> = [];
  await withServer(
    fakeSource(undefined, { anchorCalls }),
    async (base) => {
      const response = await fetch(
        `${base}/anchor?${query}&tree=1&root=${"0".repeat(64)}`,
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        leaves: number;
        localRoot: string;
        root: string;
      };
      assert.equal(body.leaves, 0);
      assert.equal(body.localRoot, "0".repeat(64));
      assert.equal(body.root, "0".repeat(64));
      assert.ok(
        anchorCalls.some(
          (call) =>
            call.data ===
            ANCHOR_ABI.encodeFunctionData("rootHistory", [
              1n,
              `0x${"0".repeat(64)}`,
            ]),
        ),
      );
    },
  );
});

test("anchor reads the v3 accumulator root contract", async () => {
  const anchorCalls: Array<{ to: string; data: string }> = [];
  const networkConfig = NETWORK_CONFIG[NetworkName.Arbitrum];
  const previous = networkConfig.poseidonMerkleAccumulatorV3Contract;
  const accumulator = `0x${"ab".repeat(20)}`;
  networkConfig.poseidonMerkleAccumulatorV3Contract = accumulator;
  try {
    await withServer(
      fakeSource(undefined, { anchorCalls }),
      async (base) => {
        const response = await fetch(
          `${base}/anchor?network=arbitrum&txidVersion=${TXIDVersion.V3_PoseidonMerkle}&tree=2`,
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          txidVersion: string;
          chainRoot: string;
        };
        assert.equal(body.txidVersion, TXIDVersion.V3_PoseidonMerkle);
        assert.equal(body.chainRoot, hash(0x999));
        assert.ok(anchorCalls.every((call) => call.to === accumulator));
        assert.ok(
          anchorCalls.some((call) =>
            call.data.startsWith(ACCUMULATOR_ROOT_SELECTOR),
          ),
        );
      },
    );
  } finally {
    networkConfig.poseidonMerkleAccumulatorV3Contract = previous;
  }
});

test("anchor rejects invalid roots and unknown trees", async () => {
  await withServer(fakeSource(), async (base) => {
    for (const path of [
      `/anchor?${query}&tree=9`,
      `/anchor?${query}&tree=-1`,
      `/anchor?${query}&tree=abc`,
      `/anchor?${query}&tree=2&root=abc`,
      `/anchor?${query}&tree=2&root=0xzz`,
      `/anchor?${query}&tree=2&root=${"0".repeat(63)}`,
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.ok(
        response.status === 400 || response.status === 404,
        `${path} returned ${response.status}`,
      );
      const body = (await response.json()) as { code: string };
      assert.match(body.code, /INVALID_REQUEST|TREE_NOT_FOUND/);
    }
  });
});

test("anchor RPC failures are sanitized and retried for the next caller", async () => {
  await withServer(
    fakeSource(undefined, { anchorError: true }),
    async (base) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${base}/anchor?${query}&tree=2`);
        assert.equal(response.status, 503);
        const text = await response.text();
        assert.match(text, /ANCHOR_UNAVAILABLE/);
        assert.doesNotMatch(text, /secret\.example|https:/);
      }
    },
  );
});

test("concurrent anchor cache misses share one upstream check", async () => {
  const anchorCalls: Array<{ to: string; data: string }> = [];
  const root = hash(0xdead);
  await withServer(
    fakeSource(undefined, {
      anchorCalls,
      anchorDelayMs: 25,
      anchored: false,
    }),
    async (base) => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(`${base}/anchor?${query}&tree=2&root=${root}`),
        ),
      );
      assert.deepEqual(
        responses.map((response) => response.status),
        Array(8).fill(200),
      );
      assert.equal(anchorCalls.length, 2);
    },
  );
});

test("anchor has an independent per-IP rate limit", async () => {
  await withServer(
    fakeSource(),
    async (base) => {
      const request = (): Promise<Response> =>
        fetch(`${base}/anchor?${query}&tree=2`);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await request()).status, 200);
      }
      const limited = await request();
      assert.equal(limited.status, 429);
      assert.equal(
        ((await limited.json()) as { code: string }).code,
        "RATE_LIMITED",
      );
    },
    { anchorRatePerMinute: 10 },
  );
});

test("stateless read routes share a per-IP rate limit", async () => {
  await withServer(
    fakeSource(),
    async (base) => {
      const paths = [
        `/status?${query}`,
        `/trees?${query}`,
        "/fees?network=arbitrum",
        `/prices?${query}&currency=usd`,
      ];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await fetch(`${base}${paths[attempt % paths.length]}`);
        assert.equal(response.status, 200);
      }
      const limited = await fetch(`${base}${paths[0]}`);
      assert.equal(limited.status, 429);
      assert.equal(
        ((await limited.json()) as { code: string }).code,
        "RATE_LIMITED",
      );
    },
    {
      readRatePerMinute: 10,
      priceSource: async (_network, _currency, addresses) =>
        Object.fromEntries(addresses.map((address) => [address, 1])),
    },
  );
});

const ARBITRUM_PROXY = NETWORK_CONFIG[NetworkName.Arbitrum].proxyContract;
const ARBITRUM_TOKEN = networkFor(NetworkName.Arbitrum).tokens[0]!.address;
const EVM_ADDRESS = `0x${"11".repeat(20)}`;
const EVM_FROM = `0x${"22".repeat(20)}`;
const EVM_DENIED_TARGET = `0x${"01".repeat(20)}`;
const EVM_HASH = `0x${hash(0x4242)}`;

test("evm account returns pending nonce, latest balance, and block", async () => {
  const accountCalls: Array<{
    method: "getTransactionCount" | "getBalance";
    address: string;
    tag: string;
  }> = [];
  await withServer(
    fakeSource(undefined, {
      accountNonce: 9,
      accountBalance: 123_456_789_012_345_678n,
      accountCalls,
    }),
    async (base) => {
      const mixedCaseAddress = `0x${"AB".repeat(20)}`;
      const response = await fetch(
        `${base}/evm/account?network=arbitrum&address=${mixedCaseAddress}`,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = (await response.json()) as {
        network: string;
        address: string;
        nonce: string;
        balance: string;
        block: number;
      };
      assert.equal(body.network, "arbitrum");
      assert.equal(body.address, mixedCaseAddress.toLowerCase());
      assert.equal(body.nonce, "9");
      assert.equal(body.balance, "123456789012345678");
      assert.equal(body.block, 54_321);
      assert.deepEqual(accountCalls, [
        {
          method: "getTransactionCount",
          address: mixedCaseAddress.toLowerCase(),
          tag: "pending",
        },
        {
          method: "getBalance",
          address: mixedCaseAddress.toLowerCase(),
          tag: "latest",
        },
      ]);
    },
  );
});

test("evm account rejects addresses that are not 20-byte hex", async () => {
  await withServer(fakeSource(), async (base) => {
    for (const address of [
      "",
      "0x1234",
      `0x${"11".repeat(19)}`,
      `0x${"11".repeat(21)}`,
      `0x${"zz".repeat(20)}`,
      `${"11".repeat(20)}`,
    ]) {
      const response = await fetch(
        `${base}/evm/account?network=arbitrum&address=${address}`,
      );
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "INVALID_REQUEST",
      );
    }
  });
});

test("evm account rejects out-of-range provider integers", async () => {
  await withServer(
    fakeSource(undefined, { accountBalance: 1n << 256n }),
    async (base) => {
      const response = await fetch(
        `${base}/evm/account?network=arbitrum&address=${EVM_ADDRESS}`,
      );
      assert.equal(response.status, 503);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "EVM_RPC_UNAVAILABLE",
      );
    },
  );
});

test("evm gas returns provider fee values as decimal strings", async () => {
  await withServer(
    fakeSource(undefined, {
      evmFeeData: {
        baseFeePerGas: 100_000_000n,
        maxPriorityFeePerGas: 2_000_000n,
        maxFeePerGas: 500_000_000n,
      },
    }),
    async (base) => {
      const response = await fetch(`${base}/evm/gas?network=arbitrum`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        network: "arbitrum",
        block: "54321",
        baseFeePerGas: "100000000",
        maxPriorityFeePerGas: "2000000",
        maxFeePerGas: "500000000",
      });
    },
  );
});

test("evm gas keeps unavailable 1559 fields null", async () => {
  await withServer(
    fakeSource(undefined, {
      evmFeeData: {
        baseFeePerGas: null,
        maxPriorityFeePerGas: null,
        maxFeePerGas: null,
      },
    }),
    async (base) => {
      const response = await fetch(`${base}/evm/gas?network=arbitrum`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        network: "arbitrum",
        block: "54321",
        baseFeePerGas: null,
        maxPriorityFeePerGas: null,
        maxFeePerGas: null,
      });
    },
  );
});

test("evm gas failures are sanitized", async () => {
  await withServer(
    fakeSource(undefined, { evmFeeError: true }),
    async (base) => {
      const response = await fetch(`${base}/evm/gas?network=arbitrum`);
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.match(text, /EVM_RPC_UNAVAILABLE/);
      assert.doesNotMatch(text, /secret\.example|https:/);
    },
  );
});

test("evm call denies unallowlisted targets and allows contract calls", async () => {
  const evmCallCalls: Array<{ to: string; data: string }> = [];
  const callResult = `0x${hash(0xabc)}`;
  await withServer(
    fakeSource(undefined, { evmCallCalls, evmCallResult: callResult }),
    async (base) => {
      const denied = await fetch(`${base}/evm/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          to: EVM_DENIED_TARGET,
          data: "0x12345678",
        }),
      });
      assert.equal(denied.status, 403);
      assert.equal(
        ((await denied.json()) as { code: string }).code,
        "TARGET_NOT_ALLOWED",
      );
      assert.deepEqual(evmCallCalls, []);

      const mixedCaseProxy =
        `0x${ARBITRUM_PROXY.slice(2).toUpperCase()}`;
      const allowed = await fetch(`${base}/evm/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          to: mixedCaseProxy,
          data: "0x12345678",
        }),
      });
      assert.equal(allowed.status, 200);
      assert.deepEqual(await allowed.json(), { result: callResult });
      assert.deepEqual(evmCallCalls, [
        {
          to: mixedCaseProxy.toLowerCase(),
          data: "0x12345678",
        },
      ]);
    },
  );
});

test("evm call rejects malformed and oversized provider results", async () => {
  for (const result of [
    "0xabc",
    `0x${"aa".repeat(64 * 1_024 + 1)}`,
  ]) {
    await withServer(
      fakeSource(undefined, { evmCallResult: result }),
      async (base) => {
        const response = await fetch(`${base}/evm/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum",
            to: ARBITRUM_TOKEN,
            data: "0x12345678",
          }),
        });
        assert.equal(response.status, 503);
        const text = await response.text();
        assert.match(text, /EVM_RPC_UNAVAILABLE/);
        assert.doesNotMatch(text, /invalid call data|oversized call data/);
      },
    );
  }
});

test("both arbitrum USDC contracts are allowlisted", async () => {
  const usdcTokens = networkFor(NetworkName.Arbitrum).tokens.filter(
    (entry) => entry.symbol === "USDC" || entry.symbol === "USDC.e",
  );
  assert.equal(usdcTokens.length, 2);
  await withServer(fakeSource(), async (base) => {
    for (const token of usdcTokens) {
      const response = await fetch(`${base}/evm/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          to: token.address,
          data: "0x70a08231",
        }),
      });
      assert.equal(response.status, 200);
    }
  });
});

test("configured extra EVM targets are explicit and allowlisted", async () => {
  const extraTarget = `0x${"ab".repeat(20)}`;
  await withServer(
    fakeSource(),
    async (base) => {
      const response = await fetch(`${base}/evm/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          to: `0x${"AB".repeat(20)}`,
          data: "0x12345678",
        }),
      });
      assert.equal(response.status, 200);
    },
    {
      extraAllowedEvmTargets: {
        [NetworkName.Arbitrum]: [extraTarget],
      },
    },
  );

  await withServer(
    fakeSource(),
    async (base) => {
      const response = await fetch(`${base}/evm/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          to: `0x${"CD".repeat(20)}`,
          data: "0x12345678",
        }),
      });
      assert.equal(response.status, 403);
    },
    {
      extraAllowedEvmTargets: {
        [NetworkName.Ethereum]: [`0x${"cd".repeat(20)}`],
      },
    },
  );

  assert.throws(
    () =>
      createLightApiRouter({
        enabled: true,
        extraAllowedEvmTargets: {
          [NetworkName.Arbitrum]: ["0x1234"],
        },
      }),
    /Invalid extra EVM target/,
  );
});

test("evm estimate gas accepts decimal and hex values", async () => {
  const estimateGasCalls: Array<{
    from: string;
    to: string;
    data: string;
    value?: bigint;
  }> = [];
  await withServer(
    fakeSource(undefined, {
      estimateGasCalls,
      estimateGasResult: 456_789n,
    }),
    async (base) => {
      for (const value of ["123", "0x7b"]) {
        const response = await fetch(`${base}/evm/estimate-gas`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum",
            from: EVM_FROM,
            to: ARBITRUM_TOKEN,
            data: "0xabcdef12",
            value,
          }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { gas: "456789" });
      }
      assert.deepEqual(estimateGasCalls, [
        {
          from: EVM_FROM,
          to: ARBITRUM_TOKEN.toLowerCase(),
          data: "0xabcdef12",
          value: 123n,
        },
        {
          from: EVM_FROM,
          to: ARBITRUM_TOKEN.toLowerCase(),
          data: "0xabcdef12",
          value: 123n,
        },
      ]);
    },
  );
});

test("evm estimate gas allows native transfers to any target", async () => {
  const estimateGasCalls: Array<{
    from: string;
    to: string;
    data: string;
    value?: bigint;
  }> = [];
  await withServer(
    fakeSource(undefined, {
      estimateGasCalls,
      estimateGasResult: 21_000n,
    }),
    async (base) => {
      const allowed = await fetch(`${base}/evm/estimate-gas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          from: EVM_FROM,
          to: EVM_DENIED_TARGET,
          data: "0x",
          value: "1",
        }),
      });
      assert.equal(allowed.status, 200);
      assert.deepEqual(await allowed.json(), { gas: "21000" });

      for (const request of [
        {
          to: EVM_DENIED_TARGET,
          data: "0x12345678",
          value: "1",
        },
        {
          to: EVM_DENIED_TARGET,
          data: "0x",
          value: "0",
        },
      ]) {
        const denied = await fetch(`${base}/evm/estimate-gas`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum",
            from: EVM_FROM,
            ...request,
          }),
        });
        assert.equal(denied.status, 403);
        assert.equal(
          ((await denied.json()) as { code: string }).code,
          "TARGET_NOT_ALLOWED",
        );
      }

      assert.deepEqual(estimateGasCalls, [
        {
          from: EVM_FROM,
          to: EVM_DENIED_TARGET,
          data: "0x",
          value: 1n,
        },
      ]);
    },
  );
});

test("evm estimate gas rejects oversized data and out-of-range values", async () => {
  const estimateGasCalls: Array<{
    from: string;
    to: string;
    data: string;
    value?: bigint;
  }> = [];
  await withServer(
    fakeSource(undefined, { estimateGasCalls }),
    async (base) => {
      const cases = [
        {
          data: `0x${"00".repeat(16 * 1_024 + 1)}`,
          value: "0",
        },
        {
          data: "0xabc",
          value: "0",
        },
        {
          data: "0xabcdef12",
          value: (1n << 256n).toString(),
        },
        {
          data: "0xabcdef12",
          value: "-1",
        },
        {
          data: "0xabcdef12",
          value: "9".repeat(60_000),
        },
        {
          data: "0xabcdef12",
          value: `0x${"f".repeat(65)}`,
        },
      ];
      for (const entry of cases) {
        const response = await fetch(`${base}/evm/estimate-gas`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum",
            from: EVM_FROM,
            to: ARBITRUM_TOKEN,
            ...entry,
          }),
        });
        assert.equal(response.status, 400);
        assert.equal(
          ((await response.json()) as { code: string }).code,
          "INVALID_REQUEST",
        );
      }
      assert.deepEqual(estimateGasCalls, []);
    },
  );
});

test("evm receipt reports pending, success, and reverted status", async () => {
  await withServer(
    fakeSource(undefined, { receipt: null }),
    async (base) => {
      const response = await fetch(
        `${base}/evm/receipt?network=arbitrum&hash=${EVM_HASH}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        found: false,
        status: "pending",
      });
    },
  );

  await withServer(
    fakeSource(undefined, {
      receipt: {
        status: 1,
        blockNumber: 12_345_678,
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n,
      },
    }),
    async (base) => {
      const response = await fetch(
        `${base}/evm/receipt?network=arbitrum&hash=${EVM_HASH}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        found: true,
        status: "success",
        blockNumber: "12345678",
        gasUsed: "21000",
        effectiveGasPrice: "1000000000",
      });
    },
  );

  await withServer(
    fakeSource(undefined, {
      receipt: {
        status: 0,
        blockNumber: 12_345_679,
        gasUsed: 54_321n,
        effectiveGasPrice: 2_000_000_000n,
      },
    }),
    async (base) => {
      const response = await fetch(
        `${base}/evm/receipt?network=arbitrum&hash=${EVM_HASH}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        found: true,
        status: "reverted",
        blockNumber: "12345679",
        gasUsed: "54321",
        effectiveGasPrice: "2000000000",
      });
    },
  );
});

test("evm activity serves public history with a short cache", async () => {
  const item: PublicActivityItem = {
    hash: EVM_HASH,
    timestamp: Date.parse("2026-11-24T12:00:00.000Z"),
    blockNumber: 12_345_678,
    fee: "21000000000000",
    status: "completed",
    from: EVM_ADDRESS,
    to: `0x${"22".repeat(20)}`,
    legs: [
      {
        direction: "out",
        tokenAddress: null,
        symbol: "ETH",
        decimals: 18,
        value: "1000000000000000000",
      },
    ],
  };
  let calls = 0;

  await withServer(
    fakeSource(),
    async (base) => {
      const url = `${base}/evm/activity?network=arbitrum&address=${EVM_ADDRESS}`;
      const first = await fetch(url);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), {
        network: "arbitrum",
        address: EVM_ADDRESS,
        items: [item],
        complete: true,
        warnings: [],
      });

      const second = await fetch(url);
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), {
        network: "arbitrum",
        address: EVM_ADDRESS,
        items: [item],
        complete: true,
        warnings: [],
      });
    },
    {
      publicActivityFetcher: async () => {
        calls += 1;
        return { items: [item], complete: true, warnings: [] };
      },
    },
  );

  assert.equal(calls, 1);
});

test("evm activity rejects invalid addresses and unavailable upstreams", async () => {
  await withServer(fakeSource(), async (base) => {
    const invalid = await fetch(
      `${base}/evm/activity?network=arbitrum&address=0x1234`,
    );
    assert.equal(invalid.status, 400);
  });

  await withServer(
    fakeSource(),
    async (base) => {
      const response = await fetch(
        `${base}/evm/activity?network=arbitrum&address=${EVM_ADDRESS}`,
      );
      assert.equal(response.status, 503);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "ACTIVITY_UNAVAILABLE",
      );
    },
    {
      publicActivityFetcher: async () => {
        throw new Error("upstream unavailable");
      },
    },
  );
});

test("evm activity marks partial upstream history explicitly", async () => {
  await withServer(
    fakeSource(),
    async (base) => {
      const response = await fetch(
        `${base}/evm/activity?network=arbitrum&address=${EVM_ADDRESS}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        network: "arbitrum",
        address: EVM_ADDRESS,
        items: [],
        complete: false,
        warnings: ["TOKEN_TRANSFER_HISTORY_UNAVAILABLE"],
      });
    },
    {
      publicActivityFetcher: async () => ({
        items: [],
        complete: false,
        warnings: ["TOKEN_TRANSFER_HISTORY_UNAVAILABLE"],
      }),
    },
  );
});

test("evm read endpoints share a per-IP rate limit", async () => {
  await withServer(
    fakeSource(),
    async (base) => {
      assert.equal(
        (
          await fetch(
            `${base}/evm/account?network=arbitrum&address=${EVM_ADDRESS}`,
          )
        ).status,
        200,
      );
      assert.equal(
        (await fetch(`${base}/evm/gas?network=arbitrum`)).status,
        200,
      );
      const limited = await fetch(`${base}/evm/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          to: ARBITRUM_PROXY,
          data: "0x",
        }),
      });
      assert.equal(limited.status, 429);
      assert.equal(
        ((await limited.json()) as { code: string }).code,
        "RATE_LIMITED",
      );
    },
    { evmRatePerMinute: 2 },
  );
});

test("unsupported request encodings fail as client errors", async () => {
  await withServer(fakeSource(), async (base) => {
    const response = await fetch(`${base}/evm/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=latin1",
      },
      body: JSON.stringify({
        network: "arbitrum",
        to: ARBITRUM_PROXY,
        data: "0x",
      }),
    });
    assert.equal(response.status, 415);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "INVALID_REQUEST",
    );
  });
});

test("relay is disabled by default", async () => {
  await withServer(fakeSource(), async (base) => {
    const response = await fetch(`${base}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        network: "arbitrum",
        rawTransaction: "0x02aabb",
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "RELAY_DISABLED",
    );
  });
});

test("relay gates and rate limits run before request body parsing", async () => {
  const relayCalls: string[] = [];
  const oversizedBody = JSON.stringify({
    network: "arbitrum",
    rawTransaction: "0x02aabb",
    padding: "x".repeat(70 * 1_024),
  });

  await withServer(
    fakeSource(undefined, { relayCalls }),
    async (base) => {
      const disabled = await fetch(`${base}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversizedBody,
      });
      assert.equal(disabled.status, 403);
      assert.equal(
        ((await disabled.json()) as { code: string }).code,
        "RELAY_DISABLED",
      );
    },
  );

  await withServer(
    fakeSource(undefined, { relayCalls }),
    async (base) => {
      const accepted = await fetch(`${base}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          rawTransaction: "0x02aabb",
        }),
      });
      assert.equal(accepted.status, 200);

      const limited = await fetch(`${base}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"network":',
      });
      assert.equal(limited.status, 429);
      assert.equal(
        ((await limited.json()) as { code: string }).code,
        "RATE_LIMITED",
      );
    },
    { relayEnabled: true, relayRatePerMinute: 1 },
  );

  assert.deepEqual(relayCalls, ["0x02aabb"]);
});

test("relay forwards signed bytes unchanged and returns the hash", async () => {
  const relayCalls: string[] = [];
  const relayHash = `0x${hash(0x7777)}`;
  await withServer(
    fakeSource(undefined, { relayCalls, relayHash }),
    async (base) => {
      const transactions = [
        "0x01",
        "0x02aabb",
        "0x03aabb",
        "0x04aabb",
        "0xc0" + "11".repeat(32),
      ];
      for (const rawTransaction of transactions) {
        const response = await fetch(`${base}/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum",
            rawTransaction,
          }),
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          network: string;
          hash: string;
          receivedAt: number;
        };
        assert.equal(body.network, "arbitrum");
        assert.equal(body.hash, relayHash);
        assert.equal(typeof body.receivedAt, "number");
      }
      assert.deepEqual(relayCalls, transactions);
    },
    { relayEnabled: true },
  );
});

test("relay rejects unsupported networks and malformed transactions", async () => {
  const relayCalls: string[] = [];
  await withServer(
    fakeSource(undefined, { relayCalls }),
    async (base) => {
      const cases: Array<{
        body: Record<string, unknown>;
        code: string;
      }> = [
        {
          body: { network: "solana", rawTransaction: "0x01" },
          code: "UNSUPPORTED_NETWORK",
        },
        {
          body: { network: "arbitrum", rawTransaction: "abcd" },
          code: "INVALID_REQUEST",
        },
        {
          body: { network: "arbitrum", rawTransaction: "0x" },
          code: "INVALID_REQUEST",
        },
        {
          body: { network: "arbitrum", rawTransaction: "0x1" },
          code: "INVALID_REQUEST",
        },
        {
          body: { network: "arbitrum", rawTransaction: "0xzz" },
          code: "INVALID_REQUEST",
        },
        {
          body: {
            network: "arbitrum",
            rawTransaction: "0x01" + "00".repeat(1_024),
          },
          code: "INVALID_REQUEST",
        },
      ];
      for (const entry of cases) {
        const response = await fetch(`${base}/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.body),
        });
        assert.equal(response.status, 400);
        assert.equal(
          ((await response.json()) as { code: string }).code,
          entry.code,
        );
      }

      const malformed = await fetch(`${base}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"network":',
      });
      assert.equal(malformed.status, 400);
      assert.equal(
        ((await malformed.json()) as { code: string }).code,
        "INVALID_REQUEST",
      );

      assert.deepEqual(relayCalls, []);
    },
    { relayEnabled: true, relayMaxBytes: 1_024 },
  );
});

test("relay rate limits per IP", async () => {
  await withServer(
    fakeSource(),
    async (base) => {
      const send = () =>
        fetch(`${base}/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum",
            rawTransaction: "0x02aabb",
          }),
        });
      assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 200);
      const limited = await send();
      assert.equal(limited.status, 429);
      assert.equal(
        ((await limited.json()) as { code: string }).code,
        "RATE_LIMITED",
      );
    },
    { relayEnabled: true, relayRatePerMinute: 2 },
  );
});

test("relay provider failures are sanitized", async () => {
  await withServer(
    fakeSource(undefined, { relayError: true }),
    async (base) => {
      const response = await fetch(`${base}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          rawTransaction: "0x02aabb",
        }),
      });
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.match(text, /RELAY_UNAVAILABLE/);
      assert.doesNotMatch(text, /secret\.example|https:/);
    },
    { relayEnabled: true },
  );
});

test("relay reports deterministic transaction failures without upstream details", async () => {
  await withServer(
    fakeSource(undefined, {
      relayFailure: Object.assign(
        new Error("RPC https://secret.example rejected"),
        { code: "INSUFFICIENT_FUNDS" },
      ),
    }),
    async (base) => {
      const response = await fetch(`${base}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          rawTransaction: "0x04aabb",
        }),
      });
      assert.equal(response.status, 422);
      const text = await response.text();
      assert.match(text, /INSUFFICIENT_FUNDS/);
      assert.doesNotMatch(text, /secret|https:/);
    },
    { relayEnabled: true },
  );
});

test("fees return contract integers and stay cached for a short window", async () => {
  const feeCalls: string[] = [];
  await withServer(
    fakeSource(undefined, { feeCalls }),
    async (base) => {
      const first = await fetch(`${base}/fees?network=arbitrum`);
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        network: string;
        shieldFee: string;
        unshieldFee: string;
        nftFee: string;
        block: number;
        updatedAt: number;
      };
      assert.equal(firstBody.network, "arbitrum");
      assert.equal(firstBody.shieldFee, "100");
      assert.equal(firstBody.unshieldFee, "200");
      assert.equal(firstBody.nftFee, "300");
      assert.equal(firstBody.block, 54_321);
      assert.equal(typeof firstBody.updatedAt, "number");
      assert.equal(feeCalls.length, 3);

      const second = await fetch(`${base}/fees?network=arbitrum`);
      assert.equal(second.status, 200);
      assert.equal(feeCalls.length, 3);
      const secondBody = (await second.json()) as { updatedAt: number };
      assert.equal(secondBody.updatedAt, firstBody.updatedAt);
    },
  );
});

test("fee provider failures return a dedicated 503", async () => {
  await withServer(
    fakeSource(undefined, { feeError: true }),
    async (base) => {
      const response = await fetch(`${base}/fees?network=arbitrum`);
      assert.equal(response.status, 503);
      const body = (await response.json()) as { code: string };
      assert.equal(body.code, "FEE_QUOTE_UNAVAILABLE");
    },
  );
});

test("CORS only echoes allowlisted origins", async () => {
  await withServer(
    fakeSource(),
    async (base) => {
      const allowed = await fetch(`${base}/status?${query}`, {
        headers: { Origin: "http://localhost:8081" },
      });
      assert.equal(
        allowed.headers.get("access-control-allow-origin"),
        "http://localhost:8081",
      );

      const denied = await fetch(`${base}/status?${query}`, {
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(denied.headers.get("access-control-allow-origin"), null);

      const preflight = await fetch(`${base}/status?${query}`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8081",
          "Access-Control-Request-Method": "GET",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get("access-control-allow-methods"),
      "GET, POST, DELETE, OPTIONS",
      );
    },
    { corsOrigins: ["http://localhost:8081"] },
  );
});

test("disabled and unavailable indexes fail closed", async () => {
  await withServer(undefined, async (base) => {
    const disabled = await fetch(`${base}/status?${query}`);
    assert.equal(disabled.status, 404);
    assert.equal(
      ((await disabled.json()) as { code: string }).code,
      "LIGHT_API_DISABLED",
    );
  }, { enabled: false });

  await withServer(undefined, async (base) => {
    const unavailable = await fetch(`${base}/status?${query}`);
    assert.equal(unavailable.status, 503);
    assert.equal(
      ((await unavailable.json()) as { code: string }).code,
      "LIGHT_INDEX_UNAVAILABLE",
    );
  });
});

test("invalid network and txid version are rejected", async () => {
  await withServer(fakeSource(), async (base) => {
    const network = await fetch(
      `${base}/status?network=solana&txidVersion=V2_PoseidonMerkle`,
    );
    assert.equal(network.status, 400);
    assert.equal(
      ((await network.json()) as { code: string }).code,
      "UNSUPPORTED_NETWORK",
    );

    const version = await fetch(`${base}/status?network=arbitrum&txidVersion=V9`);
    assert.equal(version.status, 400);
    assert.equal(
      ((await version.json()) as { code: string }).code,
      "UNSUPPORTED_TXID_VERSION",
    );
  });
});

const SCAN_TOKEN = "scan-token-0123456789abcdef";
const msgpackStr8 = (value: string): string =>
  `d940${Buffer.from(value, "utf8").toString("hex")}`;
const SHAREABLE_KEY =
  "82" +
  "a5" +
  Buffer.from("vpriv", "utf8").toString("hex") +
  msgpackStr8("11".repeat(32)) +
  "a4" +
  Buffer.from("spub", "utf8").toString("hex") +
  msgpackStr8("22".repeat(32));

const scanBody = (overrides: Record<string, unknown> = {}) => ({
  network: "arbitrum",
  txidVersion: TXIDVersion.V2_PoseidonMerkle,
  shareableViewingKey: SHAREABLE_KEY,
  fromBlock: 100,
  ...overrides,
});

test("remote scan routes require an enabled service and token", async () => {
  await withServer(fakeSource(), async (base) => {
    for (const method of ["POST", "GET", "DELETE"]) {
      const disabled = await fetch(
        method === "POST" ? `${base}/scan` : `${base}/scan/${"00".repeat(16)}`,
        {
          method,
          ...(method === "POST"
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(scanBody()),
              }
            : {}),
        },
      );
      assert.equal(disabled.status, 403, method);
      assert.equal(
        ((await disabled.json()) as { code: string }).code,
        "SCAN_DISABLED",
        method,
      );
    }

    const oversized = await fetch(`${base}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        scanBody({ shareableViewingKey: "ab".repeat(5_000) }),
      ),
    });
    assert.equal(oversized.status, 403);
    assert.equal(
      ((await oversized.json()) as { code: string }).code,
      "SCAN_DISABLED",
    );
  });

  const scan = new RemoteScanService({
    enabled: true,
    token: SCAN_TOKEN,
    runner: async () => ({ notes: [], nextFromBlock: null }),
  });
  try {
    await withServer(fakeSource(), async (base) => {
      const unauthorized = await fetch(`${base}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scanBody()),
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(
        ((await unauthorized.json()) as { code: string }).code,
        "SCAN_UNAUTHORIZED",
      );

      const oversized = await fetch(`${base}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scanBody({ shareableViewingKey: "ab".repeat(5_000) }),
        ),
      });
      assert.equal(oversized.status, 401);
      assert.equal(
        ((await oversized.json()) as { code: string }).code,
        "SCAN_UNAUTHORIZED",
      );
    }, { scan });
  } finally {
    await scan.stop();
  }
});

test("remote scan rejects invalid fields and oversized bodies before queuing", async () => {
  let runs = 0;
  const scan = new RemoteScanService({
    enabled: true,
    token: SCAN_TOKEN,
    ratePerMinute: 60,
    runner: async () => {
      runs += 1;
      return { notes: [], nextFromBlock: null };
    },
  });
  const auth = { Authorization: `Bearer ${SCAN_TOKEN}` };
  try {
    await withServer(fakeSource(), async (base) => {
      const invalidBodies = [
        {
          body: scanBody({ network: "solana" }),
          code: "UNSUPPORTED_NETWORK",
        },
        {
          body: scanBody({ shareableViewingKey: 42 }),
          code: "INVALID_REQUEST",
        },
        {
          body: scanBody({ fromBlock: "not-a-number" }),
          code: "INVALID_REQUEST",
        },
        { body: scanBody({ fromBlock: 1.5 }), code: "INVALID_REQUEST" },
        { body: scanBody({ fromBlock: null }), code: "INVALID_REQUEST" },
        {
          body: scanBody({ includeSpent: "yes" }),
          code: "INVALID_REQUEST",
        },
      ];
      for (const { body, code } of invalidBodies) {
        const response = await fetch(`${base}/scan`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.equal(
          ((await response.json()) as { code: string }).code,
          code,
        );
      }

      const oversized = await fetch(`${base}/scan`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(
          scanBody({ shareableViewingKey: "ab".repeat(5_000) }),
        ),
      });
      assert.equal(oversized.status, 413);
      assert.deepEqual(await oversized.json(), {
        error: "Request body is too large.",
        code: "INVALID_REQUEST",
      });
      assert.equal(runs, 0);
    }, { scan });
  } finally {
    await scan.stop();
  }
});

test("remote scan starts, polls, and cancels", async () => {
  const scan = new RemoteScanService({
    enabled: true,
    token: SCAN_TOKEN,
    runner: async (_input, context) => {
      context.onProgress({ progress: 0.5, stage: "scanning" });
      return { notes: [], nextFromBlock: 123 };
    },
  });
  const auth = { Authorization: `Bearer ${SCAN_TOKEN}` };
  try {
    await withServer(fakeSource(), async (base) => {
      const started = await fetch(`${base}/scan`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(scanBody()),
      });
      assert.equal(started.status, 202);
      const { jobId } = (await started.json()) as { jobId: string };
      assert.match(jobId, /^[0-9a-f]{32}$/);

      let body: { status: string; progress: number } | undefined;
      for (let index = 0; index < 100; index += 1) {
        const status = await fetch(`${base}/scan/${jobId}`, { headers: auth });
        assert.equal(status.status, 200);
        body = (await status.json()) as {
          status: string;
          progress: number;
        };
        if (body.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(body);
      assert.equal(body.status, "done");
      assert.equal(body.progress, 1);

      const cancelled = await fetch(`${base}/scan/${jobId}`, {
        method: "DELETE",
        headers: auth,
      });
      assert.equal(cancelled.status, 200);
      assert.equal(
        ((await cancelled.json()) as { status: string }).status,
        "done",
      );
    }, { scan });
  } finally {
    await scan.stop();
  }
});

test("remote scan fails fast while the requested network is syncing", async () => {
  let runs = 0;
  const scan = new RemoteScanService({
    enabled: true,
    token: SCAN_TOKEN,
    runner: async () => {
      runs += 1;
      return { notes: [], nextFromBlock: null };
    },
  });
  try {
    await withServer(
      fakeSource(),
      async (base) => {
        const started = await fetch(`${base}/scan`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SCAN_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(scanBody()),
        });
        assert.equal(started.status, 503);
        assert.deepEqual(await started.json(), {
          error:
            "The indexer is still syncing this network; retry after it is ready.",
          code: "LIGHT_INDEX_SYNCING",
        });
        assert.equal(runs, 0);
      },
      { scan, isNetworkReady: () => false },
    );
  } finally {
    await scan.stop();
  }
});

test("remote scan rejects V3 and malformed bodies", async () => {
  const scan = new RemoteScanService({
    enabled: true,
    token: SCAN_TOKEN,
    runner: async () => ({ notes: [], nextFromBlock: null }),
  });
  const auth = { Authorization: `Bearer ${SCAN_TOKEN}` };
  try {
    await withServer(fakeSource(), async (base) => {
      const v3 = await fetch(`${base}/scan`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(
          scanBody({ txidVersion: TXIDVersion.V3_PoseidonMerkle }),
        ),
      });
      assert.equal(v3.status, 400);
      assert.equal(
        ((await v3.json()) as { code: string }).code,
        "UNSUPPORTED_TXID_VERSION",
      );

      const malformed = await fetch(`${base}/scan`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(scanBody({ fromBlock: -1 })),
      });
      assert.equal(malformed.status, 400);
      assert.equal(
        ((await malformed.json()) as { code: string }).code,
        "INVALID_REQUEST",
      );
    }, { scan });
  } finally {
    await scan.stop();
  }
});
