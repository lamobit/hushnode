import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  TXIDVersion,
  type NetworkName,
} from "@railgun-community/shared-models";
import { settleCleanup, settleWithin } from "./async-lifecycle.js";
import type { ChainSyncService } from "./chain-sync-service.js";
import { mapWithConcurrency } from "./concurrency.js";
import { createLogger } from "./logger.js";
import {
  chainFor,
  networkFor,
  railgunDeploymentBlock,
} from "./networks.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import {
  MAX_REMOTE_SCAN_NOTES,
  normalizeRemoteScanResult,
  remoteScanNoteLimitError,
  type RemoteScanNote,
  type RemoteScanResult,
} from "./railgun/scan-result.js";
import type { ScanCacheOptions } from "./railgun/scan-cache.js";
import { ScanWallets } from "./railgun/scan-wallets.js";

const log = createLogger("light-scan");

const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_JOBS = 1;
const MAX_QUEUED_JOBS = 8;
const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_STORED_JOBS = 32;
const DEFAULT_MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES_LIMIT = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const FAST_RESULT_TTL_MS = 10 * 60_000;
const FAST_RESULT_MAX_ENTRIES = 64;
const FAST_RESULT_MAX_BYTES = 2 * 1024 * 1024;
const FAST_RESULT_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_NOTES = 5_000;
const DEFAULT_RATE_PER_MINUTE = 6;
const RATE_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;
const MAX_ERROR_LENGTH = 300;
export const MAX_REMOTE_SCAN_TREES = 4_096;
const REMOTE_SCAN_TREE_READ_CONCURRENCY = 16;
const RAILGUN_TREE_CAPACITY = 65_536;
export const REMOTE_SCAN_STOP_TIMEOUT_MS = 5_000;

export class ScanApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScanApiError";
  }
}

export type ShareableViewingKey = {
  canonical: string;
  viewingPrivateKey: string;
  spendingPublicKey: string;
};

export type RemoteScanInput = {
  network: NetworkName;
  txidVersion: TXIDVersion;
  shareableViewingKey: string;
  fromBlock: number;
  includeSpent: boolean;
};

export type { RemoteScanNote } from "./railgun/scan-result.js";

export type RemoteScanProgress = {
  progress: number;
  stage: "queued" | "syncing" | "scanning";
};

export type RemoteScanRunner = ((
  input: RemoteScanInput,
  context: {
    signal: AbortSignal;
    onProgress: (progress: RemoteScanProgress) => void;
  },
) => Promise<RemoteScanResult>) & {
  stop?: () => Promise<void>;
  /**
   * Optional admission hint. "warm" means the wallet already has cached
   * progress and should not wait behind a cold first-time scan.
   */
  classify?: (input: RemoteScanInput) => "warm" | "cold";
};

export type RemoteScanJobView = {
  jobId: string;
  network: NetworkName;
  txidVersion: TXIDVersion;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  stage: RemoteScanProgress["stage"];
  progress: number;
  found: number;
  notes?: RemoteScanNote[];
  truncated: boolean;
  nextFromBlock: number | null;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

type JobRecord = {
  id: string;
  input: RemoteScanInput;
  lane: "warm" | "cold";
  status: RemoteScanJobView["status"];
  stage: RemoteScanProgress["stage"];
  progress: number;
  notes: RemoteScanNote[];
  resultBytes: number;
  truncated: boolean;
  nextFromBlock: number | null;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  expiresAt?: number;
  controller: AbortController;
};

type RemoteScanServiceOptions = {
  enabled: boolean;
  token: string;
  runner: RemoteScanRunner;
  maxJobs?: number;
  ttlMs?: number;
  timeoutMs?: number;
  maxNotes?: number;
  maxResultBytes?: number;
  ratePerMinute?: number;
  now?: () => number;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const walletTreeScanComplete = (
  details: {
    treeScannedHeights: number[];
    creationTree?: number | null;
  },
  treeLengths: number[],
): boolean => {
  const startTree = Math.max(0, details.creationTree ?? 0);
  return treeLengths.every(
    (length, tree) =>
      tree < startTree ||
      (details.treeScannedHeights[tree] ?? 0) >= length,
  );
};

type TreeLengthReader = {
  getTreeLength(index: number): Promise<number>;
};

export const loadRemoteScanTreeLengths = async (
  tree: TreeLengthReader,
  latestTree: number,
): Promise<number[]> => {
  if (
    !Number.isSafeInteger(latestTree) ||
    latestTree < 0 ||
    latestTree >= MAX_REMOTE_SCAN_TREES
  ) {
    throw new Error("Remote scan index returned an invalid tree pointer.");
  }
  const indexes = Array.from(
    { length: latestTree + 1 },
    (_, index) => index,
  );
  return mapWithConcurrency(
    indexes,
    REMOTE_SCAN_TREE_READ_CONCURRENCY,
    async (index) => {
      const length = await tree.getTreeLength(index);
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > RAILGUN_TREE_CAPACITY
      ) {
        throw new Error("Remote scan index returned an invalid tree length.");
      }
      return length;
    },
  );
};

const hexByte = (value: number): string =>
  value.toString(16).padStart(2, "0");

const asciiHex = (value: string): string => {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    out += hexByte(value.charCodeAt(index) & 0x7f);
  }
  return out;
};

