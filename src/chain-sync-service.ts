import {
  MerkletreeScanStatus,
  NetworkName,
  type Chain,
  type MerkletreeScanUpdateEvent,
} from "@railgun-community/shared-models";
import {
  refreshBalances,
  setOnTXIDMerkletreeScanCallback,
  setOnUTXOMerkletreeScanCallback,
} from "@railgun-community/wallet";
import { settleCleanup, settleWithin } from "./async-lifecycle.js";
import { config } from "./config.js";
import {
  deriveIndexReadiness,
  type IndexReadiness,
  type IndexRuntimeStatus,
} from "./index-readiness.js";
import { createLogger } from "./logger.js";
import {
  NETWORKS,
  chainFor,
  networkFor,
  networkForChainId,
} from "./networks.js";
import { RailgunEngine } from "./railgun/engine.js";
import {
  fallbackRemoteConfig,
  loadRemoteConfig,
  type EffectiveRemoteConfig,
} from "./railgun/remote-config.js";

const log = createLogger("chain-sync");

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const SCAN_EVENT_GRACE_MS = 5_000;
const SCAN_BUSY_POLL_MS = 1_000;
const SCAN_BUSY_TIMEOUT_MS = 30 * 60_000;
export const CHAIN_SYNC_STOP_TIMEOUT_MS = 20_000;

type TreeScan = {
  state: "pending" | "complete" | "error";
};

type ScanTracker = {
  utxo: TreeScan;
  txid: TreeScan;
  maintenance: boolean;
  done: Promise<void>;
  resolve: () => void;
};

type ChainRuntime = {
  status: IndexRuntimeStatus;
  retryAttempt: number;
  lastCompletedAt?: number;
};

type ReadyWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  detach: () => void;
};

const isScanSettled = (scan: TreeScan): boolean => scan.state !== "pending";

const isScanComplete = (tracker: ScanTracker): boolean =>
  tracker.utxo.state === "complete" && tracker.txid.state === "complete";

