import { randomBytes } from "node:crypto";
import {
  EVMGasType,
  NETWORK_CONFIG,
  TXIDVersion,
  getEVMGasTypeForTransaction,
  type Chain,
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
  type BroadcasterSubmission,
  type BroadcasterNetwork,
} from "./broadcasters.js";

const log = createLogger("broadcaster-relay");

/**
 * A quote only freezes the broadcaster's fee terms, which are re-verified at
 * submission time, so it can stay usable across on-device proving and a slow
 * review. Quotes are dropped once they are this old (plus a grace period).
 */
const QUOTE_TTL_MS = 15 * 60_000;
const BROADCASTER_WAIT_MS = 5_000;
const SUBMIT_BROADCASTER_WAIT_MS = 60_000;
const BROADCASTER_POLL_MS = 250;
const RECONNECT_AFTER_MS = 8_000;
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
/**
 * A phone spends a minute or more proving, and the broadcaster reprices its
 * fee whenever gas moves. The proof can only pay the fee it committed to, so a
 * live fee that drifted up by a fraction of a percent must not throw away a
 * finished proof; only a real jump means the quote is stale.
 */
const FEE_DRIFT_BPS = 200n;
const BPS_DENOMINATOR = 10_000n;
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
  /**
   * The full quote the caller proved against. Used when the in-memory quote
   * record is gone (process restart, eviction) so a paid-for proof is not
   * discarded just because this instance never saw the quote request.
   */
  quote?: BroadcasterQuoteTerms;
  nullifiers: string[];
  overallBatchMinGasPrice?: bigint;
  preTransactionPOIsPerTxidLeafPerList?: PreTransactionPOIsPerTxidLeafPerList;
};

export type BroadcasterQuoteTerms = {
  tokenHash: string;
  feeRecipient: string;
  fee: bigint;
  minGasPrice: bigint;
  expiresAt: number;
};

export type BroadcasterTransactStatus =
  | { id: string; status: "pending" }
  | { id: string; status: "submitted"; hash: string }
  | { id: string; status: "failed"; code: string; message: string };

type TransactJob = {
  status: "pending" | "submitted" | "failed";
  startedAt: number;
  httpStatus?: number;
  hash?: string;
  code?: string;
  message?: string;
  promise?: Promise<void>;
};

type StoredQuote = BroadcasterQuote & {
  feesID: string;
  tokenAddress: string;
  feePerUnitGas: bigint;
  issuedAt: number;
  /** Missing for quotes recovered from caller terms, which cannot be re-priced. */
  gasDetails?: TransactionGasDetails;
  usedAt?: number;
  hash?: string;
  transact?: TransactJob;
};

type BroadcasterLookup = ReturnType<BroadcasterNetwork["bestForToken"]>;

type RelayBroadcasters = {
  ensureChain: (chain: Chain) => Promise<void>;
  bestForToken: (chain: Chain, tokenAddress: string) => BroadcasterLookup;
  broadcasterFor?: (
    chain: Chain,
    tokenAddress: string,
    railgunAddress: string,
  ) => BroadcasterLookup;
  reconnect?: (chain: Chain) => Promise<void>;
  submit: (request: BroadcasterSubmission) => Promise<string>;
  stop: () => Promise<void>;
};

type RelayDependencies = {
  broadcasters: RelayBroadcasters;
  provider: (network: NetworkName) => LightRpcProvider;
  /** Overridable wait budgets; defaults match the production relay. */
  timings?: {
    quoteWaitMs?: number;
    submitWaitMs?: number;
    replacedAfterMs?: number;
  };
};

const quoteWait = (deps: RelayDependencies): number =>
  deps.timings?.quoteWaitMs ?? BROADCASTER_WAIT_MS;
const submitWait = (deps: RelayDependencies): number =>
  deps.timings?.submitWaitMs ?? SUBMIT_BROADCASTER_WAIT_MS;
const replacedAfter = (deps: RelayDependencies): number =>
  deps.timings?.replacedAfterMs ?? 10_000;

