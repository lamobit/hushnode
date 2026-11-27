import { randomBytes } from "node:crypto";
import {
  EVMGasType,
  NETWORK_CONFIG,
  TXIDVersion,
  getEVMGasTypeForTransaction,
  type NetworkName,
  type PreTransactionPOI,
  type PreTransactionPOIsPerTxidLeafPerList,
  type TransactionGasDetails,
} from "@railgun-community/shared-models";
import { calculateBroadcasterFeeERC20Amount } from "@railgun-community/wallet";
import type { LightRpcProvider } from "../light-api/protocol.js";
import { createLogger } from "../logger.js";
import { chainFor, networkFor } from "../networks.js";
import {
  BroadcasterTransportError,
  type BroadcasterNetwork,
} from "./broadcasters.js";

const log = createLogger("broadcaster-relay");

const QUOTE_TTL_MS = 90_000;
const MAX_FEE_BPS = 1_000n;
const MAX_QUOTES = 512;
const MAX_DECIMAL_UINT256_DIGITS = 78;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_POI_LISTS = 8;
const MAX_POI_LEAVES = 64;
const MAX_POI_MERKLE_ROOTS = 8;
const MAX_POI_BLINDED_COMMITMENTS = 32;
const MAX_POI_STRING_LENGTH = 256;
const MAX_POI_TOTAL_BYTES = 512 * 1024;
const GAS_LIMIT_TRANSFER = 600_000n;
const GAS_LIMIT_UNSHIELD = 800_000n;
const ONE_GWEI = 1_000_000_000n;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const CALLDATA = /^0x[0-9a-f]+$/i;
const NULLIFIER = /^0x[0-9a-f]{64}$/i;
const QUOTE_ID = /^[0-9a-f]{32}$/;

export class BroadcasterRelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BroadcasterRelayError";
  }
}

export type BroadcasterQuote = {
  id: string;
  network: NetworkName;
  txidVersion: TXIDVersion;
  tokenHash: string;
  feeRecipient: string;
  fee: bigint;
  minGasPrice: bigint;
  expiresAt: number;
};

export type BroadcasterQuoteInput = {
  network: NetworkName;
  txidVersion: TXIDVersion;
  tokenHash: string;
  amount: bigint;
  unshield: boolean;
};

export type BroadcasterTransactInput = {
  network: NetworkName;
  txidVersion: TXIDVersion;
  calldata: string;
  quoteId: string;
  nullifiers: string[];
  overallBatchMinGasPrice?: bigint;
  preTransactionPOIsPerTxidLeafPerList?: PreTransactionPOIsPerTxidLeafPerList;
};

type StoredQuote = BroadcasterQuote & {
  feesID: string;
  tokenAddress: string;
  usedAt?: number;
  hash?: string;
};

type RelayDependencies = {
  broadcasters: BroadcasterNetwork;
  provider: (network: NetworkName) => LightRpcProvider;
};

const strip0x = (value: string): string => value.replace(/^0x/, "");

export const parseTokenHash = (value: unknown): string => {
  const hash =
    typeof value === "string" ? strip0x(value.trim()).toLowerCase() : "";
  if (!TOKEN_HASH.test(hash)) {
    throw new BroadcasterRelayError(
      400,
      "INVALID_TOKEN",
      "tokenHash must be a 32-byte hex string.",
    );
  }
  return hash;
};

/**
 * RAILGUN's token hash is the token address left-padded to 32 bytes, so the
 * relay can recover the address the broadcaster prices its fee in.
 */
export const tokenAddressFromHash = (hash: string): string => {
  const body = strip0x(hash).toLowerCase();
  if (!/^0{24}[0-9a-f]{40}$/.test(body)) {
    throw new BroadcasterRelayError(
      400,
      "UNSUPPORTED_TOKEN",
      "Only fungible token hashes are supported.",
    );
  }
  return `0x${body.slice(24)}`;
};

export const parseAmount = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new BroadcasterRelayError(
      400,
      "INVALID_AMOUNT",
      "amount must be a decimal string.",
    );
  }
  const digits = value.replace(/^0+/, "") || "0";
  if (digits.length > MAX_DECIMAL_UINT256_DIGITS) {
    throw new BroadcasterRelayError(
      400,
      "INVALID_AMOUNT",
      "amount must be an unsigned 256-bit decimal string.",
    );
  }
  const amount = BigInt(digits);
  if (amount <= 0n || amount > MAX_UINT256) {
    throw new BroadcasterRelayError(
      400,
      "INVALID_AMOUNT",
      "amount must be a positive unsigned 256-bit decimal string.",
    );
  }
  return amount;
};