const readMsgpackLength = (
  bytes: Buffer,
  offset: number,
  width: number,
): number => {
  if (offset + width > bytes.length) return -1;
  if (width === 2) return bytes.readUInt16BE(offset);
  if (width === 4) return bytes.readUInt32BE(offset);
  return bytes[offset] ?? -1;
};

const buildShareableKey = (
  viewingPrivateKey: string,
  spendingPublicKey: string,
): ShareableViewingKey => ({
  canonical:
    "82" +
    "a5" +
    asciiHex("vpriv") +
    "d940" +
    asciiHex(viewingPrivateKey) +
    "a4" +
    asciiHex("spub") +
    "d940" +
    asciiHex(spendingPublicKey),
  viewingPrivateKey,
  spendingPublicKey,
});

const normalizeKeyHex = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^0x/i, "").toLowerCase();
  return HEX_32.test(normalized) ? normalized : null;
};

/**
 * Some clients share the key as text instead of msgpack hex: a JSON object or
 * a `vpriv=...&spub=...`-style pair. Accept those shapes too, but only when
 * both halves are exactly 32 bytes.
 */
const parseTextualShareableViewingKey = (
  text: string,
): ShareableViewingKey | null => {
  const pair = (viewing: unknown, spending: unknown) => {
    const viewingPrivateKey = normalizeKeyHex(viewing);
    const spendingPublicKey = normalizeKeyHex(spending);
    if (!viewingPrivateKey || !spendingPublicKey) return null;
    return buildShareableKey(viewingPrivateKey, spendingPublicKey);
  };
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const found = pair(record.vpriv, record.spub);
        if (found) return found;
      }
    } catch {
      // Fall through to the labelled pair parser.
    }
  }
  const read = (label: string): string | undefined => {
    const match = new RegExp(
      `${label}\\s*[=:]\\s*"?((?:0x)?[0-9a-fA-F]{64})`,
    ).exec(text);
    return match?.[1];
  };
  return pair(read("vpriv"), read("spub"));
};

/**
 * Reads a msgpack string or binary scalar and returns its hex/text payload.
 *
 * `msgpack-lite` (used by the RAILGUN SDK) emits 64-character hex strings as
 * str8 (`0xd9`). Other clients may hand us the same key with bin8 (`0xc4`) or
 * wider length prefixes, so accept every standard string/binary marker and
 * canonicalize later.
 */
const readMsgpackString = (
  bytes: Buffer,
  state: { offset: number },
): string => {
  const offset = state.offset;
  const marker = bytes[offset];
  if (marker === undefined) {
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      "The shareable viewing key is truncated.",
    );
  }
  let length: number;
  let start: number;
  let binary = false;
  if (marker >= 0xa0 && marker <= 0xbf) {
    length = marker & 0x1f;
    start = offset + 1;
  } else if (marker === 0xd9 || marker === 0xc4) {
    length = readMsgpackLength(bytes, offset + 1, 1);
    start = offset + 2;
    binary = marker === 0xc4;
  } else if (marker === 0xda || marker === 0xc5) {
    length = readMsgpackLength(bytes, offset + 1, 2);
    start = offset + 3;
    binary = marker === 0xc5;
  } else if (marker === 0xdb || marker === 0xc6) {
    length = readMsgpackLength(bytes, offset + 1, 4);
    start = offset + 5;
    binary = marker === 0xc6;
  } else {
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      `The shareable viewing key has an unsupported msgpack marker at byte ${offset}.`,
    );
  }
  if (length < 0 || start + length > bytes.length) {
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      "The shareable viewing key is truncated.",
    );
  }
  state.offset = start + length;
  const payload = bytes.subarray(start, start + length);
  return binary ? payload.toString("hex") : payload.toString("utf8");
};

