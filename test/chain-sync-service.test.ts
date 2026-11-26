import assert from "node:assert/strict";
import test from "node:test";
import {
  MerkletreeScanStatus,
  NetworkName,
  type Chain,
  type MerkletreeScanUpdateEvent,
} from "@railgun-community/shared-models";
import {
  ChainSyncService,
  type ChainSyncScanHandlers,
} from "../src/chain-sync-service.js";
import { config } from "../src/config.js";
import {
  chainFor,
  networkFor,
  networkForChainId,
} from "../src/networks.js";
import {
  RailgunEngine,
  type RailgunEngineLifecycle,
} from "../src/railgun/engine.js";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const flushEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const schedulerEngine = (): RailgunEngine => {
  let running = false;
  const loaded = new Set<NetworkName>();
  return {
    async start() {
      running = true;
    },
    async stop() {
      running = false;
    },
    isRunning: () => running,
    isNetworkLoaded: (network: NetworkName) => loaded.has(network),
    async loadNetwork(network: NetworkName) {
      loaded.add(network);
    },
    scanActivity: () => ({ utxo: false, txid: false }),
  } as unknown as RailgunEngine;
};

const scanEvent = (
  network: NetworkName,
  scanStatus: MerkletreeScanStatus,
): MerkletreeScanUpdateEvent => ({
  chain: chainFor(networkFor(network)),
  scanStatus,
  progress: scanStatus === MerkletreeScanStatus.Complete ? 1 : 0,
});

const networkForChain = (chain: Chain): NetworkName => {
  const network = networkForChainId(chain.id);
  if (!network) throw new Error(`Unexpected test chain ${chain.id}.`);
  return network.id;
};

test("stop waits for initialization and shares the shutdown operation", async () => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let startCalls = 0;
  let stopCalls = 0;
  const lifecycle: RailgunEngineLifecycle = {
    async start() {
      startCalls += 1;
      await startGate;
    },
    async stop() {
      stopCalls += 1;
    },
  };
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: (poiNodeUrls, onEngineLog) =>
      new RailgunEngine(poiNodeUrls, onEngineLog, lifecycle),
    installScanCallbacks: () => undefined,
  });

  const initializing = service.initialize();
  await waitFor(() => startCalls === 1);

  let stopSettled = false;
  const stopping = service.stop();
  void stopping.then(() => {
    stopSettled = true;
  });
  const concurrentStop = service.stop();
  assert.equal(stopping, concurrentStop);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopSettled, false);

  releaseStart();
  await assert.rejects(initializing, /stopped during initialization/);
  await Promise.all([stopping, concurrentStop]);
  assert.equal(stopCalls, 1);
  assert.equal(service.isRunning(), false);
});

test("stop reports initialization that misses the shutdown deadline", async () => {
  let releaseConfig!: () => void;
  let configCalls = 0;
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  let engineCreations = 0;
  const service = new ChainSyncService({
    async loadConfig() {
      configCalls += 1;
      await configGate;
      return { poiNodeUrls: ["https://poi.invalid"] };
    },
    createEngine: () => {
      engineCreations += 1;
      throw new Error("engine must not be created after shutdown");
    },
    installScanCallbacks: () => undefined,
    stopTimeoutMs: 5,
  });

  const initializing = service.initialize();
  await waitFor(() => configCalls === 1);
  await assert.rejects(
    service.stop(),
    /initialization did not drain before the shutdown deadline/,
  );

  releaseConfig();
  await assert.rejects(initializing, /stopped during initialization/);
  assert.equal(engineCreations, 0);
  assert.equal(service.isRunning(), false);
});

