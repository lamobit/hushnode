import assert from "node:assert/strict";
import test from "node:test";
import { NetworkName } from "@railgun-community/shared-models";
import {
  PROVIDER_LOAD_DRAIN_TIMEOUT_MS,
  RailgunEngine,
  type RailgunEngineLifecycle,
  type RailgunEngineProviderBackend,
} from "../src/railgun/engine.js";

const engineWith = (
  lifecycle: RailgunEngineLifecycle,
): RailgunEngine =>
  new RailgunEngine([], () => undefined, lifecycle);

const engineWithProviderBackend = (
  providerBackend: RailgunEngineProviderBackend,
): RailgunEngine =>
  new RailgunEngine(
    [],
    () => undefined,
    {
      async start() {},
      async stop() {},
    },
    providerBackend,
  );

const provider = (url: string) => ({
  provider: url,
  priority: 3,
  weight: 2,
});

test("engine start and stop calls are shared while in flight", async () => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let startCalls = 0;
  let stopCalls = 0;
  const engine = engineWith({
    async start() {
      startCalls += 1;
      await startGate;
    },
    async stop() {
      stopCalls += 1;
    },
  });

  const firstStart = engine.start();
  const secondStart = engine.start();
  assert.equal(startCalls, 1);
  releaseStart();
  await Promise.all([firstStart, secondStart]);
  assert.equal(engine.isRunning(), true);

  await Promise.all([engine.stop(), engine.stop()]);
  assert.equal(stopCalls, 1);
  assert.equal(engine.isRunning(), false);
});

test("stop waits for an in-flight start before unloading", async () => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const order: string[] = [];
  const engine = engineWith({
    async start() {
      order.push("start:begin");
      await startGate;
      order.push("start:end");
    },
    async stop() {
      order.push("stop");
    },
  });

  const starting = engine.start();
  const stopping = engine.stop();
  await Promise.resolve();
  assert.deepEqual(order, ["start:begin"]);
  releaseStart();
  await Promise.all([starting, stopping]);
  assert.deepEqual(order, ["start:begin", "start:end", "stop"]);
  assert.equal(engine.isRunning(), false);
});

test("failed engine starts can be retried cleanly", async () => {
  let attempts = 0;
  let stopCalls = 0;
  const engine = engineWith({
    async start() {
      attempts += 1;
      if (attempts === 1) throw new Error("engine start failed");
    },
    async stop() {
      stopCalls += 1;
    },
  });

  await assert.rejects(engine.start(), /engine start failed/);
  assert.equal(engine.isRunning(), false);
  await engine.start();
  assert.equal(engine.isRunning(), true);
  assert.equal(attempts, 2);
  assert.equal(stopCalls, 0);
  await engine.stop();
  assert.equal(stopCalls, 1);
});

test("failed engine stops stay visible and block unsafe restarts", async () => {
  let startCalls = 0;
  let stopCalls = 0;
  const engine = engineWith({
    async start() {
      startCalls += 1;
    },
    async stop() {
      stopCalls += 1;
      throw new Error("engine cleanup failed");
    },
  });

  await engine.start();
  await assert.rejects(engine.stop(), /engine cleanup failed/);
  await assert.rejects(engine.stop(), /engine cleanup failed/);
  await assert.rejects(engine.start(), /engine cleanup failed/);

  assert.equal(stopCalls, 1);
  assert.equal(startCalls, 1);
});

test("provider loads racing with shutdown are unloaded and not published", async () => {
  let releaseLoad!: () => void;
  let markLoadStarted!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    markLoadStarted = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let unloadCalls = 0;
  const engine = engineWithProviderBackend({
    async discover() {
      return [provider("https://rpc.invalid")];
    },
    async load() {
      markLoadStarted();
      await loadGate;
    },
    async unload() {
      unloadCalls += 1;
    },
  });
  await engine.start();

  const loading = engine.loadNetwork(NetworkName.Arbitrum);
  await loadStarted;
  const stopping = engine.stop();
  let stopSettled = false;
  void stopping.then(
    () => {
      stopSettled = true;
    },
    () => {
      stopSettled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);
  releaseLoad();

  await assert.rejects(loading, /stopped while loading/);
  await stopping;
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);
  assert.equal(unloadCalls, 1);
});

test("provider cleanup failures during shutdown remain visible", async () => {
  let releaseLoad!: () => void;
  let markLoadStarted!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    markLoadStarted = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const engine = engineWithProviderBackend({
    async discover() {
      return [provider("https://rpc.invalid")];
    },
    async load() {
      markLoadStarted();
      await loadGate;
    },
    async unload() {
      throw new Error("provider unload failed");
    },
  });
  await engine.start();

  const loading = engine.loadNetwork(NetworkName.Arbitrum);
  await loadStarted;
  const stopping = engine.stop();
  releaseLoad();

  await assert.rejects(loading, /stopped while loading/);
  await assert.rejects(stopping, /Provider unload after shutdown failed/);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);
});

test("provider load drain timeouts remain visible and do not publish providers", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let releaseLoad!: () => void;
  let markLoadStarted!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    markLoadStarted = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let unloadCalls = 0;
  const engine = new RailgunEngine(
    [],
    () => undefined,
    {
      async start() {},
      async stop() {
        throw new Error("engine cleanup failed");
      },
    },
    {
      async discover() {
        return [provider("https://rpc.invalid")];
      },
      async load() {
        markLoadStarted();
        await loadGate;
      },
      async unload() {
        unloadCalls += 1;
      },
    },
  );
  await engine.start();

  const loading = engine.loadNetwork(NetworkName.Arbitrum);
  await loadStarted;
  const stopping = engine.stop();
  context.mock.timers.tick(PROVIDER_LOAD_DRAIN_TIMEOUT_MS);

  await assert.rejects(
    stopping,
    (error) =>
      error instanceof AggregateError &&
      error.message ===
        "Provider loads did not drain before the shutdown deadline." &&
      error.errors.some(
        (failure) =>
          failure instanceof Error &&
          failure.message === "engine cleanup failed",
      ),
  );
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);

  releaseLoad();
  await assert.rejects(loading, /stopped while loading/);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);
  assert.equal(unloadCalls, 1);
});