const parseMsgpackShareableViewingKey = (
  bytes: Buffer,
): ShareableViewingKey => {
  const state = { offset: 0 };
  if (bytes[state.offset] !== 0x82) {
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      "shareableViewingKey must contain exactly vpriv and spub.",
    );
  }
  state.offset += 1;
  const entries = new Map<string, string>();
  for (let index = 0; index < 2; index += 1) {
    const key = readMsgpackString(bytes, state);
    const entry = readMsgpackString(bytes, state);
    if (entries.has(key)) {
      throw new ScanApiError(
        400,
        "INVALID_SHAREABLE_VIEWING_KEY",
        "shareableViewingKey contains a duplicate entry.",
      );
    }
    entries.set(key, entry);
  }
  if (state.offset !== bytes.length) {
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      "shareableViewingKey has trailing data.",
    );
  }
  const viewingPrivateKey = entries
    .get("vpriv")
    ?.replace(/^0x/i, "")
    .toLowerCase();
  const spendingPublicKey = entries
    .get("spub")
    ?.replace(/^0x/i, "")
    .toLowerCase();
  if (
    !viewingPrivateKey ||
    !spendingPublicKey ||
    !HEX_32.test(viewingPrivateKey) ||
    !HEX_32.test(spendingPublicKey) ||
    entries.size !== 2
  ) {
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      "shareableViewingKey must contain 32-byte vpriv and spub values.",
    );
  }
  return buildShareableKey(viewingPrivateKey, spendingPublicKey);
};

/**
 * Older/debug clients sometimes sent the two raw 32-byte keys back-to-back,
 * either alone or behind a stray `0x82` map header. Accept those so a stale
 * bundle cannot block the scan.
 */
const parseRawShareableViewingKey = (
  bytes: Buffer,
): ShareableViewingKey | null => {
  const payload =
    bytes.length === 65 && bytes[0] === 0x82 ? bytes.subarray(1) : bytes;
  if (payload.length !== 64) return null;
  return buildShareableKey(
    payload.subarray(0, 32).toString("hex"),
    payload.subarray(32, 64).toString("hex"),
  );
};

/**
 * A broken early client declared 64-byte string values but wrote the raw
 * 32-byte keys instead:
 *
 *   82 a5 "vpriv" d9 40 <32 raw bytes> a4 "spub" d9 40 <32 raw bytes>
 *
 * That is exactly 80 bytes. Recover it so an un-reloaded bundle still works.
 */
const parseLegacyBinaryShareableViewingKey = (
  bytes: Buffer,
): ShareableViewingKey | null => {
  if (bytes.length !== 80) return null;
  if (bytes.subarray(0, 8).toString("hex") !== "82a57670726976d9") {
    return null;
  }
  const declared = bytes[8];
  if (declared !== 0x40 && declared !== 0x20) return null;
  if (
    bytes.subarray(41, 47).toString("hex") !== "a473707562d9" ||
    bytes[47] !== declared
  ) {
    return null;
  }
  return buildShareableKey(
    bytes.subarray(9, 41).toString("hex"),
    bytes.subarray(48, 80).toString("hex"),
  );
};

const parseLabeledBinaryShareableViewingKey = (
  bytes: Buffer,
): ShareableViewingKey | null => {
  const text = bytes.toString("latin1");
  const read = (label: string): string | undefined => {
    const match = new RegExp(
      `${label}\\s*[=:]\\s*"?((?:0x)?[0-9a-fA-F]{64})`,
    ).exec(text);
    return match?.[1];
  };
  return parseTextualShareableViewingKey(
    `vpriv=${read("vpriv") ?? ""}&spub=${read("spub") ?? ""}`,
  );
};

export const parseShareableViewingKey = (
  value: unknown,
): ShareableViewingKey => {
  if (typeof value !== "string") {
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      "shareableViewingKey must be a hex string.",
    );
  }
  const trimmed = value.trim();
  const raw = trimmed.replace(/^0x/i, "").toLowerCase();
  if (
    raw.length === 0 ||
    raw.length > 4_096 ||
    raw.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(raw)
  ) {
    const textual = parseTextualShareableViewingKey(trimmed);
    if (textual) return textual;
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      "shareableViewingKey must be a hex string.",
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "hex");
  } catch {
    throw new ScanApiError(
      400,
      "INVALID_SHAREABLE_VIEWING_KEY",
      "shareableViewingKey must be a hex string.",
    );
  }
  try {
    return parseMsgpackShareableViewingKey(bytes);
  } catch (error) {
    const fallback =
      parseLegacyBinaryShareableViewingKey(bytes) ??
      parseRawShareableViewingKey(bytes) ??
      parseLabeledBinaryShareableViewingKey(bytes);
    if (fallback) {
      log.warn(
        `accepted non-standard shareable viewing key (${bytes.length} bytes); ask the client to send RAILGUN msgpack`,
      );
      return fallback;
    }
    throw error;
  }
};

const tokenHashFor = (tokenData: {
  tokenType: number;
  tokenAddress: string;
}): string | null => {
  if (tokenData.tokenType !== 0) return null;
  const address = tokenData.tokenAddress
    .replace(/^0x/i, "")
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(address) && !HEX_32.test(address)) {
    return null;
  }
  return address.padStart(64, "0");
};