test("initialization after a shutdown deadline cannot publish or leak an engine", async () => {
  let releaseStart!: () => void;
  let startCalls = 0;
  let stopCalls = 0;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: (poiNodeUrls, onEngineLog) =>
      new RailgunEngine(poiNodeUrls, onEngineLog, {
        async start() {
          startCalls += 1;
          await startGate;
        },
        async stop() {
          stopCalls += 1;
        },
      }),
    installScanCallbacks: () => undefined,
    stopTimeoutMs: 5,
  });

  const initializing = service.initialize();
  await waitFor(() => startCalls === 1);
  await assert.rejects(
    service.stop(),
    /initialization did not drain before the shutdown deadline/,
  );

  releaseStart();
  await assert.rejects(initializing, /stopped during initialization/);
  await waitFor(() => stopCalls === 1);
  assert.equal(service.isRunning(), false);
});

test("stop reports engine cleanup failures to the shutdown owner", async () => {
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: (poiNodeUrls, onEngineLog) =>
      new RailgunEngine(poiNodeUrls, onEngineLog, {
        async start() {},
        async stop() {
          throw new Error("engine cleanup failed");
        },
      }),
    installScanCallbacks: () => undefined,
  });
  await service.initialize();

  await assert.rejects(service.stop(), /engine cleanup failed/);
  assert.equal(service.isRunning(), false);
});

test("stop bounds engine cleanup that misses the shutdown deadline", async () => {
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: (poiNodeUrls, onEngineLog) =>
      new RailgunEngine(poiNodeUrls, onEngineLog, {
        async start() {},
        async stop() {
          await new Promise<void>(() => undefined);
        },
      }),
    installScanCallbacks: () => undefined,
    stopTimeoutMs: 5,
  });
  await service.initialize();

  await assert.rejects(
    service.stop(),
    /engine cleanup did not finish before the shutdown deadline/,
  );
  assert.equal(service.isRunning(), false);
});

test("stop reports cleanup failures during initialization", async () => {
  let releaseStart!: () => void;
  let startCalls = 0;
  let stopCalls = 0;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: (poiNodeUrls, onEngineLog) =>
      new RailgunEngine(poiNodeUrls, onEngineLog, {
        async start() {
          startCalls += 1;
          await startGate;
        },
        async stop() {
          stopCalls += 1;
          throw new Error("engine cleanup failed");
        },
      }),
    installScanCallbacks: () => undefined,
  });

  const initializing = service.initialize();
  await waitFor(() => startCalls === 1);
  const stopping = service.stop();
  releaseStart();

  await assert.rejects(initializing, /stopped during initialization/);
  await assert.rejects(stopping, /engine cleanup failed/);
  await assert.rejects(
    service.initialize(),
    /cannot restart after an incomplete engine cleanup/,
  );
  assert.equal(stopCalls, 1);
});

test("stop reports network tasks that miss the shutdown deadline", async () => {
  let releaseLoad!: () => void;
  let markLoadStarted!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    markLoadStarted = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let engineStopCalls = 0;
  const engine = {
    async start() {},
    async stop() {
      engineStopCalls += 1;
    },
    async loadNetwork() {
      markLoadStarted();
      await loadGate;
    },
  } as unknown as RailgunEngine;
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: () => engine,
    installScanCallbacks: () => undefined,
    stopTimeoutMs: 5,
  });
  await service.initialize();

  service.start();
  await loadStarted;
  await assert.rejects(service.stop(), /shutdown deadline/);
  assert.equal(engineStopCalls, 1);

  releaseLoad();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(service.isRunning(), false);
});

test("readiness does not trust sync state after the engine degrades", async () => {
  const engine = {
    async start() {},
    async stop() {},
    isRunning: () => false,
    isNetworkLoaded: () => false,
  } as unknown as RailgunEngine;
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: () => engine,
    installScanCallbacks: () => undefined,
  });
  await service.initialize();

  const internals = service as unknown as {
    runtime(network: NetworkName): {
      status: "ready";
      retryAttempt: number;
      lastCompletedAt: number;
    };
  };
  internals.runtime(NetworkName.Arbitrum).status = "ready";
  assert.equal(service.isReady(NetworkName.Arbitrum), false);
  assert.equal(service.readiness(NetworkName.Arbitrum).state, "degraded");

  await service.stop();
});

