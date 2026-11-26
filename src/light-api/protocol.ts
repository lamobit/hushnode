import {
  NETWORK_CONFIG,
  TXIDVersion,
  type Chain,
  type NetworkName,
} from "@railgun-community/shared-models";
import type { IndexReadiness } from "../index-readiness.js";
import type { RemoteScanService } from "../light-scan.js";
import { NETWORKS } from "../networks.js";
import {
  MAX_PUBLIC_ACTIVITY_ITEMS,
  type PublicActivityResult,
} from "../public-activity.js";
import type { FiatPriceSource } from "../prices.js";
import type { BroadcasterRelay } from "../railgun/broadcaster-relay.js";

export const LIGHT_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_NOTES = 128;
export const MAX_NOTES = 256;
export const DEFAULT_MAX_NULLIFIERS = 512;
export const MAX_NULLIFIERS = 2_000;
export const DEFAULT_MAX_TREES = 128;
export const DEFAULT_ACTIVITY_LIMIT = 100;
export const MAX_ACTIVITY_LIMIT = MAX_PUBLIC_ACTIVITY_ITEMS;
export const ZERO_ROOT = "0".repeat(64);
export const ZERO_NULLIFIER = "0".repeat(64);
export const NULLIFIER_PATTERN = /^[0-9a-f]{64}$/;
export const RELAY_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const ROOT_PATTERN = /^[0-9a-f]{64}$/;
const EVM_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const EVM_MAX_DATA_BYTES = 16 * 1_024;
export const EVM_MAX_CALL_RESULT_BYTES = 64 * 1_024;
const EVM_MAX_UINT256 = (1n << 256n) - 1n;
const EVM_MAX_UINT256_DECIMAL_DIGITS = 78;
const EVM_MAX_UINT256_HEX_DIGITS = 64;

export type LightCommitment = {
  hash: string;
  commitmentType?: string;
  txid?: string;
  blockNumber?: number;
  timestamp?: number;
  utxoTree?: number;
  utxoIndex?: number;
  [field: string]: unknown;
};

export type LightMerkleProof = {
  leaf: string;
  elements: string[];
  indices: string;
  root: string;
};

export type BaseLightTreeSource = {
  getLatestTreeAndIndex(): Promise<{ tree: number; index: number }>;
  getTreeLength(tree: number): Promise<number>;
  getRoot(tree: number): Promise<string>;
  getCommitmentRange(
    tree: number,
    start: number,
    end: number,
  ): Promise<LightCommitment[]>;
  getMerkleProof(tree: number, leaf: number): Promise<LightMerkleProof>;
};

export type LightTreeSource = BaseLightTreeSource & {
  getNullifiers(
    tree: number,
    after: string | null,
    limit: number,
  ): Promise<string[]>;
};

export type LightBlockTag = "latest" | "pending";

export type LightFeeData = {
  baseFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  maxFeePerGas: bigint | null;
};

export type LightTransactionReceipt = {
  status: number | null;
  blockNumber: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
};

export type LightRpcProvider = {
  call(transaction: { to: string; data: string }): Promise<string>;
  getBlockNumber(): Promise<number>;
  sendRawTransaction(raw: string): Promise<string>;
  getTransactionCount(address: string, tag: LightBlockTag): Promise<number>;
  getBalance(address: string, tag: LightBlockTag): Promise<bigint>;
  feeData(): Promise<LightFeeData>;
  estimateGas(transaction: {
    from: string;
    to: string;
    data: string;
    value?: bigint;
  }): Promise<bigint>;
  getTransactionReceipt(
    hash: string,
  ): Promise<LightTransactionReceipt | null>;
};

export type LightFeeQuote = {
  network: NetworkName;
  shieldFee: string;
  unshieldFee: string;
  nftFee: string;
  block?: number;
  updatedAt: number;
};

export type LightAnchorCheck = {
  network: NetworkName;
  txidVersion: TXIDVersion;
  tree: number;
  leaves: number;
  localRoot: string;
  root: string;
  anchored: boolean;
  chainRoot: string;
  block: number;
  checkedAt: number;
};