const normalizeHex = (value: string): string =>
  value.replace(/^0x/i, "").toLowerCase();

export type RailgunTxo = {
  tree: number;
  position: number;
  txid: string;
  blockNumber: number;
  spendtxid: string | false;
  nullifier: string;
  commitmentType: string;
  note: {
    hash: bigint;
    random: string;
    value: bigint;
    memoText?: string;
    senderRandom?: string;
    tokenData: {
      tokenType: number;
      tokenAddress: string;
      tokenSubID: string;
    };
  };
};

export const mapRemoteScanNotes = (
  txos: readonly RailgunTxo[],
  includeSpent: boolean,
  maxNotes = MAX_REMOTE_SCAN_NOTES,
): RemoteScanNote[] => {
  if (!Number.isSafeInteger(maxNotes) || maxNotes < 0) {
    throw new Error(
      "Remote scan note limit must be a non-negative safe integer.",
    );
  }
  const notes: RemoteScanNote[] = [];
  for (const txo of txos) {
    if (
      txo.commitmentType !== "ShieldCommitment" &&
      txo.commitmentType !== "TransactCommitmentV2"
    ) {
      continue;
    }
    const tokenHash = tokenHashFor(txo.note.tokenData);
    if (!tokenHash) continue;
    const nullifier = normalizeHex(txo.nullifier);
    if (!HEX_32.test(nullifier)) continue;
    const spent = txo.spendtxid !== false;
    if (spent && !includeSpent) continue;
    const hash = txo.note.hash.toString(16).padStart(64, "0");
    if (!HEX_32.test(hash)) continue;
    const txid = normalizeHex(txo.txid);
    if (!HEX_32.test(txid)) {
      throw new Error(
        "Remote scan returned an invalid result: note txid has an invalid encoding.",
      );
    }
    if (notes.length >= maxNotes) throw remoteScanNoteLimitError();
    notes.push({
      tree: txo.tree,
      leaf: txo.position,
      hash,
      blockNumber: txo.blockNumber,
      txid: `0x${txid}`,
      kind:
        txo.commitmentType === "ShieldCommitment"
          ? "shield"
          : "transact",
      commitmentType: txo.commitmentType,
      tokenHash,
      value: txo.note.value.toString(10),
      random: normalizeHex(txo.note.random),
      senderRandom: txo.note.senderRandom
        ? normalizeHex(txo.note.senderRandom)
        : null,
      memo: txo.note.memoText || null,
      nullifier,
      spent,
    });
  }
  return notes;
};

/**
 * Highest block a completed scan is known to cover. Rescanning that block is
 * harmless (clients dedupe by tree/leaf), and everything below it is durable,
 * so a client may resume from it after the node loses its cached session.
 */
export const nextScanCursor = (
  fromBlock: number,
  lastSyncedBlock: number | undefined,
): number | null =>
  lastSyncedBlock !== undefined && lastSyncedBlock >= fromBlock
    ? lastSyncedBlock
    : null;

