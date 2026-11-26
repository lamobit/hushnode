import {
  getEngine,
  getProver,
  getFallbackProviderForNetwork,
  loadProvider,
  setLoggers,
  SnarkJSGroth16,
  startRailgunEngine,
  stopRailgunEngine,
  unloadProvider,
} from "@railgun-community/wallet";
import {
  NETWORK_CONFIG,
  TXIDVersion,
  type Chain,
  type FallbackProviderJsonConfig,
  type NetworkName,
  type ProviderJson,
} from "@railgun-community/shared-models";
import { groth16 } from "snarkjs";
import LevelDOWN from "leveldown";
import {
  JsonRpcProvider,
  Network as EthersNetwork,
  WebSocketProvider,
} from "ethers";
import { settleWithin } from "../async-lifecycle.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import {
  chainFor,
  networkFor,
  providerObjects,
  type NetworkDefinition,
} from "../networks.js";
import { ensurePrivateDirectory } from "../private-directory.js";
import { createArtifactStore } from "./artifact-store.js";
import {
  createRpcProviderProbe,
  discoverReachableProviders,
} from "./provider-discovery.js";
import { tuneTxidSync } from "./txid-sync.js";

const log = createLogger("railgun-engine");

const ENGINE_NAME = "hushnode";
const PROVIDER_LOAD_TIMEOUT_MS = 20_000;
export const PROVIDER_LOAD_DRAIN_TIMEOUT_MS = 5_000;
const SCAN_TXID_VERSIONS = [
  TXIDVersion.V2_PoseidonMerkle,
  TXIDVersion.V3_PoseidonMerkle,
] as const;

export type ScanActivity = {
  utxo: boolean;
  txid: boolean;
};

export type RailgunEngineLifecycle = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type RailgunEngineProviderBackend = {
  discover(
    network: NetworkName,
    definition: NetworkDefinition,
  ): Promise<ProviderJson[]>;
  load(
    network: NetworkName,
    config: FallbackProviderJsonConfig,
  ): Promise<void>;
  unload(network: NetworkName): Promise<void>;
};

const errorCause = (error: unknown): unknown =>
  error instanceof Error
    ? (error as Error & { cause?: unknown }).cause
    : undefined;

const rpcProviderProbe = createRpcProviderProbe({
  createProvider: (url, chainId) => {
    const network = EthersNetwork.from(chainId);
    return /^wss?:/i.test(url)
      ? new WebSocketProvider(url, network)
      : new JsonRpcProvider(url, network, { staticNetwork: network });
  },
  definitionFor: (network) => ({
    chainId: networkFor(network).chainId,
    proxyContract: NETWORK_CONFIG[network].proxyContract,
  }),
  onFailure: (host, error) =>
    log.warn(`provider health check failed (${host})`, error),
  onCleanupFailure: (host, error) =>
    log.warn(`provider probe cleanup failed (${host})`, error),
});

const createSdkLifecycle = (
  poiNodeUrls: string[],
  onEngineLog: (level: "debug" | "error", value: unknown) => void,
): RailgunEngineLifecycle => ({
  async start() {
    tuneTxidSync();
    ensurePrivateDirectory(config.dataDir);
    ensurePrivateDirectory(config.engineDatabasePath);
    ensurePrivateDirectory(config.engineArtifactPath);

    const database = new LevelDOWN(config.engineDatabasePath);
    const artifacts = createArtifactStore(config.engineArtifactPath);
    try {
      await startRailgunEngine(
        ENGINE_NAME,
        database,
        process.env.LOG_LEVEL === "debug",
        artifacts,
        false,
        false,
        poiNodeUrls,
        undefined,
      );
      getProver().setSnarkJSGroth16(groth16 as SnarkJSGroth16);
      setLoggers(
        (message: string) => onEngineLog("debug", message),
        (error: unknown) => onEngineLog("error", error),
      );
    } catch (error) {
      await stopRailgunEngine().catch((cleanupError) => {
        log.warn("engine startup cleanup failed", cleanupError);
      });
      throw error;
    }
  },
  async stop() {
    await stopRailgunEngine();
  },
});