export type LightIndexSource = {
  isRunning(): boolean;
  isNetworkLoaded(network: NetworkName): boolean;
  readiness(network: NetworkName): IndexReadiness;
  scanActivity(network: NetworkName): { utxo: boolean; txid: boolean };
  lastSyncedBlock(
    network: NetworkName,
    txidVersion: TXIDVersion,
  ): Promise<number | undefined>;
  tree(network: NetworkName, txidVersion: TXIDVersion): LightTreeSource;
  provider(network: NetworkName): LightRpcProvider;
};

export type NullifierStreamOptions = {
  gte?: string;
  gt?: string;
  lte?: string;
  limit: number;
  keys: boolean;
  values: boolean;
};

export type NullifierStream = NodeJS.ReadableStream & {
  destroy?: () => void;
};

export type RealUtxoTreeSource = BaseLightTreeSource & {
  getNullifierDBPath(tree: number, nullifier: string): string[];
  db: {
    level: {
      createReadStream(options: NullifierStreamOptions): NullifierStream;
    };
  };
};

export type ChainSyncIndexingSource = {
  isRunning(): boolean;
  isNetworkLoaded(network: NetworkName): boolean;
  readiness(network: NetworkName): IndexReadiness;
  getEngine(): {
    scanActivity(network: NetworkName): { utxo: boolean; txid: boolean };
    getUTXOMerkletree(
      txidVersion: TXIDVersion,
      chain: Chain,
    ): BaseLightTreeSource;
    lastSyncedBlock(
      network: NetworkName,
      txidVersion: TXIDVersion,
    ): Promise<number | undefined>;
    provider(network: NetworkName): ChainSyncRpcProvider;
  };
};

export type ChainSyncRpcProvider = {
  call(transaction: { to: string; data: string }): Promise<string>;
  getBlockNumber(): Promise<number>;
  broadcastTransaction(raw: string): Promise<{ hash: string }>;
  getTransactionCount(address: string, tag: LightBlockTag): Promise<number>;
  getBalance(address: string, tag: LightBlockTag): Promise<bigint>;
  getFeeData(): Promise<{
    gasPrice: bigint | null;
    maxFeePerGas: bigint | null;
    maxPriorityFeePerGas: bigint | null;
  }>;
  getBlock(tag: "latest"): Promise<{ baseFeePerGas: bigint | null } | null>;
  estimateGas(transaction: {
    from: string;
    to: string;
    data: string;
    value?: bigint;
  }): Promise<bigint>;
  getTransactionReceipt(hash: string): Promise<{
    status: number | null;
    blockNumber: number;
    gasUsed: bigint;
    gasPrice: bigint;
  } | null>;
};

export type LightApiOptions = {
  enabled: boolean;
  isNetworkReady?: (network: NetworkName) => boolean;
  source?: LightIndexSource;
  corsOrigins?: string[];
  maxTrees?: number;
  relayEnabled?: boolean;
  relayMaxBytes?: number;
  relayRatePerMinute?: number;
  evmRatePerMinute?: number;
  anchorRatePerMinute?: number;
  readRatePerMinute?: number;
  extraAllowedEvmTargets?: Partial<
    Record<NetworkName, readonly string[]>
  >;
  publicActivityFetcher?: (
    network: NetworkName,
    address: string,
  ) => Promise<PublicActivityResult>;
  scan?: RemoteScanService;
  priceSource?: FiatPriceSource;
  broadcaster?: BroadcasterRelay;
  broadcasterRatePerMinute?: number;
  broadcasterTransactRatePerMinute?: number;
};

export class LightApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LightApiError";
  }
}

export const parseNetwork = (value: unknown): NetworkName => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  const found = NETWORKS.find(
    (network) => network.id.toLowerCase() === normalized,
  );
  if (!found) {
    throw new LightApiError(
      400,
      "UNSUPPORTED_NETWORK",
      "network must be ethereum or arbitrum.",
    );
  }
  return found.id;
};

