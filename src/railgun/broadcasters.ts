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
  private queue: Promise<unknown> = Promise.resolve();

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
            this.connected = status === "Connected";
          },
        );
        this.started = true;
        return;
      }
      if (sameChain(this.activeChain, chain)) return;
      this.connected = false;
      await WakuBroadcasterClient.setChain(chain);
      this.activeChain = chain;
    });
  }

  bestForToken(
    chain: Chain,
    tokenAddress: string,
  ): SelectedBroadcaster | undefined {
    if (!this.isConnected(chain)) return undefined;
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
    await this.exclusive(async () => {
      if (!this.started) return;
      await WakuBroadcasterClient.stop().catch((error: unknown) => {
        log.warn("broadcaster stop failed", error);
      });
      this.started = false;
      this.connected = false;
      this.activeChain = undefined;
    });
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

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
