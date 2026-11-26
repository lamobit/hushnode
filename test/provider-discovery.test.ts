import assert from "node:assert/strict";
import test from "node:test";
import {
  NetworkName,
  type ProviderJson,
} from "@railgun-community/shared-models";
import { RAILGUN_FEE_SELECTORS } from "../src/railgun/fees.js";
import {
  createRpcProviderProbe,
  discoverReachableProviders,
  type RpcProbeProvider,
} from "../src/railgun/provider-discovery.js";

const PROXY_CONTRACT = `0x${"ab".repeat(20)}`;

const provider = (url: string): ProviderJson => ({
  provider: url,
  priority: 3,
  weight: 2,
  stallTimeout: 2_500,
  maxLogsPerBatch: 2,
});

const rpcProvider = (
  overrides: Partial<RpcProbeProvider> = {},
): RpcProbeProvider => ({
  send: async () => "0xa4b1",
  getBlock: async () => ({ number: 100 }),
  call: async () => "0x01",
  destroy: () => undefined,
  ...overrides,
});

test("provider discovery deduplicates, bounds probes, and keeps priority", async () => {
  const candidates = Array.from({ length: 14 }, (_, index) =>
    provider(`https://rpc-${index}.invalid`),
  );
  candidates.splice(2, 0, provider("https://rpc-0.invalid"));
  const probed: string[] = [];

  const selected = await discoverReachableProviders(
    NetworkName.Arbitrum,
    candidates,
    async (_network, config) => {
      probed.push(config.provider);
      return { config, block: 500 };
    },
  );

  assert.equal(probed.length, 12);
  assert.equal(new Set(probed).size, 12);
  assert.deepEqual(selected, candidates.slice(0, 2));
});

test("provider discovery excludes lagging nodes but preserves configured order", async () => {
  const candidates = ["a", "b", "c", "d"].map((name) =>
    provider(`https://${name}.invalid`),
  );
  const blocks = new Map([
    ["a", 100],
    ["b", 200],
    ["c", 205],
    ["d", 1_000],
  ]);

  const selected = await discoverReachableProviders(
    NetworkName.Arbitrum,
    candidates,
    async (_network, config) => ({
      config,
      block: blocks.get(new URL(config.provider).hostname.split(".")[0]!)!,
    }),
  );

  assert.deepEqual(
    selected.map((entry) => entry.provider),
    ["https://b.invalid", "https://c.invalid"],
  );
});

test("provider discovery fails closed without a reachable node", async () => {
  await assert.rejects(
    discoverReachableProviders(
      NetworkName.Arbitrum,
      [provider("https://rpc.invalid")],
      async () => undefined,
    ),
    /No reachable RPC provider/,
  );
  await assert.rejects(
    discoverReachableProviders(
      NetworkName.Arbitrum,
      [],
      async () => undefined,
    ),
    /No reachable RPC provider/,
  );
});

test("RPC probe verifies chain identity and the RAILGUN fee surface", async () => {
  const calls: Array<{ to: string; data: string }> = [];
  let destroyCalls = 0;
  let createdChainId: number | undefined;
  const probe = createRpcProviderProbe({
    createProvider: (_url, chainId) => {
      createdChainId = chainId;
      return rpcProvider({
        send: async (method, params) => {
          assert.equal(method, "eth_chainId");
          assert.deepEqual(params, []);
          return "0xa4b1";
        },
        getBlock: async (tag) => {
          assert.equal(tag, "latest");
          return { number: 123 };
        },
        call: async (transaction) => {
          calls.push(transaction);
          return "0x01";
        },
        destroy: () => {
          destroyCalls += 1;
        },
      });
    },
    definitionFor: () => ({
      chainId: 42_161,
      proxyContract: PROXY_CONTRACT,
    }),
    sleep: async () => undefined,
  });

  const config = provider("https://rpc.example:8545/path");
  assert.deepEqual(await probe(NetworkName.Arbitrum, config), {
    config,
    block: 123,
  });
  assert.equal(createdChainId, 42_161);
  assert.equal(destroyCalls, 1);
  assert.deepEqual(calls, RAILGUN_FEE_SELECTORS.map((data) => ({
    to: PROXY_CONTRACT,
    data,
  })));
});