const strip0x = (value: string): string => value.replace(/^0x/, "");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Broadcasters answer a rejected transaction with a short reason ("Fees
 * expired", "Invalid POI", ...). Keeping it in the failure message is the only
 * way to tell a stale quote apart from a malformed submission after the fact.
 */
const rejectionReason = (error: unknown): string => {
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : "";
  const reason = cause.replace(/\s+/g, " ").trim().slice(0, 160);
  return reason ? `: ${reason}` : "";
};

const REVERT_SIGNAL = /execution reverted|CALL_EXCEPTION|reverted with reason/i;
const REVERT_REASON =
  /reverted with reason string '([^']+)'|execution reverted[:\s]+(.+)/i;

const tidy = (value: string): string =>
  value.replace(/\s+/g, " ").trim().replace(/^[:\s]+/, "").slice(0, 160);

/**
 * Pulls a human readable revert reason out of an RPC error. Providers nest the
 * same failure under `message`, `shortMessage`, `info.error` or `data`, so walk
 * the usual spots instead of trusting a single field.
 */
const revertDetail = (error: unknown): string | undefined => {
  const seen = new Set<unknown>();
  const texts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || seen.has(value)) return;
    if (typeof value === "string") {
      texts.push(value);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    seen.add(value);
    for (const key of [
      "message",
      "shortMessage",
      "reason",
      "code",
      "error",
      "info",
      "data",
      "body",
    ]) {
      visit((value as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(error, 0);
  if (!texts.some((text) => REVERT_SIGNAL.test(text))) return undefined;
  const reason =
    typeof (error as { reason?: unknown }).reason === "string"
      ? (error as { reason: string }).reason
      : "";
  if (tidy(reason)) return tidy(reason);
  for (const text of texts) {
    const match = REVERT_REASON.exec(text);
    const detail = tidy(match?.[1] ?? match?.[2] ?? "");
    if (detail) return detail;
  }
  return "execution reverted";
};

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

const RAILGUN_ADDRESS = /^0zk1[0-9a-z]{20,300}$/;

const parseQuoteField = <T>(
  value: unknown,
  parse: (input: unknown) => T,
): T | undefined => {
  try {
    return parse(value);
  } catch {
    return undefined;
  }
};

/**
 * Parses the quote terms echoed by the caller. They are advisory: submission
 * only uses them when this instance has no record of the quote id, and the
 * broadcaster's live terms are always re-checked before relaying.
 */
export const parseQuoteTerms = (
  value: unknown,
): BroadcasterQuoteTerms | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const feeRecipient =
    typeof value.feeRecipient === "string" ? value.feeRecipient.trim() : "";
  if (!RAILGUN_ADDRESS.test(feeRecipient)) return undefined;
  const tokenHash = parseQuoteField(value.tokenHash, parseTokenHash);
  const fee = parseQuoteField(value.fee, parseAmount);
  const minGasPrice = parseQuoteField(value.minGasPrice, parseAmount);
  const expiresAt =
    typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt)
      ? value.expiresAt
      : undefined;
  if (
    tokenHash === undefined ||
    fee === undefined ||
    minGasPrice === undefined ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return { tokenHash, feeRecipient, fee, minGasPrice, expiresAt };
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
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    throw invalidPoi(`${name} must contain two coordinates.`);
  }
  return [poiString(value[0], name), poiString(value[1], name)];
};

const poiProof = (value: unknown): PreTransactionPOI["snarkProof"] => {
  if (!isPlainRecord(value)) {
    throw invalidPoi("snarkProof must be an object.");
  }
  const piB = value.pi_b;
  if (!Array.isArray(piB) || piB.length < 2 || piB.length > 3) {
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
    const broadcaster = await this.waitForBroadcaster(
      chain,
      tokenAddress,
      quoteWait(this.deps),
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
      feePerUnitGas: BigInt(broadcaster.tokenFee.feePerUnitGas),
      issuedAt: now,
      gasDetails: details,
    };
    this.quotes.set(stored.id, stored);
    log.info(
      `quoted ${stored.id.slice(0, 8)} on ${input.network} fee=${fee.toString()}`,
    );
    return publicQuote(stored);
  }

  /**
   * Starts a submission and returns immediately. Waku broadcasters can take
   * up to two minutes to answer; holding the HTTP request open for that long
   * trips reverse-proxy and client timeouts, making a successful submission
   * look like a failure.
   */
  async startTransact(
    input: BroadcasterTransactInput,
  ): Promise<BroadcasterTransactStatus> {
    const stored = this.claim(input);
    return this.begin(stored, input);
  }

  async transactStatus(
    quoteId: string,
  ): Promise<BroadcasterTransactStatus> {
    this.prune(Date.now());
    const stored = this.quotes.get(quoteId);
    if (!stored || (!stored.transact && !stored.hash)) {
      throw new BroadcasterRelayError(
        404,
        "QUOTE_NOT_FOUND",
        "The quote is unknown or this transaction was not started.",
      );
    }
    return this.statusOf(stored);
  }

  /**
   * Legacy blocking submission. New clients should use `startTransact` plus
   * `transactStatus` so mobile and proxy timeouts cannot cancel the wait.
   */
  async transact(
    input: BroadcasterTransactInput,
  ): Promise<{ hash: string }> {
    const stored = this.claim(input);
    this.begin(stored, input);
    const job = stored.transact;
    if (!job) {
      throw new BroadcasterRelayError(
        500,
        "TRANSACT_UNAVAILABLE",
        "The transaction could not be started.",
      );
    }
    if (job.status === "submitted" && job.hash) {
      return { hash: job.hash };
    }
    if (job.promise) await job.promise;
    if (job.status === "submitted" && job.hash) {
      return { hash: job.hash };
    }
    throw new BroadcasterRelayError(
      job.httpStatus ?? 502,
      job.code ?? "BROADCASTER_FAILED",
      job.message ?? "The broadcaster rejected the transaction.",
    );
  }

  private claim(input: BroadcasterTransactInput): StoredQuote {
    const now = Date.now();
    this.prune(now);
    const stored = this.quotes.get(input.quoteId) ?? this.adopt(input, now);
    if (!stored) {
      throw new BroadcasterRelayError(
        404,
        "QUOTE_NOT_FOUND",
        "The quote is unknown or has expired; request a new one.",
      );
    }
    if (stored.transact) {
      const retryable =
        stored.transact.status === "failed" &&
        stored.transact.code === "BROADCASTER_UNAVAILABLE" &&
        stored.expiresAt > now;
      if (!retryable) return stored;
      stored.transact = undefined;
      stored.usedAt = undefined;
    }
    if (stored.hash) return stored;
    if (stored.expiresAt <= now) {
      this.quotes.delete(stored.id);
      throw new BroadcasterRelayError(
        410,
        "QUOTE_EXPIRED",
        "The quote has expired; request a new one.",
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
    return stored;
  }

  /**
   * Rebuilds an unknown quote from the caller's own terms. Quotes live in
   * process memory, so a restart or a second instance would otherwise reject a
   * transaction the caller already paid proving time for. The rebuilt quote is
   * only accepted while the fee recipient still advertises this token; the
   * broadcaster itself re-checks that the calldata pays its live fee before
   * relaying, so these terms cannot be used to underpay it.
   */
  private adopt(
    input: BroadcasterTransactInput,
    now: number,
  ): StoredQuote | undefined {
    const terms = input.quote;
    if (!terms) return undefined;
    if (terms.expiresAt <= now) {
      throw new BroadcasterRelayError(
        410,
        "QUOTE_EXPIRED",
        "The quote has expired; request a new one.",
      );
    }
    const network = networkFor(input.network);
    const chain = chainFor(network);
    const tokenAddress = tokenAddressFromHash(terms.tokenHash);
    const broadcaster = this.deps.broadcasters.broadcasterFor?.(
      chain,
      tokenAddress,
      terms.feeRecipient,
    );
    if (!broadcaster) {
      throw new BroadcasterRelayError(
        409,
        "QUOTE_STALE",
        "That broadcaster is no longer quoting this token; request a new quote.",
      );
    }
    const stored: StoredQuote = {
      id: input.quoteId,
      network: input.network,
      txidVersion: input.txidVersion,
      tokenHash: terms.tokenHash,
      feeRecipient: terms.feeRecipient,
      fee: terms.fee,
      minGasPrice: terms.minGasPrice,
      expiresAt: terms.expiresAt,
      feesID: broadcaster.tokenFee.feesID,
      tokenAddress,
      feePerUnitGas: BigInt(broadcaster.tokenFee.feePerUnitGas),
      issuedAt: now,
    };
    this.quotes.set(stored.id, stored);
    log.info(
      `recovered quote ${stored.id.slice(0, 8)} on ${input.network} from caller terms`,
    );
    return stored;
  }

  private begin(
    stored: StoredQuote,
    input: BroadcasterTransactInput,
  ): BroadcasterTransactStatus {
    if (!stored.transact) {
      if (stored.hash) return this.statusOf(stored);
      const job: TransactJob = {
        status: "pending",
        startedAt: Date.now(),
      };
      stored.usedAt = job.startedAt;
      stored.transact = job;
      job.promise = this.runTransact(stored, input, job).catch((error) => {
        log.error(`broadcaster job crashed for ${stored.id.slice(0, 8)}`, error);
        job.status = "failed";
        job.httpStatus = 502;
        job.code = "BROADCASTER_FAILED";
        job.message = `The broadcaster rejected the transaction${rejectionReason(error)}.`;
      });
    }
    return this.statusOf(stored);
  }

  private async runTransact(
    stored: StoredQuote,
    input: BroadcasterTransactInput,
    job: TransactJob,
  ): Promise<void> {
    try {
      const chain = chainFor(networkFor(stored.network));
      try {
        await this.deps.broadcasters.ensureChain(chain);
      } catch (error) {
        throw this.unavailable(error, "chain setup");
      }
      const current = await this.waitForQuotedBroadcaster(
        chain,
        stored,
        submitWait(this.deps),
      );
      if (!current) {
        throw new BroadcasterRelayError(
          503,
          "BROADCASTER_UNAVAILABLE",
          "No trusted broadcaster is reachable right now; try again.",
        );
      }
      if (current.railgunAddress !== stored.feeRecipient) {
        throw new BroadcasterRelayError(
          409,
          "QUOTE_STALE",
          "The quoted broadcaster is no longer available for this token.",
        );
      }
      if (stored.gasDetails) {
        const required = await calculateBroadcasterFeeERC20Amount(
          {
            tokenAddress: current.tokenAddress,
            feePerUnitGas: BigInt(current.tokenFee.feePerUnitGas),
          },
          stored.gasDetails,
        );
        const beyondTolerance =
          required.amount * BPS_DENOMINATOR >
          stored.fee * (BPS_DENOMINATOR + FEE_DRIFT_BPS);
        if (beyondTolerance) {
          throw new BroadcasterRelayError(
            409,
            "QUOTE_STALE",
            "The broadcaster raised its fee; request a new quote.",
          );
        }
        if (required.amount > stored.fee) {
          log.info(
            `quote ${stored.id.slice(0, 8)} drifted ${(
              ((required.amount - stored.fee) * BPS_DENOMINATOR) /
              stored.fee
            ).toString()}bps within tolerance`,
          );
        }
      }
      if (current.tokenFee.feesID !== stored.feesID) {
        /*
         * Broadcasters re-publish fee messages with a new id every few
         * seconds. The fee the proof pays is unchanged, so adopt the live id
         * instead of failing a quote prepared minutes earlier.
         */
        stored.feesID = current.tokenFee.feesID;
        stored.feePerUnitGas = BigInt(current.tokenFee.feePerUnitGas);
      }
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
      job.status = "submitted";
      job.hash = hash;
      log.info(`submitted ${stored.id.slice(0, 8)} as ${hash}`);
    } catch (error) {
      stored.usedAt = undefined;
      const failure = this.submitFailure(error, stored.id);
      const diagnosis =
        failure.code === "BROADCASTER_FAILED"
          ? await this.simulate(stored, input.calldata)
          : undefined;
      log.warn(
        `submit ${stored.id.slice(0, 8)} failed as ${
          diagnosis ? "TRANSACT_REVERTED" : failure.code
        } after ${
          Math.round((Date.now() - stored.issuedAt) / 1000)
        }s`,
      );
      job.status = "failed";
      job.httpStatus = failure.status;
      job.code = diagnosis ? "TRANSACT_REVERTED" : failure.code;
      job.message = diagnosis
        ? `The transaction reverts on-chain: ${diagnosis}`
        : failure.message;
    }
  }

  /**
   * A broadcaster whose gas estimate fails only says "execution reverted",
   * which hides whether the proof, the merkle root, or an already spent
   * nullifier is at fault. Replaying the same calldata against our own RPC
   * names the reason instead of blaming the quote.
   */
  private async simulate(
    stored: StoredQuote,
    calldata: string,
  ): Promise<string | undefined> {
    try {
      await this.deps.provider(stored.network).call({
        to: NETWORK_CONFIG[stored.network].proxyContract,
        data: calldata,
      });
      return undefined;
    } catch (error) {
      const reason = revertDetail(error);
      if (!reason) {
        log.warn(`could not replay ${stored.id.slice(0, 8)}`, error);
      }
      return reason;
    }
  }

  private submitFailure(
    error: unknown,
    quoteId: string,
  ): BroadcasterRelayError {
    if (error instanceof BroadcasterRelayError) return error;
    if (error instanceof BroadcasterTransportError) {
      log.warn(`broadcast transport failed for ${quoteId.slice(0, 8)}`, error);
      return new BroadcasterRelayError(
        503,
        "BROADCASTER_UNAVAILABLE",
        "The broadcaster network is temporarily unavailable.",
      );
    }
    log.error(`broadcast failed for ${quoteId.slice(0, 8)}`, error);
    return new BroadcasterRelayError(
      502,
      "BROADCASTER_FAILED",
      `The broadcaster rejected the transaction${rejectionReason(error)}.`,
    );
  }

  private async waitForBroadcaster(
    chain: Chain,
    tokenAddress: string,
    timeoutMs: number,
  ): Promise<BroadcasterLookup> {
    const startedAt = Date.now();
    let reconnected = false;
    for (;;) {
      const broadcaster = this.deps.broadcasters.bestForToken(
        chain,
        tokenAddress,
      );
      if (broadcaster) return broadcaster;
      const waited = Date.now() - startedAt;
      if (waited >= timeoutMs) return undefined;
      if (!reconnected && waited >= 3_000) {
        reconnected = true;
        void this.deps.broadcasters.reconnect?.(chain);
      }
      await sleep(BROADCASTER_POLL_MS);
    }
  }

  /**
   * Waits for the broadcaster named by the quote instead of accepting whichever
   * broadcaster happens to be cheapest now. A proof pays a fixed fee to a fixed
   * address, so only that broadcaster can relay it.
   */
  private async waitForQuotedBroadcaster(
    chain: Chain,
    stored: StoredQuote,
    timeoutMs: number,
  ): Promise<BroadcasterLookup> {
    const find = this.deps.broadcasters.broadcasterFor
      ? () =>
          this.deps.broadcasters.broadcasterFor?.(
            chain,
            stored.tokenAddress,
            stored.feeRecipient,
          )
      : () =>
          this.deps.broadcasters.bestForToken(chain, stored.tokenAddress);
    const startedAt = Date.now();
    let otherSince: number | undefined;
    let reconnected = false;
    for (;;) {
      const quoted = find();
      if (quoted) return quoted;
      const now = Date.now();
      if (!otherSince && this.deps.broadcasters.bestForToken(chain, stored.tokenAddress)) {
        otherSince = now;
      }
      const waited = now - startedAt;
      const replaced =
        otherSince !== undefined &&
        now - otherSince >= replacedAfter(this.deps);
      if (replaced || waited >= timeoutMs) {
        return this.deps.broadcasters.bestForToken(chain, stored.tokenAddress);
      }
      if (!reconnected && waited >= RECONNECT_AFTER_MS) {
        reconnected = true;
        void this.deps.broadcasters.reconnect?.(chain);
      }
      await sleep(BROADCASTER_POLL_MS);
    }
  }

  private statusOf(stored: StoredQuote): BroadcasterTransactStatus {
    const job = stored.transact;
    if (!job) {
      if (stored.hash) {
        return { id: stored.id, status: "submitted", hash: stored.hash };
      }
      return { id: stored.id, status: "pending" };
    }
    if (job.status === "submitted" && job.hash) {
      return { id: stored.id, status: "submitted", hash: job.hash };
    }
    if (job.status === "failed") {
      return {
        id: stored.id,
        status: "failed",
        code: job.code ?? "BROADCASTER_FAILED",
        message: job.message ?? "The broadcaster rejected the transaction.",
      };
    }
    return { id: stored.id, status: "pending" };
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