export const parseCalldata = (value: unknown): string => {
  if (typeof value !== "string" || !CALLDATA.test(value)) {
    throw new BroadcasterRelayError(
      400,
      "INVALID_CALLDATA",
      "calldata must be a hex string.",
    );
  }
  if (value.length > 400_000) {
    throw new BroadcasterRelayError(
      413,
      "CALLDATA_TOO_LARGE",
      "calldata is too large.",
    );
  }
  return value;
};

export const parseNullifiers = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new BroadcasterRelayError(
      400,
      "INVALID_NULLIFIERS",
      "nullifiers must contain between 1 and 16 entries.",
    );
  }
  return value.map((item) => {
    if (typeof item !== "string" || !NULLIFIER.test(item)) {
      throw new BroadcasterRelayError(
        400,
        "INVALID_NULLIFIERS",
        "Each nullifier must be a 32-byte hex string.",
      );
    }
    return item.toLowerCase();
  });
};

export const parseQuoteId = (value: unknown): string => {
  const id = typeof value === "string" ? value.trim() : "";
  if (!QUOTE_ID.test(id)) {
    throw new BroadcasterRelayError(
      400,
      "INVALID_QUOTE",
      "The quote id is invalid.",
    );
  }
  return id;
};

const invalidPoi = (message: string): BroadcasterRelayError =>
  new BroadcasterRelayError(
    400,
    "INVALID_PRE_TRANSACTION_POIS",
    message,
  );

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHexKey = (value: string): boolean =>
  /^[0-9a-f]{64}$/i.test(value.replace(/^0x/i, ""));

const poiString = (
  value: unknown,
  name: string,
  allowEmpty = false,
): string => {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_POI_STRING_LENGTH
  ) {
    throw invalidPoi(`${name} must be a bounded string.`);
  }
  return value;
};

const poiStringArray = (
  value: unknown,
  maxItems: number,
  name: string,
): string[] => {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw invalidPoi(`${name} must contain at most ${maxItems} entries.`);
  }
  return value.map((entry) => poiString(entry, name));
};

const poiProofPair = (
  value: unknown,
  name: string,
): [string, string] => {
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidPoi(`${name} must contain two coordinates.`);
  }
  return [poiString(value[0], name), poiString(value[1], name)];
};

const poiProof = (value: unknown): PreTransactionPOI["snarkProof"] => {
  if (!isPlainRecord(value)) {
    throw invalidPoi("snarkProof must be an object.");
  }
  const piB = value.pi_b;
  if (!Array.isArray(piB) || piB.length !== 2) {
    throw invalidPoi("snarkProof.pi_b must contain two rows.");
  }
  return {
    pi_a: poiProofPair(value.pi_a, "snarkProof.pi_a"),
    pi_b: [
      poiProofPair(piB[0], "snarkProof.pi_b"),
      poiProofPair(piB[1], "snarkProof.pi_b"),
    ],
    pi_c: poiProofPair(value.pi_c, "snarkProof.pi_c"),
  };
};

const parsePoi = (value: unknown): PreTransactionPOI => {
  if (!isPlainRecord(value)) {
    throw invalidPoi("Each pre-transaction POI must be an object.");
  }
  return {
    snarkProof: poiProof(value.snarkProof),
    txidMerkleroot: poiString(value.txidMerkleroot, "txidMerkleroot"),
    poiMerkleroots: poiStringArray(
      value.poiMerkleroots,
      MAX_POI_MERKLE_ROOTS,
      "poiMerkleroots",
    ),
    blindedCommitmentsOut: poiStringArray(
      value.blindedCommitmentsOut,
      MAX_POI_BLINDED_COMMITMENTS,
      "blindedCommitmentsOut",
    ),
    railgunTxidIfHasUnshield: poiString(
      value.railgunTxidIfHasUnshield,
      "railgunTxidIfHasUnshield",
      true,
    ),
  };
};