test("RPC probe rejects wrong or malformed chain IDs before fee calls", async () => {
  for (const chainIdValue of ["0x1", "not-hex", "0x0"]) {
    let createCalls = 0;
    let destroyCalls = 0;
    let feeCalls = 0;
    let failure: { host: string; error: unknown } | undefined;
    const probe = createRpcProviderProbe({
      createProvider: () => {
        createCalls += 1;
        return rpcProvider({
          send: async () => chainIdValue,
          call: async () => {
            feeCalls += 1;
            return "0x01";
          },
          destroy: () => {
            destroyCalls += 1;
          },
        });
      },
      definitionFor: () => ({
        chainId: 42_161,
        proxyContract: PROXY_CONTRACT,
      }),
      onFailure: (host, error) => {
        failure = { host, error };
      },
      sleep: async () => undefined,
    });

    assert.equal(
      await probe(
        NetworkName.Arbitrum,
        provider("https://rpc.invalid/path"),
      ),
      undefined,
    );
    assert.equal(createCalls, 2);
    assert.equal(destroyCalls, 2);
    assert.equal(feeCalls, 0);
    assert.equal(failure?.host, "rpc.invalid");
    assert.match(
      failure?.error instanceof Error ? failure.error.message : "",
      /chain ID|invalid chain/,
    );
  }
});

test("RPC probe retries transient failures and isolates cleanup errors", async () => {
  let createCalls = 0;
  let sleepCalls = 0;
  let finalFailures = 0;
  const cleanupHosts: string[] = [];
  const probe = createRpcProviderProbe({
    createProvider: () => {
      createCalls += 1;
      const call =
        createCalls === 1
          ? async () => "0x"
          : async () => "0x01";
      return rpcProvider({
        call,
        destroy:
          createCalls === 1
            ? () => {
                throw new Error("socket cleanup failed");
              }
            : async () => {
                throw new Error("socket close failed");
              },
      });
    },
    definitionFor: () => ({
      chainId: 42_161,
      proxyContract: PROXY_CONTRACT,
    }),
    onFailure: () => {
      finalFailures += 1;
    },
    onCleanupFailure: (host) => {
      cleanupHosts.push(host);
    },
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  const config = provider("https://rpc.invalid");
  assert.deepEqual(await probe(NetworkName.Arbitrum, config), {
    config,
    block: 100,
  });
  assert.equal(createCalls, 2);
  assert.equal(sleepCalls, 1);
  assert.equal(finalFailures, 0);
  assert.deepEqual(cleanupHosts, ["rpc.invalid", "rpc.invalid"]);
});

test("RPC probe bounds hung health checks", async () => {
  let failure: unknown;
  let destroyCalls = 0;
  const probe = createRpcProviderProbe({
    createProvider: () =>
      rpcProvider({
        getBlock: async () => new Promise(() => undefined),
        destroy: () => {
          destroyCalls += 1;
        },
      }),
    definitionFor: () => ({
      chainId: 42_161,
      proxyContract: PROXY_CONTRACT,
    }),
    onFailure: (_host, error) => {
      failure = error;
    },
    attempts: 1,
    timeoutMs: 1,
  });

  assert.equal(
    await probe(NetworkName.Arbitrum, provider("https://rpc.invalid")),
    undefined,
  );
  assert.equal(destroyCalls, 1);
  assert.match(
    failure instanceof Error ? failure.message : "",
    /health check timed out/,
  );
});

test("RPC probe bounds hung provider cleanup", async () => {
  let cleanupFailure: { host: string; error: unknown } | undefined;
  const probe = createRpcProviderProbe({
    createProvider: () =>
      rpcProvider({
        destroy: () => new Promise<void>(() => undefined),
      }),
    definitionFor: () => ({
      chainId: 42_161,
      proxyContract: PROXY_CONTRACT,
    }),
    onCleanupFailure: (host, error) => {
      cleanupFailure = { host, error };
    },
    attempts: 1,
    timeoutMs: 5,
  });

  const config = provider("https://rpc.invalid");
  assert.deepEqual(await probe(NetworkName.Arbitrum, config), {
    config,
    block: 100,
  });
  assert.equal(cleanupFailure?.host, "rpc.invalid");
  assert.match(
    cleanupFailure?.error instanceof Error
      ? cleanupFailure.error.message
      : "",
    /cleanup timed out/,
  );
});

test("RPC probe rejects invalid retry configuration", () => {
  const options = {
    createProvider: () => rpcProvider(),
    definitionFor: () => ({
      chainId: 42_161,
      proxyContract: PROXY_CONTRACT,
    }),
  };
  assert.throws(
    () => createRpcProviderProbe({ ...options, attempts: 0 }),
    /attempts must be a positive integer/,
  );
  assert.throws(
    () => createRpcProviderProbe({ ...options, retryMs: -1 }),
    /retry delay must be non-negative/,
  );
  assert.throws(
    () => createRpcProviderProbe({ ...options, timeoutMs: Number.NaN }),
    /timeout must be non-negative/,
  );
});