test("provider unload failures after load errors abort retries", async () => {
  let loadCalls = 0;
  let unloadCalls = 0;
  const engine = engineWithProviderBackend({
    async discover() {
      return [
        provider("https://rpc.invalid"),
        provider("https://rpc2.invalid"),
      ];
    },
    async load() {
      loadCalls += 1;
      throw new Error("provider load failed");
    },
    async unload() {
      unloadCalls += 1;
      throw new Error("provider unload failed");
    },
  });
  await engine.start();

  await assert.rejects(
    engine.loadNetwork(NetworkName.Arbitrum),
    (error) =>
      error instanceof AggregateError &&
      error.message === "provider load failed" &&
      error.errors.some(
        (failure) =>
          failure instanceof Error &&
          failure.message === "provider unload failed",
      ),
  );
  assert.equal(loadCalls, 1);
  assert.equal(unloadCalls, 1);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);
  await engine.stop();
});

test("provider loads retry with the first provider when the full set fails", async () => {
  const loadConfigurations: string[][] = [];
  let unloadCalls = 0;
  const engine = engineWithProviderBackend({
    async discover() {
      return [
        provider("https://primary.invalid"),
        provider("https://secondary.invalid"),
      ];
    },
    async load(_network, configuration) {
      loadConfigurations.push(
        configuration.providers.map((candidate) => candidate.provider),
      );
      if (loadConfigurations.length === 1) {
        throw new Error("fallback set unavailable");
      }
    },
    async unload() {
      unloadCalls += 1;
    },
  });
  await engine.start();

  await engine.loadNetwork(NetworkName.Arbitrum);

  assert.deepEqual(loadConfigurations, [
    ["https://primary.invalid", "https://secondary.invalid"],
    ["https://primary.invalid"],
  ]);
  assert.equal(unloadCalls, 1);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), true);
  await engine.stop();
});

test("single-provider load failures are surfaced without a meaningless retry", async () => {
  let loadCalls = 0;
  let unloadCalls = 0;
  const engine = engineWithProviderBackend({
    async discover() {
      return [provider("https://primary.invalid")];
    },
    async load() {
      loadCalls += 1;
      throw new Error("provider load failed");
    },
    async unload() {
      unloadCalls += 1;
    },
  });
  await engine.start();

  await assert.rejects(
    engine.loadNetwork(NetworkName.Arbitrum),
    /provider load failed/,
  );

  assert.equal(loadCalls, 1);
  assert.equal(unloadCalls, 1);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);
  await engine.stop();
});

test("concurrent network loads share discovery and provider loading", async () => {
  let releaseLoad!: () => void;
  let markLoadStarted!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    markLoadStarted = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let discoverCalls = 0;
  let loadCalls = 0;
  const engine = engineWithProviderBackend({
    async discover() {
      discoverCalls += 1;
      return [provider("https://primary.invalid")];
    },
    async load() {
      loadCalls += 1;
      markLoadStarted();
      await loadGate;
    },
    async unload() {},
  });
  await engine.start();

  const first = engine.loadNetwork(NetworkName.Arbitrum);
  const second = engine.loadNetwork(NetworkName.Arbitrum);
  await loadStarted;
  assert.equal(discoverCalls, 1);
  assert.equal(loadCalls, 1);
  releaseLoad();

  await Promise.all([first, second]);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), true);
  assert.equal(discoverCalls, 1);
  assert.equal(loadCalls, 1);
  await engine.stop();
});

test("discovery failures are surfaced and can be retried without publication", async () => {
  let discoverCalls = 0;
  const engine = engineWithProviderBackend({
    async discover() {
      discoverCalls += 1;
      if (discoverCalls === 1) {
        throw new Error("provider discovery failed");
      }
      return [provider("https://primary.invalid")];
    },
    async load() {},
    async unload() {},
  });
  await engine.start();

  await assert.rejects(
    engine.loadNetwork(NetworkName.Arbitrum),
    /provider discovery failed/,
  );
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);

  await engine.loadNetwork(NetworkName.Arbitrum);
  assert.equal(discoverCalls, 2);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), true);
  await engine.stop();
});

test("exhausted provider load attempts surface the last failure", async () => {
  const failures = new Map([
    ["full-set", new Error("full provider set failed")],
    ["first-provider", new Error("first provider failed")],
  ]);
  let loadCalls = 0;
  let unloadCalls = 0;
  const engine = engineWithProviderBackend({
    async discover() {
      return [
        provider("https://primary.invalid"),
        provider("https://secondary.invalid"),
      ];
    },
    async load(_network, configuration) {
      loadCalls += 1;
      const key =
        configuration.providers.length > 1 ? "full-set" : "first-provider";
      throw failures.get(key);
    },
    async unload() {
      unloadCalls += 1;
    },
  });
  await engine.start();

  await assert.rejects(
    engine.loadNetwork(NetworkName.Arbitrum),
    /first provider failed/,
  );

  assert.equal(loadCalls, 2);
  assert.equal(unloadCalls, 2);
  assert.equal(engine.isNetworkLoaded(NetworkName.Arbitrum), false);
  await engine.stop();
});
