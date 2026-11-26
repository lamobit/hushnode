import {
  NETWORK_CONFIG,
  TXIDVersion,
  type NetworkName,
} from "@railgun-community/shared-models";
import { Interface } from "ethers";
import { NETWORKS, networkFor } from "../networks.js";
import { raceWithAbort, throwIfAborted } from "../abort.js";
import {
  fetchPublicActivity,
  type PublicActivityFetcher,
  type PublicActivityResult,
} from "../public-activity.js";
import {
  createFiatPriceSource,
  type FiatCurrency,
  type FiatPriceSource,
} from "../prices.js";
import { SingleFlight } from "../single-flight.js";
import { TtlCache } from "../ttl-cache.js";
import { RAILGUN_FEE_SELECTORS } from "../railgun/fees.js";
import { createLogger } from "../logger.js";
import {
  MAX_ACTIVITY_LIMIT,
  LightApiError,
  normalizeRoot,
  parseFeeValue,
  type LightAnchorCheck,
  type LightFeeQuote,
  type LightIndexSource,
} from "./protocol.js";

const log = createLogger("light-catalog");

const FEE_CACHE_MS = 60_000;
const PRICE_CACHE_MS = 45_000;
const ANCHOR_CACHE_MS = 15_000;
const ANCHOR_CACHE_MAX_ENTRIES = 1_024;
const ACTIVITY_CACHE_MS = 15_000;
const ACTIVITY_PARTIAL_CACHE_MS = 5_000;
const ACTIVITY_CACHE_MAX_ENTRIES = 1_024;
const ACTIVITY_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export type PriceSnapshot = {
  prices: Record<string, number>;
  updatedAt: number;
};

export type LightCatalogOptions = {
  priceSource?: FiatPriceSource;
  now?: () => number;
  publicActivityFetcher?: PublicActivityFetcher;
};

const ANCHOR_ABI = new Interface([
  "function merkleRoot() view returns (bytes32)",
  "function accumulatorRoot() view returns (bytes32)",
  "function rootHistory(uint256 tree, bytes32 root) view returns (bool)",
]);
const MERKLE_ROOT_DATA = ANCHOR_ABI.encodeFunctionData("merkleRoot");
const ACCUMULATOR_ROOT_DATA =
  ANCHOR_ABI.encodeFunctionData("accumulatorRoot");

const activityResultBytes = (result: PublicActivityResult): number =>
  Buffer.byteLength(JSON.stringify(result), "utf8");

/**
 * Owns the bounded caches and coalescing rules for external index data.
 * Route handlers only orchestrate request validation and response shaping.
 */
export class LightCatalog {
  private readonly feeCache: TtlCache<NetworkName, LightFeeQuote>;
  private readonly anchorCache: TtlCache<string, LightAnchorCheck>;
  private readonly priceCache: TtlCache<string, PriceSnapshot>;
  private readonly activityCache: TtlCache<string, PublicActivityResult>;
  private readonly feeRequests = new SingleFlight<
    NetworkName,
    LightFeeQuote
  >();
  private readonly anchorRequests = new SingleFlight<
    string,
    LightAnchorCheck
  >();
  private readonly priceRequests = new SingleFlight<string, PriceSnapshot>();
  private readonly activityRequests = new SingleFlight<
    string,
    PublicActivityResult
  >();
  private readonly priceSource: FiatPriceSource;
  private readonly publicActivityFetcher: PublicActivityFetcher;

  constructor(options: LightCatalogOptions = {}) {
    const now = options.now ?? Date.now;
    this.feeCache = new TtlCache(FEE_CACHE_MS, NETWORKS.length, now);
    this.anchorCache = new TtlCache(
      ANCHOR_CACHE_MS,
      ANCHOR_CACHE_MAX_ENTRIES,
      now,
    );
    this.priceCache = new TtlCache(
      PRICE_CACHE_MS,
      NETWORKS.length * 8,
      now,
    );
    this.activityCache = new TtlCache(
      ACTIVITY_CACHE_MS,
      ACTIVITY_CACHE_MAX_ENTRIES,
      {
        now,
        maxBytes: ACTIVITY_CACHE_MAX_BYTES,
        sizeOf: activityResultBytes,
      },
    );
    this.priceSource = options.priceSource ?? createFiatPriceSource();
    this.publicActivityFetcher =
      options.publicActivityFetcher ?? fetchPublicActivity;
  }