const sdkProviderBackend: RailgunEngineProviderBackend = {
  discover: (network, definition) =>
    discoverReachableProviders(
      network,
      providerObjects(definition),
      rpcProviderProbe,
    ),
  load: async (network, config) => {
    await loadProvider(config, network, PROVIDER_LOAD_TIMEOUT_MS);
  },
  unload: (network) => unloadProvider(network),
};

export class RailgunEngine {
  private running = false;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private lifecycleGeneration = 0;
  private readonly shutdownCleanupFailures: Error[] = [];
  private readonly lifecycle: RailgunEngineLifecycle;
  private readonly providerBackend: RailgunEngineProviderBackend;
  private readonly loadedNetworks = new Set<NetworkName>();
  private readonly loadingNetworks = new Map<NetworkName, Promise<void>>();

  constructor(
    poiNodeUrls: string[],
    onEngineLog: (level: "debug" | "error", value: unknown) => void,
    lifecycle?: RailgunEngineLifecycle,
    providerBackend: RailgunEngineProviderBackend = sdkProviderBackend,
  ) {
    this.lifecycle = lifecycle ?? createSdkLifecycle(poiNodeUrls, onEngineLog);
    this.providerBackend = providerBackend;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.running) return;
    if (this.starting) return this.starting;

    this.lifecycleGeneration += 1;
    const starting = (async () => {
      await this.lifecycle.start();
      this.running = true;
      log.info("engine started");
    })();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  async loadNetwork(network: NetworkName): Promise<void> {
    await this.start();
    if (this.loadedNetworks.has(network)) return;
    const inFlight = this.loadingNetworks.get(network);
    if (inFlight) return inFlight;

    const loading = this.loadNetworkInternal(network);
    this.loadingNetworks.set(network, loading);
    try {
      await loading;
    } finally {
      this.loadingNetworks.delete(network);
    }
  }

  private async loadNetworkInternal(network: NetworkName): Promise<void> {
    const definition = networkFor(network);
    if (this.loadedNetworks.has(network)) return;
    const generation = this.lifecycleGeneration;
    const loadIsCurrent = (): boolean =>
      generation === this.lifecycleGeneration &&
      this.running &&
      !this.stopping;
    const stoppedWhileLoading = (): Error =>
      new Error(`Engine stopped while loading ${definition.label}.`);
    if (!loadIsCurrent()) throw stoppedWhileLoading();

    const available = await this.providerBackend.discover(network, definition);
    if (!loadIsCurrent()) throw stoppedWhileLoading();
    if (available.length === 0) {
      throw new Error(`No reachable RPC provider for ${definition.label}.`);
    }

    const attempts = available.length > 1
      ? [available, available.slice(0, 1)]
      : [available];
    let lastError: unknown;
    for (const providers of attempts) {
      if (!loadIsCurrent()) throw stoppedWhileLoading();
      const providerConfig: FallbackProviderJsonConfig = {
        chainId: definition.chainId,
        providers,
      };
      try {
        await this.providerBackend.load(network, providerConfig);
        if (!loadIsCurrent()) throw stoppedWhileLoading();
        this.loadedNetworks.add(network);
        log.info(`providers loaded for ${definition.label}`);
        return;
      } catch (error) {
        lastError = error;
        const cause = errorCause(error);
        if (loadIsCurrent()) {
          log.warn("provider load attempt failed", cause ?? error);
        } else {
          log.warn(
            `provider load for ${definition.label} cancelled by shutdown`,
            cause ?? error,
          );
        }
        try {
          await this.providerBackend.unload(network);
        } catch (cleanupError) {
          if (!loadIsCurrent()) {
            this.shutdownCleanupFailures.push(
              new Error(
                `Provider unload after shutdown failed for ${definition.label}.`,
              ),
            );
            throw new AggregateError(
              [error, cleanupError],
              error instanceof Error
                ? error.message
                : "Provider cleanup after shutdown failed.",
            );
          }
          throw new AggregateError(
            [error, cleanupError],
            error instanceof Error
              ? error.message
              : "Provider cleanup after load failure failed.",
          );
        }
        if (!loadIsCurrent()) throw error;
      }
    }
    log.error("provider load failed", lastError);
    throw lastError ?? new Error(
      `Could not load ${definition.label} providers.`,
    );
  }

