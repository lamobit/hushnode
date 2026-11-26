import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  NetworkName,
  TXIDVersion,
} from "@railgun-community/shared-models";
import { createChainSyncLightSource } from "../src/light-api.js";
import type {
  ChainSyncIndexingSource,
  LightApiOptions,
} from "../src/light-api.js";
import {
  readLightIndex,
  readLightIndexSync,
  requireConfiguredSource,
  requireReadySource,
  requireSource,
} from "../src/light-api/index-source.js";
import { LightApiError } from "../src/light-api/protocol.js";

const nullifier = (value: string): string => value.repeat(64).slice(0, 64);

const sourceWithNullifierKeys = (
  keys: unknown[],
  onOptions?: (options: Record<string, unknown>) => void,
  includeDatabase = true,
): ReturnType<typeof createChainSyncLightSource> => {
  const merkletree = {
    async getLatestTreeAndIndex() {
      return { tree: 0, index: 0 };
    },
    async getTreeLength() {
      return 1;
    },
    async getRoot() {
      return "0".repeat(64);
    },
    async getCommitmentRange() {
      return [];
    },
    async getMerkleProof() {
      return {
        leaf: "0".repeat(64),
        elements: Array(16).fill("0".repeat(64)),
        indices: "0".repeat(64),
        root: "0".repeat(64),
      };
    },
    getNullifierDBPath() {
      return ["nullifiers", "0".repeat(64)];
    },
    ...(includeDatabase
      ? {
          db: {
            level: {
              createReadStream(options: Record<string, unknown>) {
                onOptions?.(options);
                return Readable.from(keys);
              },
            },
          },
        }
      : {}),
  };
  const chainSync = {
    isRunning: () => true,
    isNetworkLoaded: () => true,
    readiness: () => ({
      ready: true,
      state: "ready",
      retryAttempt: 0,
      lastCompletedAt: 1,
    }),
    getEngine: () => ({
      scanActivity: () => ({ utxo: false, txid: false }),
      getUTXOMerkletree: () => merkletree,
      lastSyncedBlock: async () => undefined,
      provider: () => ({}),
    }),
  } as unknown as ChainSyncIndexingSource;
  return createChainSyncLightSource(chainSync);
};

test("nullifier streams reject malformed LevelDB keys instead of returning partial pages", async () => {
  const source = sourceWithNullifierKeys([
    { key: `nullifiers:${nullifier("a")}` },
    { key: "nullifiers:not-a-nullifier" },
  ]);
  const tree = source.tree(
    NetworkName.Ethereum,
    TXIDVersion.V2_PoseidonMerkle,
  );

  await assert.rejects(
    tree.getNullifiers(0, null, 2),
    /invalid key/,
  );
});

test("nullifier streams retain cursor and limit bounds", async () => {
  let options: Record<string, unknown> | undefined;
  const source = sourceWithNullifierKeys(
    [{ key: `nullifiers:${nullifier("b")}` }],
    (value) => {
      options = value;
    },
  );
  const tree = source.tree(
    NetworkName.Ethereum,
    TXIDVersion.V2_PoseidonMerkle,
  );

  assert.deepEqual(
    await tree.getNullifiers(0, nullifier("a"), 4),
    [nullifier("b")],
  );
  assert.equal(options?.gt, "nullifiers:" + nullifier("a"));
  assert.equal(options?.gte, undefined);
  assert.equal(options?.limit, 4);

  await tree.getNullifiers(0, null, 4);
  assert.equal(options?.gte, "nullifiers:");
  assert.equal(options?.gt, undefined);
});

test("nullifier streams fail closed when LevelDB is unavailable", async () => {
  const source = sourceWithNullifierKeys([], undefined, false);
  const tree = source.tree(
    NetworkName.Ethereum,
    TXIDVersion.V2_PoseidonMerkle,
  );

  await assert.rejects(
    tree.getNullifiers(0, null, 4),
    /Nullifier LevelDB is unavailable/,
  );
});