const retryBackoffMs = (attempt: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

const initialRuntime = (): ChainRuntime => ({
  status: "idle",
  retryAttempt: 0,
});

export type ChainSyncServiceOptions = {
  loadConfig?: (rpcUrls: string[]) => Promise<{ poiNodeUrls: string[] }>;
  createEngine?: (
    poiNodeUrls: string[],
    onEngineLog: (level: "debug" | "error", value: unknown) => void,
  ) => RailgunEngine;
  installScanCallbacks?: (handlers: ChainSyncScanHandlers) => void;
  refreshBalances?: (chain: Chain) => Promise<void>;
  stopTimeoutMs?: number;
};

export type ChainSyncScanHandlers = {
  onUtxo: (event: MerkletreeScanUpdateEvent) => void;
  onTxid: (event: MerkletreeScanUpdateEvent) => void;
};

export class ChainSyncService {
  private readonly runtimes = new Map<NetworkName, ChainRuntime>(
    NETWORKS.map((network) => [network.id, initialRuntime()]),
  );
  private readonly queued = new Set<NetworkName>();
  private readonly running = new Map<NetworkName, Promise<void>>();
  private readonly scheduled = new Map<
    NetworkName,
    { timer: NodeJS.Timeout; kind: "retry" | "periodic" }
  >();
  private readonly trackers = new Map<NetworkName, ScanTracker>();
  private readonly readyWaiters = new Map<NetworkName, Set<ReadyWaiter>>();
  private engine: RailgunEngine | undefined;
  private remoteConfig: EffectiveRemoteConfig | undefined;
  private initializationCleanupFailure: Error | undefined;
  private initialized = false;
  private initializing: Promise<void> | undefined;
  private schedulerStarted = false;
  private stopping = false;
  private shutdownPromise: Promise<void> | undefined;
  private pumpTimer: NodeJS.Timeout | undefined;
  private readonly loadConfig: NonNullable<
    ChainSyncServiceOptions["loadConfig"]
  >;
  private readonly createEngine: NonNullable<
    ChainSyncServiceOptions["createEngine"]
  >;
  private readonly installScanCallbacks: NonNullable<
    ChainSyncServiceOptions["installScanCallbacks"]
  >;
  private readonly refreshChainBalances: NonNullable<
    ChainSyncServiceOptions["refreshBalances"]
  >;
  private readonly stopTimeoutMs: number;

  constructor(options: ChainSyncServiceOptions = {}) {
    this.loadConfig = options.loadConfig ?? loadRemoteConfig;
    this.createEngine =
      options.createEngine ??
      ((poiNodeUrls, onEngineLog) =>
        new RailgunEngine(poiNodeUrls, onEngineLog));
    this.installScanCallbacks =
      options.installScanCallbacks ??
      ((handlers) => {
        setOnUTXOMerkletreeScanCallback(handlers.onUtxo);
        setOnTXIDMerkletreeScanCallback(handlers.onTxid);
      });
    this.refreshChainBalances =
      options.refreshBalances ??
      ((chain) => refreshBalances(chain, []));
    this.stopTimeoutMs =
      options.stopTimeoutMs ?? CHAIN_SYNC_STOP_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    if (this.initializationCleanupFailure) {
      throw new Error(
        "Chain sync service cannot restart after an incomplete engine cleanup.",
      );
    }
    if (this.stopping) {
      throw new Error("Chain sync service is stopping.");
    }
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeInternal();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  private async initializeInternal(): Promise<void> {
    const remoteConfig = await this.loadConfig(
      networkFor(NetworkName.Ethereum).providers,
    ).catch((error) => {
      log.warn("remote config fallback", error);
      return fallbackRemoteConfig();
    });
    if (remoteConfig.poiNodeUrls.length === 0) {
      throw new Error(
        "No PPOI aggregator URLs are available; refusing to start the RAILGUN engine.",
      );
    }
    if (this.stopping) {
      throw new Error("Chain sync service stopped during initialization.");
    }

    this.remoteConfig = {
      ...fallbackRemoteConfig(),
      ...(remoteConfig as Partial<EffectiveRemoteConfig>),
      poiNodeUrls: remoteConfig.poiNodeUrls,
    };
    const engine = this.createEngine(
      remoteConfig.poiNodeUrls,
      (level, value) => {
        if (level === "error") log.warn("RAILGUN engine", value);
      },
    );
    try {
      await engine.start();
      if (this.stopping) {
        throw new Error("Chain sync service stopped during initialization.");
      }
      this.installScanCallbacks({
        onUtxo: (event) => this.handleScanEvent("utxo", event),
        onTxid: (event) => this.handleScanEvent("txid", event),
      });
      this.engine = engine;
      this.initialized = true;
      log.info("chain sync service initialized");
    } catch (error) {
      try {
        await engine.stop();
      } catch (cleanupError) {
        this.initializationCleanupFailure =
          cleanupError instanceof Error
            ? cleanupError
            : new Error("Engine cleanup after initialization failure failed.");
        throw new AggregateError(
          [error, cleanupError],
          error instanceof Error
            ? error.message
            : "Chain sync service initialization failed.",
        );
      }
      throw error;
    }
  }

  getEngine(): RailgunEngine {
    if (!this.engine) {
      throw new Error("Chain sync service has not been initialized.");
    }
    return this.engine;
  }

  getRemoteConfig(): EffectiveRemoteConfig {
    if (!this.remoteConfig) {
      throw new Error("Chain sync service has not been initialized.");
    }
    return this.remoteConfig;
  }

  isRunning(): boolean {
    return Boolean(this.engine?.isRunning());
  }

  isNetworkLoaded(network: NetworkName): boolean {
    return Boolean(this.engine?.isNetworkLoaded(network));
  }

  provider(network: NetworkName): ReturnType<RailgunEngine["provider"]> {
    return this.getEngine().provider(network);
  }

  async ensureNetworkLoaded(network: NetworkName): Promise<void> {
    if (this.stopping) throw new Error("Chain sync service is stopping.");
    await this.getEngine().loadNetwork(network);
  }

  start(): void {
    if (!this.initialized || this.stopping) return;
    this.schedulerStarted = true;
    for (const network of NETWORKS) {
      if (this.runtime(network.id).status === "idle") {
        this.enqueue(network.id);
      }
    }
  }

  isReady(network: NetworkName): boolean {
    return (
      this.readiness(network).ready &&
      !this.running.has(network)
    );
  }

  readiness(network: NetworkName): IndexReadiness {
    return deriveIndexReadiness(this.runtime(network), {
      initialized: this.initialized,
      running: this.isRunning(),
      networkLoaded: this.isNetworkLoaded(network),
      stopping: this.stopping,
    });
  }

  waitForReady(
    network: NetworkName,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.isReady(network)) return Promise.resolve();
    if (this.stopping) {
      return Promise.reject(new Error("Chain sync service stopped."));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Remote scan was cancelled."));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.removeWaiter(network, waiter);
        reject(new Error("Remote scan was cancelled."));
      };
      const waiter: ReadyWaiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        detach: () => {
          signal?.removeEventListener("abort", onAbort);
        },
      };
      let waiters = this.readyWaiters.get(network);
      if (!waiters) {
        waiters = new Set();
        this.readyWaiters.set(network, waiters);
      }
      waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      queueMicrotask(() => {
        if (!signal?.aborted && this.isReady(network)) {
          this.removeWaiter(network, waiter);
          waiter.resolve();
        }
      });
    });
  }

  stop(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = this.stopInternal();
    return this.shutdownPromise;
  }

  private async stopInternal(): Promise<void> {
    this.schedulerStarted = false;
    this.queued.clear();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.clearAllScheduled();
    for (const waiters of this.readyWaiters.values()) {
      for (const waiter of waiters) {
        waiter.detach();
        waiter.reject(new Error("Chain sync service stopped."));
      }
    }
    this.readyWaiters.clear();

    const initializing = this.initializing;
    const [activeDrained, initializationDrained] = await Promise.all([
      settleWithin(this.running.values(), this.stopTimeoutMs),
      initializing
        ? settleWithin([initializing], this.stopTimeoutMs)
        : true,
    ]);
    const engine = this.engine;
    this.engine = undefined;
    this.initialized = false;
    const engineCleanup = await settleCleanup(
      () => engine?.stop(),
      this.stopTimeoutMs,
      "Chain sync engine cleanup did not finish before the shutdown deadline.",
    );
    if (!engineCleanup.ok) {
      log.error("engine stop failed", engineCleanup.error);
    }
    const cleanupErrors = [
      activeDrained
        ? undefined
        : new Error(
            "Chain sync network tasks did not drain before the shutdown deadline.",
          ),
      initializationDrained
        ? undefined
        : new Error(
            "Chain sync initialization did not drain before the shutdown deadline.",
          ),
      this.initializationCleanupFailure,
      engineCleanup.ok ? undefined : engineCleanup.error,
    ].filter((error) => error !== undefined);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        cleanupErrors[0] instanceof Error
          ? cleanupErrors[0].message
          : "Chain sync engine cleanup was incomplete.",
      );
    }
    log.info("chain sync service stopped");
  }

  private runtime(network: NetworkName): ChainRuntime {
    const runtime = this.runtimes.get(network);
    if (!runtime) throw new Error(`Unsupported chain sync network: ${network}`);
    return runtime;
  }

  private enqueue(network: NetworkName): void {
    if (
      this.stopping ||
      !this.schedulerStarted ||
      this.running.has(network)
    ) {
      return;
    }
    this.clearScheduled(network);
    const runtime = this.runtime(network);
    if (runtime.status !== "ready") {
      runtime.status = "queued";
    }
    this.queued.add(network);
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpTimer || this.stopping) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, 0);
    this.pumpTimer.unref();
  }

  private pump(): void {
    if (this.stopping || !this.schedulerStarted) return;
    while (this.queued.size > 0) {
      const network = this.nextNetwork();
      if (!network) return;
      this.queued.delete(network);
      const execution = this.runNetwork(network).finally(() => {
        this.running.delete(network);
        this.schedulePump();
      });
      this.running.set(network, execution);
    }
  }

  private nextNetwork(): NetworkName | undefined {
    const order = new Map(
      NETWORKS.map((network, index) => [network.id, index]),
    );
    return [...this.queued].sort((left, right) => {
      const leftCompleted = this.runtime(left).lastCompletedAt ?? 0;
      const rightCompleted = this.runtime(right).lastCompletedAt ?? 0;
      if (leftCompleted !== rightCompleted) return leftCompleted - rightCompleted;
      return (order.get(left) ?? 0) - (order.get(right) ?? 0);
    })[0];
  }

  private async runNetwork(network: NetworkName): Promise<void> {
    if (this.stopping) return;
    const definition = networkFor(network);
    const runtime = this.runtime(network);
    const isPeriodicRefresh = runtime.status === "ready";
    const tracker = this.createTracker(isPeriodicRefresh);
    if (!isPeriodicRefresh) {
      runtime.status = "syncing";
    }
    this.trackers.set(network, tracker);

    try {
      await this.getEngine().loadNetwork(network);
      if (this.stopping) return;
      await this.refreshChainBalances(chainFor(definition));
      await this.awaitScanCompletion(network, tracker);
      if (!isScanComplete(tracker)) {
        const failedScans: string[] = [];
        if (tracker.utxo.state === "error") failedScans.push("UTXO");
        if (tracker.txid.state === "error") failedScans.push("TXID");
        throw new Error(
          failedScans.length > 0
            ? `RAILGUN ${failedScans.join("/")} history scan was incomplete.`
            : "RAILGUN history scan did not report completion.",
        );
      }
      runtime.status = "ready";
      runtime.lastCompletedAt = Date.now();
      runtime.retryAttempt = 0;
      this.resolveWaiters(network);
      this.schedule(network, config.chainSyncIntervalMs, "periodic");
      log.info(`${definition.label} chain data is synced`);
    } catch (error) {
      if (!this.stopping) {
        runtime.status = "error";
        runtime.retryAttempt += 1;
        const backoff = retryBackoffMs(runtime.retryAttempt);
        this.schedule(network, backoff, "retry");
        log.warn(
          `${definition.label} chain sync failed; retrying in ${Math.round(
            backoff / 1_000,
          )}s`,
          error,
        );
      }
    } finally {
      this.trackers.delete(network);
    }
  }

  private async awaitScanCompletion(
    network: NetworkName,
    tracker: ScanTracker,
  ): Promise<boolean> {
    const settled = () =>
      isScanSettled(tracker.utxo) && isScanSettled(tracker.txid);
    if (settled()) return true;
    const graceElapsed = await Promise.race([
      tracker.done.then(() => false),
      delay(SCAN_EVENT_GRACE_MS).then(() => true),
    ]);
    if (!graceElapsed || settled()) return true;

    const deadline = Date.now() + SCAN_BUSY_TIMEOUT_MS;
    while (!this.stopping && Date.now() < deadline) {
      const activity = this.getEngine().scanActivity(network);
      if (!activity.utxo && !activity.txid) return settled();
      const finished = await Promise.race([
        tracker.done.then(() => true),
        delay(SCAN_BUSY_POLL_MS).then(() => false),
      ]);
      if (finished) return true;
    }
    return settled();
  }

  private createTracker(maintenance = false): ScanTracker {
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((doneResolve) => {
      resolve = doneResolve;
    });
    return {
      utxo: { state: "pending" },
      txid: { state: "pending" },
      maintenance,
      done,
      resolve,
    };
  }

  private handleScanEvent(
    tree: "utxo" | "txid",
    event: MerkletreeScanUpdateEvent,
  ): void {
    const network = networkForChainId(event.chain.id);
    if (!network) return;
    const tracker = this.trackers.get(network.id);
    if (!tracker) return;
    if (
      tracker.maintenance &&
      (event.scanStatus === MerkletreeScanStatus.Started ||
        event.scanStatus === MerkletreeScanStatus.Updated)
    ) {
      return;
    }
    const scan = tree === "utxo" ? tracker.utxo : tracker.txid;
    if (
      event.scanStatus === MerkletreeScanStatus.Started ||
      event.scanStatus === MerkletreeScanStatus.Updated
    ) {
      scan.state = "pending";
    } else if (event.scanStatus === MerkletreeScanStatus.Complete) {
      scan.state = "complete";
    } else if (event.scanStatus === MerkletreeScanStatus.Incomplete) {
      scan.state = "error";
    }

    if (
      (tracker.utxo.state === "complete" ||
        tracker.utxo.state === "error") &&
      (tracker.txid.state === "complete" || tracker.txid.state === "error")
    ) {
      tracker.resolve();
    }
  }

  private schedule(
    network: NetworkName,
    milliseconds: number,
    kind: "retry" | "periodic",
  ): void {
    this.clearScheduled(network);
    if (this.stopping) return;
    const timer = setTimeout(() => {
      this.scheduled.delete(network);
      this.enqueue(network);
    }, milliseconds);
    timer.unref();
    this.scheduled.set(network, { timer, kind });
  }

  private clearScheduled(network: NetworkName): void {
    const scheduled = this.scheduled.get(network);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this.scheduled.delete(network);
  }

  private clearAllScheduled(): void {
    for (const scheduled of this.scheduled.values()) {
      clearTimeout(scheduled.timer);
    }
    this.scheduled.clear();
  }

  private resolveWaiters(network: NetworkName): void {
    const waiters = this.readyWaiters.get(network);
    if (!waiters) return;
    this.readyWaiters.delete(network);
    for (const waiter of waiters) waiter.resolve();
  }

  private removeWaiter(network: NetworkName, waiter: ReadyWaiter): void {
    const waiters = this.readyWaiters.get(network);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.readyWaiters.delete(network);
  }
}