  async fees(
    source: LightIndexSource,
    network: NetworkName,
    outerSignal?: AbortSignal,
  ): Promise<LightFeeQuote> {
    throwIfAborted(outerSignal);
    const cached = this.feeCache.get(network);
    if (cached) return Promise.resolve({ ...cached });
    return this.feeRequests.runWithSignal(network, async (signal) => {
      throwIfAborted(signal);
      const raced = this.feeCache.get(network);
      if (raced) return raced;
      try {
        const provider = source.provider(network);
        const proxyContract = NETWORK_CONFIG[network].proxyContract;
        if (!proxyContract) {
          throw new Error("RAILGUN proxy contract is not configured.");
        }
        const [shield, unshield, nft] = await Promise.all(
          RAILGUN_FEE_SELECTORS.map((data) =>
            raceWithAbort(
              provider.call({ to: proxyContract, data }),
              signal,
            ),
          ),
        );
        const block = await raceWithAbort(
          provider.getBlockNumber().catch(() => undefined),
          signal,
        );
        const quote: LightFeeQuote = {
          network,
          shieldFee: parseFeeValue(shield, "shieldFee"),
          unshieldFee: parseFeeValue(unshield, "unshieldFee"),
          nftFee: parseFeeValue(nft, "nftFee"),
          ...(block !== undefined ? { block } : {}),
          updatedAt: Date.now(),
        };
        throwIfAborted(signal);
        this.feeCache.set(network, quote);
        return quote;
      } catch {
        throwIfAborted(signal);
        throw new LightApiError(
          503,
          "FEE_QUOTE_UNAVAILABLE",
          "The RAILGUN fee quote is temporarily unavailable.",
        );
      }
    }, outerSignal).then((quote) => ({ ...quote }));
  }