test("chain sync provider adapts fee and receipt data", async () => {
  let block: { baseFeePerGas: bigint | null } | null = {
    baseFeePerGas: 7n,
  };
  let receipt: {
    status: number | null;
    blockNumber: number;
    gasUsed: bigint;
    gasPrice: bigint;
  } | null = {
    status: 1,
    blockNumber: 9,
    gasUsed: 21_000n,
    gasPrice: 2n,
  };
  const calls: Array<{ method: string; value: unknown }> = [];
  const rpc = {
    async call(transaction: { to: string; data: string }) {
      calls.push({ method: "call", value: transaction });
      return "0x1234";
    },
    async getBlockNumber() {
      calls.push({ method: "getBlockNumber", value: undefined });
      return 123;
    },
    async broadcastTransaction(raw: string) {
      calls.push({ method: "broadcastTransaction", value: raw });
      return { hash: `0x${"ab".repeat(32)}` };
    },
    async getTransactionCount(address: string, tag: string) {
      calls.push({ method: "getTransactionCount", value: { address, tag } });
      return 5;
    },
    async getBalance(address: string, tag: string) {
      calls.push({ method: "getBalance", value: { address, tag } });
      return 6n;
    },
    async getFeeData() {
      return {
        gasPrice: 1n,
        maxFeePerGas: 3n,
        maxPriorityFeePerGas: 2n,
      };
    },
    async getBlock(tag: string) {
      calls.push({ method: "getBlock", value: tag });
      return block;
    },
    async estimateGas(transaction: {
      from: string;
      to: string;
      data: string;
    }) {
      calls.push({ method: "estimateGas", value: transaction });
      return 21_000n;
    },
    async getTransactionReceipt(hash: string) {
      calls.push({ method: "getTransactionReceipt", value: hash });
      return receipt;
    },
  };
  const chainSync = {
    getEngine: () => ({ provider: () => rpc }),
  } as unknown as ChainSyncIndexingSource;
  const provider = createChainSyncLightSource(chainSync).provider(
    NetworkName.Arbitrum,
  );

  assert.equal(
    await provider.call({ to: `0x${"11".repeat(20)}`, data: "0xabcd" }),
    "0x1234",
  );
  assert.equal(await provider.getBlockNumber(), 123);
  assert.equal(
    await provider.sendRawTransaction("0x02aabb"),
    `0x${"ab".repeat(32)}`,
  );
  assert.equal(
    await provider.getTransactionCount(`0x${"22".repeat(20)}`, "pending"),
    5,
  );
  assert.equal(
    await provider.getBalance(`0x${"22".repeat(20)}`, "latest"),
    6n,
  );
  assert.deepEqual(await provider.feeData(), {
    baseFeePerGas: 7n,
    maxPriorityFeePerGas: 2n,
    maxFeePerGas: 3n,
  });
  assert.equal(
    await provider.estimateGas({
      from: `0x${"22".repeat(20)}`,
      to: `0x${"11".repeat(20)}`,
      data: "0x",
    }),
    21_000n,
  );
  assert.deepEqual(
    await provider.getTransactionReceipt(`0x${"cd".repeat(32)}`),
    {
      status: 1,
      blockNumber: 9,
      gasUsed: 21_000n,
      effectiveGasPrice: 2n,
    },
  );
  assert.equal(
    calls.some((call) => call.method === "broadcastTransaction"),
    true,
  );

  block = null;
  assert.deepEqual(await provider.feeData(), {
    baseFeePerGas: null,
    maxPriorityFeePerGas: 2n,
    maxFeePerGas: 3n,
  });
  receipt = null;
  assert.equal(
    await provider.getTransactionReceipt(`0x${"cd".repeat(32)}`),
    null,
  );
});

test("source guards normalize unavailable index state", async () => {
  const options = (source?: unknown): LightApiOptions => ({
    enabled: true,
    source: source as LightApiOptions["source"],
  });
  const readySource = {
    isRunning: () => true,
    isNetworkLoaded: () => true,
    readiness: () => ({
      ready: true,
      state: "ready",
      retryAttempt: 0,
      lastCompletedAt: 1,
    }),
  };
  const expectCode = (operation: () => unknown, code: string): void => {
    assert.throws(operation, (error) => {
      assert.ok(error instanceof LightApiError);
      assert.equal(error.code, code);
      return true;
    });
  };

  expectCode(
    () => requireConfiguredSource(options()),
    "LIGHT_INDEX_UNAVAILABLE",
  );
  expectCode(
    () => requireSource(options(), NetworkName.Ethereum),
    "LIGHT_INDEX_UNAVAILABLE",
  );
  expectCode(
    () =>
      requireSource(
        options({
          ...readySource,
          isRunning: () => {
            throw new Error("state failed");
          },
        }),
        NetworkName.Ethereum,
      ),
    "LIGHT_INDEX_UNAVAILABLE",
  );
  expectCode(
    () =>
      requireSource(
        options({ ...readySource, isNetworkLoaded: () => false }),
        NetworkName.Ethereum,
      ),
    "LIGHT_NETWORK_NOT_LOADED",
  );
  expectCode(
    () =>
      requireReadySource(
        options({
          ...readySource,
          readiness: () => {
            throw new Error("readiness failed");
          },
        }),
        NetworkName.Ethereum,
      ),
    "LIGHT_INDEX_SYNCING",
  );
  expectCode(
    () =>
      requireReadySource(
        options({
          ...readySource,
          readiness: () => ({
            ready: false,
            state: "syncing",
            retryAttempt: 1,
            lastCompletedAt: null,
          }),
        }),
        NetworkName.Ethereum,
      ),
    "LIGHT_INDEX_SYNCING",
  );

  const preserved = new LightApiError(
    404,
    "TREE_NOT_FOUND",
    "Tree does not exist.",
  );
  assert.throws(
    () =>
      readLightIndexSync(() => {
        throw preserved;
      }),
    (error) => error === preserved,
  );
  expectCode(
    () =>
      readLightIndexSync(() => {
        throw new Error("unknown");
      }),
    "LIGHT_INDEX_UNAVAILABLE",
  );
  await assert.rejects(
    readLightIndex(async () => {
      throw new Error("unknown");
    }),
    (error) =>
      error instanceof LightApiError &&
      error.code === "LIGHT_INDEX_UNAVAILABLE",
  );
  await assert.rejects(
    readLightIndex(async () => {
      throw preserved;
    }),
    (error) => error === preserved,
  );
});