export const publicNetwork = (network: NetworkName): string =>
  network.toLowerCase();

export const parseTxidVersion = (value: unknown): TXIDVersion => {
  if (value === TXIDVersion.V2_PoseidonMerkle) {
    return TXIDVersion.V2_PoseidonMerkle;
  }
  if (value === TXIDVersion.V3_PoseidonMerkle) {
    return TXIDVersion.V3_PoseidonMerkle;
  }
  throw new LightApiError(
    400,
    "UNSUPPORTED_TXID_VERSION",
    "txidVersion must be V2_PoseidonMerkle or V3_PoseidonMerkle.",
  );
};

const normalizeHexRoot = (value: string): string | null => {
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  return ROOT_PATTERN.test(normalized) ? normalized : null;
};

export const normalizeRoot = (value: unknown): string => {
  const normalized =
    typeof value === "string" ? normalizeHexRoot(value) : null;
  if (!normalized) {
    throw new Error("Contract root is not a 32-byte hex value.");
  }
  return normalized;
};

export const parseRootParam = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "root must be a 32-byte hex string.",
    );
  }
  const normalized = normalizeHexRoot(value);
  if (!normalized) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "root must be a 32-byte hex string.",
    );
  }
  return normalized;
};

export const parseRelayTransaction = (
  value: unknown,
  maxBytes: number,
): string => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "rawTransaction must be a 0x-prefixed hex string.",
    );
  }
  const hex = value.slice(2);
  if (hex.length % 2 !== 0) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "rawTransaction must contain whole bytes.",
    );
  }
  const byteLength = hex.length / 2;
  if (byteLength < 1 || byteLength > maxBytes) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      `rawTransaction must be between 1 and ${maxBytes} bytes.`,
    );
  }
  const firstByte = Number.parseInt(hex.slice(0, 2), 16);
  if (
    firstByte !== 0x01 &&
    firstByte !== 0x02 &&
    firstByte !== 0x03 &&
    firstByte !== 0x04 &&
    firstByte < 0xc0
  ) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "rawTransaction must be a typed (0x01-0x04) or legacy (>=0xc0) transaction.",
    );
  }
  return value;
};

export const parseEvmAddress = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !EVM_ADDRESS_PATTERN.test(value)) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      `${name} must be a 0x-prefixed 20-byte address.`,
    );
  }
  return value.toLowerCase();
};

export const parseEvmData = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]*$/.test(value) ||
    value.length % 2 !== 0
  ) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "data must be 0x-prefixed, even-length hex.",
    );
  }
  const byteLength = (value.length - 2) / 2;
  if (byteLength > EVM_MAX_DATA_BYTES) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      `data must not exceed ${EVM_MAX_DATA_BYTES} bytes.`,
    );
  }
  return value;
};

export const parseEvmValue = (value: unknown): bigint => {
  if (value === undefined) return 0n;
  if (typeof value !== "string") {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "value must be a decimal or 0x-prefixed hex string.",
    );
  }
  const raw = value.trim();
  const hex = raw.startsWith("0x");
  const maxLength = hex
    ? EVM_MAX_UINT256_HEX_DIGITS + 2
    : EVM_MAX_UINT256_DECIMAL_DIGITS;
  if (raw.length > maxLength) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "value must be an unsigned 256-bit integer.",
    );
  }
  const parsed =
    /^\d+$/.test(raw) || /^0x[0-9a-fA-F]+$/.test(raw)
      ? BigInt(raw)
      : null;
  if (parsed === null || parsed < 0n || parsed > EVM_MAX_UINT256) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "value must be an unsigned 256-bit integer.",
    );
  }
  return parsed;
};

export const parseEvmHash = (value: unknown): string => {
  if (typeof value !== "string" || !EVM_HASH_PATTERN.test(value)) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "hash must be a 0x-prefixed 32-byte transaction hash.",
    );
  }
  return value;
};