export const parsePreTransactionPOIs = (
  value: unknown,
): PreTransactionPOIsPerTxidLeafPerList => {
  if (!isPlainRecord(value)) {
    throw invalidPoi("preTransactionPOIs must be an object.");
  }
  const lists = Object.entries(value);
  if (lists.length > MAX_POI_LISTS) {
    throw invalidPoi(
      `preTransactionPOIs must contain at most ${MAX_POI_LISTS} lists.`,
    );
  }
  let leaves = 0;
  const parsed: Record<string, Record<string, PreTransactionPOI>> = {};
  for (const [listKey, leafMap] of lists) {
    if (!isHexKey(listKey)) {
      throw invalidPoi(
        "preTransactionPOIs list keys must be 32-byte hex strings.",
      );
    }
    if (!isPlainRecord(leafMap)) {
      throw invalidPoi("Each preTransactionPOIs list must be an object.");
    }
    const entries = Object.entries(leafMap);
    leaves += entries.length;
    if (leaves > MAX_POI_LEAVES) {
      throw invalidPoi(
        `preTransactionPOIs must contain at most ${MAX_POI_LEAVES} leaves.`,
      );
    }
    const parsedLeaves: Record<string, PreTransactionPOI> = {};
    for (const [leafKey, poi] of entries) {
      if (!isHexKey(leafKey)) {
        throw invalidPoi(
          "preTransactionPOIs leaf keys must be 32-byte hex strings.",
        );
      }
      parsedLeaves[leafKey] = parsePoi(poi);
    }
    parsed[listKey] = parsedLeaves;
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed), "utf8") >
    MAX_POI_TOTAL_BYTES
  ) {
    throw invalidPoi("preTransactionPOIs is too large.");
  }
  return parsed;
};

export class BroadcasterRelay {
  private readonly quotes = new Map<string, StoredQuote>();

  constructor(private readonly deps: RelayDependencies) {}

  async quote(input: BroadcasterQuoteInput): Promise<BroadcasterQuote> {
    const chain = chainFor(networkFor(input.network));
    const tokenAddress = tokenAddressFromHash(input.tokenHash);
    try {
      await this.deps.broadcasters.ensureChain(chain);
    } catch (error) {
      throw this.unavailable(error, "chain setup");
    }
    const broadcaster = this.deps.broadcasters.bestForToken(
      chain,
      tokenAddress,
    );
    if (!broadcaster) {
      throw new BroadcasterRelayError(
        503,
        "BROADCASTER_UNAVAILABLE",
        "No trusted broadcaster is available for this token.",
      );
    }
    const feeData = await this.deps.provider(input.network).feeData();
    const details = gasDetails(
      input.network,
      feeData,
      input.unshield ? GAS_LIMIT_UNSHIELD : GAS_LIMIT_TRANSFER,
    );
    const calculated = await calculateBroadcasterFeeERC20Amount(
      {
        tokenAddress: broadcaster.tokenAddress,
        feePerUnitGas: BigInt(broadcaster.tokenFee.feePerUnitGas),
      },
      details,
    );
    const fee = calculated.amount;
    if (fee <= 0n || fee * 10_000n > input.amount * MAX_FEE_BPS) {
      throw new BroadcasterRelayError(
        503,
        "BROADCASTER_FEE_TOO_HIGH",
        "The broadcaster fee is outside the allowed range.",
      );
    }
    const now = Date.now();
    this.prune(now);
    const stored: StoredQuote = {
      id: randomBytes(16).toString("hex"),
      network: input.network,
      txidVersion: input.txidVersion,
      tokenHash: input.tokenHash,
      feeRecipient: broadcaster.railgunAddress,
      fee,
      minGasPrice: gasPrice(feeData),
      expiresAt: now + QUOTE_TTL_MS,
      feesID: broadcaster.tokenFee.feesID,
      tokenAddress,
    };
    this.quotes.set(stored.id, stored);
    log.info(
      `quoted ${stored.id.slice(0, 8)} on ${input.network} fee=${fee.toString()}`,
    );
    return publicQuote(stored);
  }