  async prices(
    network: NetworkName,
    currency: FiatCurrency,
    outerSignal?: AbortSignal,
  ): Promise<PriceSnapshot> {
    throwIfAborted(outerSignal);
    const cacheKey = `${network}:${currency}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    return this.priceRequests.runWithSignal(cacheKey, async (signal) => {
      throwIfAborted(signal);
      const raced = this.priceCache.get(cacheKey);
      if (raced) return raced;
      const now = Date.now();
      const addresses = [
        "0x0000000000000000000000000000000000000000",
        ...networkFor(network).tokens.map((token) => token.address),
      ];
      try {
        const sourcePrices = await this.priceSource(
          network.toLowerCase(),
          currency,
          addresses,
          { signal },
        );
        const allowed = new Set(
          addresses.map((address) => address.toLowerCase()),
        );
        const prices = Object.fromEntries(
          Object.entries(sourcePrices)
            .filter(
              ([address, price]) =>
                allowed.has(address.toLowerCase()) &&
                typeof price === "number" &&
                Number.isFinite(price) &&
                price > 0,
            )
            .map(([address, price]) => [address.toLowerCase(), price]),
        );
        if (Object.keys(prices).length === 0) {
          throw new Error("No valid prices.");
        }
        throwIfAborted(signal);
        const snapshot = { prices, updatedAt: now };
        this.priceCache.set(cacheKey, snapshot);
        return snapshot;
      } catch {
        throwIfAborted(signal);
        throw new LightApiError(
          503,
          "PRICE_UNAVAILABLE",
          "Fiat prices are temporarily unavailable.",
        );
      }
    }, outerSignal);
  }

  async anchor(
    source: LightIndexSource,
    network: NetworkName,
    txidVersion: TXIDVersion,
    treeNumber: number,
    leaves: number,
    localRoot: string,
    checkedRoot: string,
    outerSignal?: AbortSignal,
  ): Promise<LightAnchorCheck> {
    throwIfAborted(outerSignal);
    const cacheKey =
      `${network}:${txidVersion}:${treeNumber}:${leaves}:${localRoot}:${checkedRoot}`;
    const cached = this.anchorCache.get(cacheKey);
    if (cached) return Promise.resolve({ ...cached });
    return this.anchorRequests.runWithSignal(cacheKey, async (signal) => {
      throwIfAborted(signal);
      const raced = this.anchorCache.get(cacheKey);
      if (raced) return raced;

      const contract = txidVersion === TXIDVersion.V2_PoseidonMerkle
        ? NETWORK_CONFIG[network].proxyContract
        : NETWORK_CONFIG[network].poseidonMerkleAccumulatorV3Contract;
      const rootFunction = txidVersion === TXIDVersion.V2_PoseidonMerkle
        ? "merkleRoot"
        : "accumulatorRoot";
      if (!contract) {
        throw new LightApiError(
          503,
          "ANCHOR_UNAVAILABLE",
          "The RAILGUN anchor check is temporarily unavailable.",
        );
      }

      let anchored: boolean;
      let chainRoot: string;
      let block: number;
      try {
        const provider = source.provider(network);
        const [historyResult, chainRootResult, chainBlock] =
          await Promise.all([
            raceWithAbort(
              provider.call({
                to: contract,
                data: ANCHOR_ABI.encodeFunctionData("rootHistory", [
                  BigInt(treeNumber),
                  `0x${checkedRoot}`,
                ]),
              }),
              signal,
            ),
            raceWithAbort(
              provider.call({
                to: contract,
                data: rootFunction === "merkleRoot"
                  ? MERKLE_ROOT_DATA
                  : ACCUMULATOR_ROOT_DATA,
              }),
              signal,
            ),
            raceWithAbort(provider.getBlockNumber(), signal),
          ]);
        anchored = Boolean(
          ANCHOR_ABI.decodeFunctionResult("rootHistory", historyResult)[0],
        );
        chainRoot = normalizeRoot(
          ANCHOR_ABI.decodeFunctionResult(rootFunction, chainRootResult)[0],
        );
        if (!Number.isSafeInteger(chainBlock) || chainBlock < 0) {
          throw new Error("Chain block number is invalid.");
        }
        block = chainBlock;
      } catch {
        throwIfAborted(signal);
        throw new LightApiError(
          503,
          "ANCHOR_UNAVAILABLE",
          "The RAILGUN anchor check is temporarily unavailable.",
        );
      }

      const check: LightAnchorCheck = {
        network,
        txidVersion,
        tree: treeNumber,
        leaves,
        localRoot,
        root: checkedRoot,
        anchored,
        chainRoot,
        block,
        checkedAt: Date.now(),
      };
      throwIfAborted(signal);
      this.anchorCache.set(cacheKey, check);
      return check;
    }, outerSignal).then((check) => ({ ...check }));
  }

  async activity(
    network: NetworkName,
    address: string,
    outerSignal?: AbortSignal,
  ): Promise<PublicActivityResult> {
    throwIfAborted(outerSignal);
    const cacheKey = `${network}:${address}`;
    const cached = this.activityCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    return this.activityRequests.runWithSignal(cacheKey, async (signal) => {
      throwIfAborted(signal);
      const raced = this.activityCache.get(cacheKey);
      if (raced) return raced;
      let result: PublicActivityResult;
      try {
        result = await this.publicActivityFetcher(network, address, {
          signal,
        });
        if (
          !result ||
          !Array.isArray(result.items) ||
          !Array.isArray(result.warnings) ||
          typeof result.complete !== "boolean"
        ) {
          throw new Error("Public activity returned an invalid result.");
        }
      } catch {
        throwIfAborted(signal);
        log.warn(`${network} public activity lookup failed`);
        throw new LightApiError(
          503,
          "ACTIVITY_UNAVAILABLE",
          "Public activity is temporarily unavailable.",
        );
      }
      const boundedResult: PublicActivityResult = {
        ...result,
        items: result.items.slice(0, MAX_ACTIVITY_LIMIT),
      };
      this.activityCache.set(
        cacheKey,
        boundedResult,
        boundedResult.complete
          ? ACTIVITY_CACHE_MS
          : ACTIVITY_PARTIAL_CACHE_MS,
      );
      return boundedResult;
    }, outerSignal);
  }
}