test("scheduler completes scans, resolves waiters, and runs periodic refreshes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let handlers: ChainSyncScanHandlers | undefined;
  const refreshes: NetworkName[] = [];
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: () => schedulerEngine(),
    installScanCallbacks: (registered) => {
      handlers = registered;
    },
    refreshBalances: async (chain) => {
      const network = networkForChain(chain);
      refreshes.push(network);
      handlers!.onUtxo(scanEvent(network, MerkletreeScanStatus.Complete));
      handlers!.onTxid(scanEvent(network, MerkletreeScanStatus.Complete));
    },
  });
  await service.initialize();

  const waiting = service.waitForReady(NetworkName.Arbitrum);
  service.start();
  context.mock.timers.tick(0);
  await flushEventLoop();
  await waiting;

  assert.deepEqual(refreshes, [
    NetworkName.Ethereum,
    NetworkName.Arbitrum,
  ]);
  assert.equal(service.isReady(NetworkName.Ethereum), true);
  assert.equal(service.isReady(NetworkName.Arbitrum), true);

  refreshes.length = 0;
  context.mock.timers.tick(config.chainSyncIntervalMs);
  context.mock.timers.tick(0);
  await flushEventLoop();

  assert.deepEqual(
    [...refreshes].sort(),
    [NetworkName.Arbitrum, NetworkName.Ethereum].sort(),
  );
  assert.equal(service.isReady(NetworkName.Ethereum), true);
  assert.equal(service.isReady(NetworkName.Arbitrum), true);
  await service.stop();
});

test("scheduler retries failed networks and clears retry state", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let handlers: ChainSyncScanHandlers | undefined;
  let ethereumAttempts = 0;
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: () => schedulerEngine(),
    installScanCallbacks: (registered) => {
      handlers = registered;
    },
    refreshBalances: async (chain) => {
      const network = networkForChain(chain);
      if (network === NetworkName.Ethereum) {
        ethereumAttempts += 1;
        if (ethereumAttempts === 1) {
          throw new Error("RPC refresh failed");
        }
      }
      handlers!.onUtxo(scanEvent(network, MerkletreeScanStatus.Complete));
      handlers!.onTxid(scanEvent(network, MerkletreeScanStatus.Complete));
    },
  });
  await service.initialize();
  service.start();
  context.mock.timers.tick(0);
  await flushEventLoop();

  assert.equal(service.isReady(NetworkName.Ethereum), false);
  assert.equal(service.readiness(NetworkName.Ethereum).state, "degraded");
  assert.equal(service.readiness(NetworkName.Ethereum).retryAttempt, 1);
  assert.equal(service.isReady(NetworkName.Arbitrum), true);

  context.mock.timers.tick(5_000);
  context.mock.timers.tick(0);
  await flushEventLoop();

  assert.equal(ethereumAttempts, 2);
  assert.equal(service.isReady(NetworkName.Ethereum), true);
  assert.equal(service.readiness(NetworkName.Ethereum).retryAttempt, 0);
  await service.stop();
});

test("readiness waiters reject on abort and shutdown", async () => {
  const service = new ChainSyncService({
    loadConfig: async () => ({
      poiNodeUrls: ["https://poi.invalid"],
    }),
    createEngine: () => schedulerEngine(),
    installScanCallbacks: () => undefined,
  });
  await service.initialize();

  const controller = new AbortController();
  const aborted = service.waitForReady(
    NetworkName.Ethereum,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(aborted, /cancelled/);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    service.waitForReady(NetworkName.Ethereum, alreadyAborted.signal),
    /cancelled/,
  );

  const waiting = service.waitForReady(NetworkName.Ethereum);
  const stopping = service.stop();
  await assert.rejects(waiting, /stopped/);
  await stopping;
});