  provider(network: NetworkName): ReturnType<typeof getFallbackProviderForNetwork> {
    if (!this.loadedNetworks.has(network)) {
      throw new Error(`Network ${network} has not been loaded.`);
    }
    return getFallbackProviderForNetwork(network);
  }

  isNetworkLoaded(network: NetworkName): boolean {
    return this.loadedNetworks.has(network);
  }

  async lastSyncedBlock(
    network: NetworkName,
    txidVersion: TXIDVersion,
  ): Promise<number | undefined> {
    if (!this.running) return undefined;
    const chain: Chain = chainFor(networkFor(network));
    const engine = getEngine() as unknown as {
      getLastSyncedBlock: (
        txidVersion: TXIDVersion,
        chain: Chain,
      ) => Promise<number | undefined>;
    };
    try {
      const block = await engine.getLastSyncedBlock(
        txidVersion,
        chain,
      );
      return Number.isFinite(block) ? block : undefined;
    } catch {
      return undefined;
    }
  }

  scanActivity(network: NetworkName): ScanActivity {
    if (!this.running) return { utxo: false, txid: false };
    const chain = chainFor(networkFor(network));
    const engine = getEngine();
    const activity: ScanActivity = { utxo: false, txid: false };
    const isScanning = (read: () => { isScanning: boolean }): boolean => {
      try {
        return read().isScanning;
      } catch {
        return false;
      }
    };
    for (const txidVersion of SCAN_TXID_VERSIONS) {
      activity.utxo ||= isScanning(() =>
        engine.getUTXOMerkletree(txidVersion, chain),
      );
      activity.txid ||= isScanning(() =>
        engine.getTXIDMerkletree(txidVersion, chain),
      );
    }
    return activity;
  }

  getUTXOMerkletree(txidVersion: TXIDVersion, chain: Chain) {
    return getEngine().getUTXOMerkletree(txidVersion, chain);
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const starting = this.starting;
    if (!this.running && !starting) return;

    this.lifecycleGeneration += 1;
    const stopping = (async () => {
      if (starting) await starting.catch(() => undefined);
      if (!this.running) return;
      this.running = false;
      this.loadedNetworks.clear();
      const providerLoadsDrained = await settleWithin(
        this.loadingNetworks.values(),
        PROVIDER_LOAD_DRAIN_TIMEOUT_MS,
      );
      let lifecycleCleanupFailure: unknown;
      try {
        await this.lifecycle.stop();
      } catch (error) {
        lifecycleCleanupFailure = error;
      }
      const cleanupFailures: unknown[] = [];
      if (!providerLoadsDrained) {
        cleanupFailures.push(
          new Error(
            "Provider loads did not drain before the shutdown deadline.",
          ),
        );
      }
      cleanupFailures.push(...this.shutdownCleanupFailures);
      if (lifecycleCleanupFailure !== undefined) {
        cleanupFailures.push(lifecycleCleanupFailure);
      }
      if (cleanupFailures.length > 0) {
        const primary = cleanupFailures[0];
        throw new AggregateError(
          cleanupFailures,
          primary instanceof Error
            ? primary.message
            : "Engine cleanup was incomplete.",
        );
      }
    })();
    this.stopping = stopping;
    try {
      await stopping;
    } catch (error) {
      // Keep the rejected shutdown memoized: a later stop must not report
      // success, and a restart must not reuse a partially cleaned-up engine.
      throw error;
    }
    if (this.stopping === stopping) this.stopping = undefined;
  }
}