export const createRemoteScanRunner = (
  chainSync: ChainSyncService,
  options: {
    maxNotes?: number;
    cache?: ScanCacheOptions;
  } = {},
): RemoteScanRunner => {
  const wallets = new ScanWallets({ cache: options.cache });
  // Decrypted notes for wallets already caught up with the local chain head.
  // Bounded and process-local: a repeated refresh for an unchanged head costs
  // one lookup instead of reopening the wallet and walking the tree.
  const fastResults = new Map<
    string,
    { syncedBlock: number; notes: RemoteScanNote[]; bytes: number; at: number }
  >();
  let fastBytes = 0;
  const fastKeyFor = (input: RemoteScanInput): string =>
    createHash("sha256")
      .update(input.shareableViewingKey)
      .update(
        `:${input.network}:${input.txidVersion}:${input.fromBlock}:${input.includeSpent}`,
      )
      .digest("hex");
  const rememberFastResult = (
    key: string,
    syncedBlock: number,
    notes: RemoteScanNote[],
  ): void => {
    const bytes = Buffer.byteLength(JSON.stringify(notes), "utf8");
    if (bytes > FAST_RESULT_MAX_BYTES) return;
    const previous = fastResults.get(key);
    if (previous) fastBytes -= previous.bytes;
    fastResults.set(key, {
      syncedBlock,
      notes: notes.slice(),
      bytes,
      at: Date.now(),
    });
    fastBytes += bytes;
    for (const [staleKey, entry] of fastResults) {
      if (
        fastResults.size <= FAST_RESULT_MAX_ENTRIES &&
        fastBytes <= FAST_RESULT_TOTAL_BYTES
      ) {
        break;
      }
      if (staleKey === key) continue;
      fastResults.delete(staleKey);
      fastBytes -= entry.bytes;
    }
  };
  const runner: RemoteScanRunner = async (input, context) => {
    const chain = chainFor(networkFor(input.network));
    await chainSync.ensureNetworkLoaded(input.network);
    await chainSync.waitForReady(input.network, context.signal);
    context.signal.throwIfAborted();
    const engine = chainSync.getEngine();
    const lastSyncedBlock = await engine.lastSyncedBlock(
      input.network,
      input.txidVersion,
    );
    if (lastSyncedBlock !== undefined && input.fromBlock > lastSyncedBlock) {
      throw new Error("fromBlock is ahead of the synced chain head.");
    }
    const fastKey = fastKeyFor(input);
    const fast = fastResults.get(fastKey);
    if (
      fast &&
      lastSyncedBlock !== undefined &&
      fast.syncedBlock === lastSyncedBlock &&
      Date.now() - fast.at < FAST_RESULT_TTL_MS
    ) {
      context.onProgress({ progress: 1, stage: "scanning" });
      return {
        notes: fast.notes.slice(),
        nextFromBlock: nextScanCursor(input.fromBlock, fast.syncedBlock),
      };
    }
    const tree = engine.getUTXOMerkletree(input.txidVersion, chain);
    const result = await wallets.use(
      {
        key: input.shareableViewingKey,
        chain,
        version: input.txidVersion,
        fromBlock: input.fromBlock,
        lastSyncedBlock,
        tree,
      },
      async ({ wallet, store }) => {
        context.onProgress({ progress: 0.04, stage: "scanning" });
        let lastProgress = 0;
        let reportedProgress = false;
        await wallet.decryptBalances(
          input.txidVersion,
          chain,
          (value: number) => {
            context.signal.throwIfAborted();
            store.assertHealthy();
            reportedProgress = true;
            lastProgress = clamp(value, 0, 1);
            context.onProgress({
              progress: 0.05 + lastProgress * 0.9,
              stage: "scanning",
            });
          },
          true,
        );
        if (context.signal.aborted) {
          throw new Error("Remote scan was cancelled.");
        }
        store.assertHealthy();
        if (reportedProgress && lastProgress < 0.999) {
          throw new Error("RAILGUN balance scan did not complete.");
        }
        if (!reportedProgress) {
          const latestTree = await tree.latestTree();
          const treeLengths = await loadRemoteScanTreeLengths(
            tree,
            latestTree,
          );
          const details = await wallet.getWalletDetails(
            input.txidVersion,
            chain,
          );
          if (!walletTreeScanComplete(details, treeLengths)) {
            throw new Error("RAILGUN balance scan did not start.");
          }
        }

        // Cached TXOs otherwise hide spends that arrived since the previous scan.
        wallet.invalidateCommitmentsCache(chain);
        const txos = (await wallet.TXOs(
          input.txidVersion,
          chain,
        )) as RailgunTxo[];
        context.signal.throwIfAborted();
        const notes = mapRemoteScanNotes(
          txos,
          input.includeSpent,
          options.maxNotes,
        );
        context.onProgress({ progress: 0.98, stage: "scanning" });
        // Sessions and disk buckets can expire between requests, but every
        // block up to the synced head has been decrypted by now, so the client
        // can resume from there instead of its wallet birthday.
        return {
          notes,
          nextFromBlock: nextScanCursor(input.fromBlock, lastSyncedBlock),
        };
      },
    );
    if (lastSyncedBlock !== undefined) {
      rememberFastResult(fastKey, lastSyncedBlock, result.notes);
    }
    return result;
  };
  runner.stop = () => wallets.stop();
  runner.classify = (input) =>
    wallets.peekWarm({
      key: input.shareableViewingKey,
      chain: chainFor(networkFor(input.network)),
      version: input.txidVersion,
    })
      ? "warm"
      : "cold";
  return runner;
};

const digestToken = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

export class RemoteScanService {
  readonly enabled: boolean;
  readonly ratePerMinute: number;