export const parseEvmBody = (
  value: unknown,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "Request body must be a JSON object.",
    );
  }
  return value as Record<string, unknown>;
};

export const allowedEvmTargets = (
  extraTargets: Partial<Record<NetworkName, readonly string[]>> = {},
): Map<NetworkName, ReadonlySet<string>> => {
  const byNetwork = new Map<NetworkName, Set<string>>();
  for (const definition of NETWORKS) {
    const networkConfig = NETWORK_CONFIG[definition.id];
    const targets = new Set(
      [
        networkConfig.proxyContract,
        networkConfig.relayAdaptContract,
        networkConfig.poseidonMerkleAccumulatorV3Contract,
        networkConfig.poseidonMerkleVerifierV3Contract,
        networkConfig.tokenVaultV3Contract,
        definition.wrappedAddress,
        ...definition.tokens.map((token) => token.address),
      ]
        .filter((target): target is string => Boolean(target))
        .map((target) => target.toLowerCase()),
    );
    byNetwork.set(definition.id, targets);
  }

  for (const [network, targets] of Object.entries(extraTargets)) {
    const configured = byNetwork.get(network as NetworkName);
    if (!configured) {
      throw new Error(
        `extraAllowedEvmTargets contains unsupported network "${network}".`,
      );
    }
    for (const target of targets ?? []) {
      if (!EVM_ADDRESS_PATTERN.test(target)) {
        throw new Error(
          `Invalid extra EVM target "${target}" for ${network}.`,
        );
      }
      configured.add(target.toLowerCase());
    }
  }
  return byNetwork;
};

export const requireAllowedEvmTarget = (
  allowedTargets: ReadonlyMap<NetworkName, ReadonlySet<string>>,
  network: NetworkName,
  target: string,
): void => {
  if (!allowedTargets.get(network)?.has(target)) {
    throw new LightApiError(
      403,
      "TARGET_NOT_ALLOWED",
      "The target contract is not allowlisted.",
    );
  }
};

export const blockNumberString = (value: number): string => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("RPC returned an invalid block number.");
  }
  return value.toString(10);
};

export const nonceString = (value: number): string => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("RPC returned an invalid transaction count.");
  }
  return value.toString(10);
};

export const uintString = (value: bigint): string => {
  if (value < 0n || value > EVM_MAX_UINT256) {
    throw new Error("RPC returned an invalid unsigned integer.");
  }
  return value.toString(10);
};

export const optionalUintString = (value: bigint | null): string | null =>
  value === null ? null : uintString(value);

export const parseEvmCallResult = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]*$/.test(value) ||
    value.length % 2 !== 0
  ) {
    throw new Error("RPC returned invalid call data.");
  }
  const byteLength = (value.length - 2) / 2;
  if (byteLength > EVM_MAX_CALL_RESULT_BYTES) {
    throw new Error("RPC returned oversized call data.");
  }
  return value;
};

export const parseIntParam = (
  value: unknown,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(raw)) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      `${name} must be a non-negative integer.`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      `${name} is out of range.`,
    );
  }
  return parsed;
};

export const parseLimitParam = (
  value: unknown,
  fallback: number,
  max: number,
): number => {
  const limit = parseIntParam(value ?? String(fallback), "limit", max);
  if (limit < 1) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "limit must be at least 1.",
    );
  }
  return limit;
};

export const parseNullifierCursor = (value: unknown): string | null => {
  if (value === undefined) return null;
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!NULLIFIER_PATTERN.test(normalized)) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "after must be a 32-byte hex nullifier.",
    );
  }
  return normalized;
};

export const parseFeeValue = (value: unknown, name: string): string => {
  if (
    typeof value !== "string" ||
    value.length > EVM_MAX_UINT256_HEX_DIGITS + 2 ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error(`${name} returned invalid contract data.`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new Error(`${name} returned a negative fee.`);
  }
  return parsed.toString(10);
};
