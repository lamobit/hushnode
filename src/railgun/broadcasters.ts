import {
  POI_REQUIRED_LISTS,
  TXIDVersion,
  type Chain,
  type PreTransactionPOIsPerTxidLeafPerList,
  type SelectedBroadcaster,
} from "@railgun-community/shared-models";
import {
  BroadcasterTransaction,
  WakuBroadcasterClient,
} from "@railgun-community/waku-broadcaster-client-node";
import { createLogger } from "../logger.js";
import type { EffectiveRemoteConfig } from "./remote-config.js";

const log = createLogger("broadcasters");

const MAX_PENDING_OPERATIONS = 128;
const MAX_QUEUE_WAIT_MS = 30_000;
const MIN_RECONNECT_INTERVAL_MS = 20_000;

export class BroadcasterTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BroadcasterTransportError";
  }
}

const sameChain = (left: Chain | undefined, right: Chain): boolean =>
  Boolean(
    left && left.type === right.type && left.id === right.id,
  );

export type BroadcasterSubmission = {
  txidVersion: TXIDVersion;
  to: string;
  data: string;
  broadcasterRailgunAddress: string;
  feesID: string;
  chain: Chain;
  nullifiers: string[];
  overallBatchMinGasPrice: bigint;
  preTransactionPOIsPerTxidLeafPerList: PreTransactionPOIsPerTxidLeafPerList;
};

/**
 * Process-wide Waku broadcaster session. The SDK keeps one connection and one
 * active chain, so every operation is serialized through `exclusive`.
 */
export class BroadcasterNetwork {
  private config: EffectiveRemoteConfig | undefined;
  private activeChain: Chain | undefined;
  private started = false;
  private connected = false;
  private lastStatus: string | undefined;
  private lastReconnectAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;

  constructor(private readonly getConfig: () => EffectiveRemoteConfig) {}

  isConnected(chain: Chain): boolean {
    return this.started && this.connected && sameChain(this.activeChain, chain);
  }

  isStarted(): boolean {
    return this.started;
  }

  async ensureChain(chain: Chain): Promise<void> {
    await this.exclusive(async () => {
      const config = this.configure();
      if (!this.started) {
        this.activeChain = chain;
        await WakuBroadcasterClient.start(
          chain,
          {
            trustedFeeSigner: config.trustedFeeSigners,
            poiActiveListKeys: POI_REQUIRED_LISTS.map((list) => list.key),
            pubSubTopic: config.pubSubTopic,
            additionalDirectPeers: config.additionalDirectPeers,
          },
          (_chain, status) => {
            this.lastStatus = status;
            this.connected = status === "Connected";
          },
        );
        this.started = true;
        return;
      }
      if (sameChain(this.activeChain, chain)) return;
      this.connected = false;
      this.lastStatus = undefined;
      await WakuBroadcasterClient.setChain(chain);
      this.activeChain = chain;
    });
  }

  /**
   * Restarts the Waku session when fee traffic has stalled. The SDK reconnects on
   * its own for hard disconnects, but a session that stays in `Searching` keeps
   * serving an empty fee cache until it is re-initialized.
   */
  async reconnect(chain: Chain): Promise<void> {
    if (!this.started || !sameChain(this.activeChain, chain)) return;
    if (Date.now() - this.lastReconnectAt < MIN_RECONNECT_INTERVAL_MS) return;
    this.lastReconnectAt = Date.now();
    this.connected = false;
    log.warn("restarting broadcaster session", {
      status: this.lastStatus ?? "unknown",
    });
    await this.exclusive(async () => {
      await WakuBroadcasterClient.tryReconnect().catch((error: unknown) => {
        log.warn("broadcaster reconnect failed", error);
      });
    }, true);
  }

  bestForToken(
    chain: Chain,
    tokenAddress: string,
  ): SelectedBroadcaster | undefined {
    try {
      return WakuBroadcasterClient.findBestBroadcaster(
        chain,
        tokenAddress.toLowerCase(),
        false,
        false,
      );
    } catch (error) {
      log.warn("broadcaster lookup failed", error);
      return undefined;
    }
  }

  /**
   * Looks up a specific broadcaster so a quote stays usable after a cheaper
   * broadcaster appears. Returns undefined when that broadcaster no longer
   * advertises an unexpired fee for the token.
   */
  broadcasterFor(
    chain: Chain,
    tokenAddress: string,
    railgunAddress: string,
  ): SelectedBroadcaster | undefined {
    if (!this.started || !sameChain(this.activeChain, chain)) return undefined;
    try {
      const candidates = WakuBroadcasterClient.findBroadcastersForToken(
        chain,
        tokenAddress.toLowerCase(),
        false,
      );
      return candidates?.find(
        (candidate: SelectedBroadcaster) =>
          candidate.railgunAddress === railgunAddress,
      );
    } catch (error) {
      log.warn("broadcaster lookup failed", error);
      return undefined;
    }
  }

  async submit(request: BroadcasterSubmission): Promise<string> {
    return this.exclusive(async () => {
      if (!this.started) {
        throw new Error("Broadcaster client is not started.");
      }
      const transaction = await BroadcasterTransaction.create(
        request.txidVersion,
        request.to,
        request.data,
        request.broadcasterRailgunAddress,
        request.feesID,
        request.chain,
        request.nullifiers,
        request.overallBatchMinGasPrice,
        false,
        request.preTransactionPOIsPerTxidLeafPerList,
      );
      return transaction.send();
    });
  }

  async stop(): Promise<void> {
    await this.exclusive(
      async () => {
        if (!this.started) return;
        await WakuBroadcasterClient.stop().catch((error: unknown) => {
          log.warn("broadcaster stop failed", error);
        });
        this.started = false;
        this.connected = false;
        this.lastStatus = undefined;
        this.activeChain = undefined;
      },
      true,
    );
  }

  private configure(): EffectiveRemoteConfig {
    if (this.config) return this.config;
    const config = this.getConfig();
    WakuBroadcasterClient.setAddressFilters(
      config.trustedFeeSigners,
      config.blacklist.length > 0 ? config.blacklist : undefined,
    );
    this.config = config;
    return config;
  }

  private exclusive<T>(
    operation: () => Promise<T>,
    force = false,
  ): Promise<T> {
    if (!force && this.pendingOperations >= MAX_PENDING_OPERATIONS) {
      return Promise.reject(
        new BroadcasterTransportError(
          "Broadcaster relay is busy; try again later.",
        ),
      );
    }
    this.pendingOperations += 1;
    const queuedAt = Date.now();
    let expired = false;
    const run = async (): Promise<T> => {
      try {
        if (
          !force &&
          (expired || Date.now() - queuedAt > MAX_QUEUE_WAIT_MS)
        ) {
          throw new BroadcasterTransportError(
            "Broadcaster relay request expired while queued.",
          );
        }
        return await operation();
      } finally {
        this.pendingOperations = Math.max(0, this.pendingOperations - 1);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    if (force) return next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        expired = true;
        reject(
          new BroadcasterTransportError(
            "Broadcaster relay is busy; try again later.",
          ),
        );
      }, MAX_QUEUE_WAIT_MS);
      timer.unref();
      next.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