  async transact(
    input: BroadcasterTransactInput,
  ): Promise<{ hash: string }> {
    const now = Date.now();
    this.prune(now);
    const stored = this.quotes.get(input.quoteId);
    if (!stored) {
      throw new BroadcasterRelayError(
        404,
        "QUOTE_NOT_FOUND",
        "The quote is unknown or has expired.",
      );
    }
    if (stored.expiresAt <= now) {
      this.quotes.delete(stored.id);
      throw new BroadcasterRelayError(
        410,
        "QUOTE_EXPIRED",
        "The quote has expired; request a new one.",
      );
    }
    if (stored.hash) return { hash: stored.hash };
    if (stored.usedAt) {
      throw new BroadcasterRelayError(
        409,
        "QUOTE_IN_FLIGHT",
        "This quote is already being submitted.",
      );
    }
    if (
      input.network !== stored.network ||
      input.txidVersion !== stored.txidVersion
    ) {
      throw new BroadcasterRelayError(
        409,
        "QUOTE_MISMATCH",
        "The quote does not match this network.",
      );
    }
    if (
      input.overallBatchMinGasPrice !== undefined &&
      input.overallBatchMinGasPrice !== stored.minGasPrice
    ) {
      throw new BroadcasterRelayError(
        409,
        "QUOTE_MISMATCH",
        "The quote's gas price has changed.",
      );
    }

    const chain = chainFor(networkFor(stored.network));
    try {
      await this.deps.broadcasters.ensureChain(chain);
    } catch (error) {
      throw this.unavailable(error, "chain setup");
    }
    const current = this.deps.broadcasters.bestForToken(
      chain,
      stored.tokenAddress,
    );
    if (
      !current ||
      current.tokenFee.feesID !== stored.feesID ||
      current.railgunAddress !== stored.feeRecipient
    ) {
      throw new BroadcasterRelayError(
        409,
        "QUOTE_STALE",
        "The broadcaster changed; request a new quote.",
      );
    }

    stored.usedAt = now;
    try {
      const hash = await this.deps.broadcasters.submit({
        txidVersion: stored.txidVersion,
        to: NETWORK_CONFIG[stored.network].proxyContract,
        data: input.calldata,
        broadcasterRailgunAddress: stored.feeRecipient,
        feesID: stored.feesID,
        chain,
        nullifiers: input.nullifiers,
        overallBatchMinGasPrice: stored.minGasPrice,
        preTransactionPOIsPerTxidLeafPerList:
          input.preTransactionPOIsPerTxidLeafPerList ?? {},
      });
      if (!/^0x[0-9a-f]{64}$/i.test(hash)) {
        throw new Error("The broadcaster returned an invalid transaction hash.");
      }
      stored.hash = hash;
      log.info(`submitted ${stored.id.slice(0, 8)} as ${hash}`);
      return { hash };
    } catch (error) {
      stored.usedAt = undefined;
      if (error instanceof BroadcasterRelayError) throw error;
      if (error instanceof BroadcasterTransportError) {
        log.warn(
          `broadcast transport failed for ${stored.id.slice(0, 8)}`,
          error,
        );
        throw new BroadcasterRelayError(
          503,
          "BROADCASTER_UNAVAILABLE",
          "The broadcaster network is temporarily unavailable.",
        );
      }
      log.error(`broadcast failed for ${stored.id.slice(0, 8)}`, error);
      throw new BroadcasterRelayError(
        502,
        "BROADCASTER_FAILED",
        "The broadcaster rejected the transaction.",
      );
    }
  }

  async stop(): Promise<void> {
    this.quotes.clear();
    await this.deps.broadcasters.stop();
  }

  private prune(now: number): void {
    for (const [id, quote] of this.quotes) {
      if (quote.expiresAt + 5 * 60_000 <= now) this.quotes.delete(id);
    }
    while (this.quotes.size > MAX_QUOTES) {
      const oldest = this.quotes.keys().next().value;
      if (oldest === undefined) break;
      this.quotes.delete(oldest);
    }
  }

  private unavailable(
    error: unknown,
    operation: string,
  ): BroadcasterRelayError {
    if (error instanceof BroadcasterRelayError) return error;
    log.warn(`broadcaster ${operation} failed`, error);
    return new BroadcasterRelayError(
      503,
      "BROADCASTER_UNAVAILABLE",
      "The broadcaster network is temporarily unavailable.",
    );
  }
}

const gasPrice = (feeData: {
  baseFeePerGas: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
}): bigint => {
  if (feeData.maxFeePerGas !== null) return feeData.maxFeePerGas;
  if (feeData.baseFeePerGas !== null) {
    const priority = feeData.maxPriorityFeePerGas ?? ONE_GWEI / 10n;
    return feeData.baseFeePerGas * 2n + priority;
  }
  return ONE_GWEI;
};

const gasDetails = (
  network: NetworkName,
  feeData: {
    baseFeePerGas: bigint | null;
    maxFeePerGas: bigint | null;
    maxPriorityFeePerGas: bigint | null;
  },
  gasEstimate: bigint,
): TransactionGasDetails => {
  const evmGasType = getEVMGasTypeForTransaction(network, false);
  const price = gasPrice(feeData);
  const maxPriorityFeePerGas =
    feeData.maxPriorityFeePerGas ?? (price * 25n) / 100n;
  if (
    evmGasType === EVMGasType.Type2 ||
    evmGasType === EVMGasType.Type4
  ) {
    return {
      evmGasType,
      gasEstimate,
      maxFeePerGas: price,
      maxPriorityFeePerGas,
    } as TransactionGasDetails;
  }
  return {
    evmGasType,
    gasEstimate,
    gasPrice: price,
  } as TransactionGasDetails;
};

const publicQuote = (quote: StoredQuote): BroadcasterQuote => ({
  id: quote.id,
  network: quote.network,
  txidVersion: quote.txidVersion,
  tokenHash: quote.tokenHash,
  feeRecipient: quote.feeRecipient,
  fee: quote.fee,
  minGasPrice: quote.minGasPrice,
  expiresAt: quote.expiresAt,
});