  private readonly tokenDigest: Buffer;
  private readonly runner: RemoteScanRunner;
  private readonly maxJobs: number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly maxNotes: number;
  private readonly maxResultBytes: number;
  private readonly now: () => number;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly startRate: SlidingWindowRateLimiter;
  private readonly pending = new Set<Promise<void>>();
  private readonly warmQueue: string[] = [];
  private readonly coldQueue: string[] = [];
  private readonly coldSlots: number;
  private activeWarm = 0;
  private activeCold = 0;
  private retainedResultBytes = 0;
  private cleanupTimer?: NodeJS.Timeout;
  private stopped = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: RemoteScanServiceOptions) {
    this.enabled = options.enabled;
    this.runner = options.runner;
    this.maxJobs = clamp(Math.floor(options.maxJobs ?? DEFAULT_MAX_JOBS), 1, 4);
    // One slot is reserved for first-time scans so a cold wallet cannot make
    // every refresh wait. With a single slot the two lanes would just merge.
    this.coldSlots = this.maxJobs >= 2 ? 1 : 0;
    this.ttlMs = clamp(
      Math.floor(options.ttlMs ?? DEFAULT_TTL_MS),
      60_000,
      60 * 60_000,
    );
    this.timeoutMs = clamp(
      Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      60_000,
      MAX_TIMEOUT_MS,
    );
    this.maxNotes = clamp(
      Math.floor(options.maxNotes ?? DEFAULT_MAX_NOTES),
      100,
      MAX_REMOTE_SCAN_NOTES,
    );
    this.maxResultBytes = clamp(
      Math.floor(options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES),
      1,
      MAX_RESULT_BYTES_LIMIT,
    );
    this.ratePerMinute = clamp(
      Math.floor(options.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE),
      1,
      120,
    );
    this.startRate = new SlidingWindowRateLimiter(
      this.ratePerMinute,
      RATE_WINDOW_MS,
      1_024,
    );
    this.now = options.now ?? Date.now;
    this.tokenDigest = digestToken(options.token);
    if (this.enabled && options.token.trim().length === 0) {
      throw new Error("LIGHT_SCAN_TOKEN is required when scan is enabled.");
    }
    if (this.enabled) {
      this.cleanupTimer = setInterval(
        () => this.cleanup(),
        CLEANUP_INTERVAL_MS,
      );
      this.cleanupTimer.unref();
    }
  }

  authorize(authorization: string | undefined): void {
    if (!this.enabled) {
      throw new ScanApiError(
        403,
        "SCAN_DISABLED",
        "Remote note scan is disabled on this indexer.",
      );
    }
    const raw =
      typeof authorization === "string" &&
      authorization.toLowerCase().startsWith("bearer ")
        ? authorization.slice(7).trim()
        : "";
    if (!raw || !timingSafeEqual(digestToken(raw), this.tokenDigest)) {
      throw new ScanApiError(
        401,
        "SCAN_UNAUTHORIZED",
        "A valid scan token is required.",
      );
    }
  }

  enforceStartRate(ip: string): void {
    if (!this.startRate.allow(ip, this.now())) {
      throw new ScanApiError(
        429,
        "RATE_LIMITED",
        "Too many scan requests; try again later.",
      );
    }
  }

  start(input: {
    network: NetworkName;
    txidVersion: TXIDVersion;
    shareableViewingKey: string;
    fromBlock?: number;
    includeSpent?: boolean;
  }): string {
    if (!this.enabled) {
      throw new ScanApiError(
        403,
        "SCAN_DISABLED",
        "Remote note scan is disabled on this indexer.",
      );
    }
    if (input.txidVersion !== TXIDVersion.V2_PoseidonMerkle) {
      throw new ScanApiError(
        400,
        "UNSUPPORTED_TXID_VERSION",
        "Remote scan currently supports V2_PoseidonMerkle only.",
      );
    }
    const shareable = parseShareableViewingKey(input.shareableViewingKey);
    const fromBlock = Math.max(
      railgunDeploymentBlock(input.network),
      input.fromBlock ?? 0,
    );
    const includeSpent = input.includeSpent !== false;
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) {
      throw new ScanApiError(
        400,
        "INVALID_REQUEST",
        "fromBlock must be a non-negative integer.",
      );
    }
    this.cleanup();
    if (this.stopped) {
      throw new ScanApiError(
        503,
        "SCAN_DISABLED",
        "Remote scanner is stopping.",
      );
    }
    for (const job of this.jobs.values()) {
      if (
        (job.status === "running" || job.status === "queued") &&
        job.input.network === input.network &&
        job.input.txidVersion === input.txidVersion &&
        job.input.shareableViewingKey === shareable.canonical &&
        job.input.fromBlock === fromBlock &&
        job.input.includeSpent === includeSpent
      ) {
        return job.id;
      }
    }
    const normalizedInput: RemoteScanInput = {
      network: input.network,
      txidVersion: input.txidVersion,
      shareableViewingKey: shareable.canonical,
      fromBlock,
      includeSpent,
    };
    const lane: JobRecord["lane"] =
      this.coldSlots > 0 &&
      this.runner.classify?.(normalizedInput) === "cold"
        ? "cold"
        : "warm";
    if (
      this.queueDepth() >= MAX_QUEUED_JOBS ||
      this.jobs.size >= MAX_STORED_JOBS
    ) {
      throw new ScanApiError(
        429,
        "SCAN_BUSY",
        "Remote scan queue is full; wait or delete completed results.",
      );
    }
    const id = randomBytes(16).toString("hex");
    const createdAt = this.now();
    const job: JobRecord = {
      id,
      input: normalizedInput,
      lane,
      status: "queued",
      stage: "queued",
      progress: 0,
      notes: [],
      resultBytes: 0,
      truncated: false,
      nextFromBlock: null,
      createdAt,
      updatedAt: createdAt,
      controller: new AbortController(),
    };
    this.jobs.set(id, job);
    this.schedule(job);
    return id;
  }

  status(jobId: string): RemoteScanJobView {
    return this.view(this.requireJob(jobId));
  }

  cancel(jobId: string): RemoteScanJobView {
    const job = this.requireJob(jobId);
    const wasRunning = job.status === "running";
    if (!wasRunning) this.removeFromQueue(jobId);
    if (job.status === "queued") {
      job.status = "cancelled";
      job.updatedAt = this.now();
    }
    this.abortRunning(job);
    this.discardSensitiveInput(job);
    this.releaseResult(job);
    if (!wasRunning) {
      this.jobs.delete(jobId);
    }
    return this.view(job);
  }

  cancelIfPresent(jobId: string): void {
    if (!JOB_ID_PATTERN.test(jobId)) return;
    this.cleanup();
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.removeFromQueue(jobId);
    this.abortRunning(job);
    this.discardSensitiveInput(job);
    this.releaseResult(job);
    this.jobs.delete(jobId);
  }

  stop(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    this.shutdownPromise = this.stopInternal();
    return this.shutdownPromise;
  }

  private async stopInternal(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.controller.abort();
        job.status = "cancelled";
      } else if (job.status === "queued") {
        job.status = "cancelled";
        job.updatedAt = this.now();
      }
      this.discardSensitiveInput(job);
      this.releaseResult(job);
    }
    this.warmQueue.length = 0;
    this.coldQueue.length = 0;
    this.activeCold = 0;
    const drained = await settleWithin(
      this.pending,
      REMOTE_SCAN_STOP_TIMEOUT_MS,
    );
    let runnerCleanupFailure: Error | undefined;
    const runnerCleanup = await settleCleanup(
      () => this.runner.stop?.(),
      REMOTE_SCAN_STOP_TIMEOUT_MS,
      "Remote scan runner cleanup timed out.",
    );
    if (!runnerCleanup.ok) {
      runnerCleanupFailure =
        runnerCleanup.error instanceof Error
          ? runnerCleanup.error
          : new Error("Remote scan runner cleanup failed.");
    }
    this.jobs.clear();
    this.pending.clear();
    this.startRate.clear();
    this.retainedResultBytes = 0;
    const cleanupFailures: Error[] = [];
    if (!drained) {
      cleanupFailures.push(
        new Error(
          "Remote scan workers did not drain before the shutdown deadline.",
        ),
      );
    }
    if (runnerCleanupFailure) cleanupFailures.push(runnerCleanupFailure);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, cleanupFailures[0]!.message);
    }
  }

  private requireJob(jobId: string): JobRecord {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new ScanApiError(
        404,
        "SCAN_NOT_FOUND",
        "Remote scan job not found.",
      );
    }
    this.cleanup();
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new ScanApiError(
        404,
        "SCAN_NOT_FOUND",
        "Remote scan job not found.",
      );
    }
    return job;
  }

  private activeJobs(): number {
    return this.pending.size;
  }

  private queueDepth(): number {
    return this.warmQueue.length + this.coldQueue.length;
  }

  private schedule(job: JobRecord): void {
    const queue =
      job.lane === "cold" ? this.coldQueue : this.warmQueue;
    const coldBlocked =
      job.lane === "cold" && this.activeCold >= this.coldSlots;
    const warmBlocked =
      job.lane === "warm" && this.activeWarm >= this.warmCapacity();
    if (
      this.stopped ||
      this.activeJobs() >= this.maxJobs ||
      coldBlocked ||
      warmBlocked
    ) {
      job.status = "queued";
      job.stage = "queued";
      job.updatedAt = this.now();
      queue.push(job.id);
      return;
    }
    this.launch(job);
  }

  private launch(job: JobRecord): void {
    job.status = "running";
    job.stage = "syncing";
    job.updatedAt = this.now();
    if (job.lane === "cold") this.activeCold += 1;
    else this.activeWarm += 1;
    const task = this.run(job);
    this.pending.add(task);
    void task
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(task);
        if (job.lane === "cold") {
          this.activeCold = Math.max(0, this.activeCold - 1);
        } else {
          this.activeWarm = Math.max(0, this.activeWarm - 1);
        }
        this.pump();
      });
  }

  /**
   * When a first-time scan is waiting, refreshes leave one slot for it.
   * Otherwise they may use every slot.
   */
  private warmCapacity(): number {
    return this.coldQueue.length > 0
      ? Math.max(0, this.maxJobs - this.coldSlots)
      : this.maxJobs;
  }

  private pump(): void {
    if (this.stopped) return;
    // Refreshes always go first; a cold scan only starts while its reserved
    // slot is free, so one first-time wallet cannot stall every refresh.
    while (
      this.activeJobs() < this.maxJobs &&
      this.activeWarm < this.warmCapacity() &&
      this.launchNext(this.warmQueue)
    ) {
      // keep filling warm slots
    }
    while (
      this.activeJobs() < this.maxJobs &&
      this.activeCold < this.coldSlots &&
      this.launchNext(this.coldQueue)
    ) {
      // keep filling the cold slot
    }
  }

  private launchNext(queue: string[]): boolean {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return false;
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      this.launch(job);
      return true;
    }
  }

  private removeFromQueue(jobId: string): void {
    for (const queue of [this.warmQueue, this.coldQueue]) {
      const index = queue.indexOf(jobId);
      if (index >= 0) queue.splice(index, 1);
    }
  }

  private abortRunning(job: JobRecord): void {
    if (job.status !== "running") return;
    job.controller.abort();
    job.status = "cancelled";
    job.updatedAt = this.now();
  }

  private view(job: JobRecord): RemoteScanJobView {
    return {
      jobId: job.id,
      network: job.input.network,
      txidVersion: job.input.txidVersion,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      found: job.notes.length,
      ...(job.status === "done" ? { notes: job.notes } : {}),
      truncated: job.truncated,
      nextFromBlock: job.nextFromBlock,
      ...(job.error ? { error: job.error } : {}),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private sanitizeError(error: unknown): string {
    const message =
      error instanceof Error ? error.message : "Remote scan failed.";
    const redacted = message.startsWith("Remote scan ")
      ? message
      : "Remote scan failed.";
    return redacted.slice(0, MAX_ERROR_LENGTH);
  }

  private retainResult(job: JobRecord, notes: RemoteScanNote[]): void {
    const bytes = Buffer.byteLength(JSON.stringify(notes), "utf8");
    if (
      bytes > this.maxResultBytes ||
      this.retainedResultBytes > this.maxResultBytes - bytes
    ) {
      throw new Error("Remote scan result storage limit exceeded.");
    }
    job.notes = notes;
    job.resultBytes = bytes;
    this.retainedResultBytes += bytes;
  }

  private releaseResult(job: JobRecord): void {
    if (job.resultBytes > 0) {
      this.retainedResultBytes -= job.resultBytes;
      job.resultBytes = 0;
    }
    job.notes = [];
  }

  private discardSensitiveInput(job: JobRecord): void {
    job.input.shareableViewingKey = "";
  }

  private async run(job: JobRecord): Promise<void> {
    const shortId = job.id.slice(0, 8);
    const timer = setTimeout(() => {
      if (job.status !== "running") return;
      job.status = "error";
      job.error = "Remote scan timed out.";
      job.updatedAt = this.now();
      job.controller.abort();
      this.discardSensitiveInput(job);
    }, this.timeoutMs);
    timer.unref();
    log.info(
      `scan ${shortId} started (${job.input.network}, from ${job.input.fromBlock})`,
    );
    try {
      const result = normalizeRemoteScanResult(
        await this.runner(job.input, {
          signal: job.controller.signal,
          onProgress: (progress) => {
            if (job.status !== "running") return;
            job.progress = clamp(progress.progress, 0, 0.99);
            job.stage = progress.stage;
            job.updatedAt = this.now();
          },
        }),
        this.maxNotes,
      );
      if (job.status !== "running") return;
      this.retainResult(job, result.notes);
      job.nextFromBlock = result.nextFromBlock;
      job.progress = 1;
      job.status = "done";
      job.updatedAt = this.now();
      log.info(`scan ${shortId} complete with ${job.notes.length} note(s)`);
    } catch (error) {
      if (job.status !== "running") return;
      if (job.controller.signal.aborted) {
        job.status = "cancelled";
        log.info(`scan ${shortId} cancelled`);
      } else {
        job.status = "error";
        job.error = this.sanitizeError(error);
        log.warn(`scan ${shortId} failed: ${job.error}`);
      }
      job.updatedAt = this.now();
    } finally {
      clearTimeout(timer);
      this.discardSensitiveInput(job);
      job.finishedAt = this.now();
      job.expiresAt = job.finishedAt + this.ttlMs;
    }
  }

  private cleanup(): void {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt !== undefined && job.expiresAt <= now) {
        this.releaseResult(job);
        this.jobs.delete(id);
      }
    }
  }
}
