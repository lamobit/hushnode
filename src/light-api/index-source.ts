import {
  NULLIFIER_PATTERN,
  ZERO_NULLIFIER,
  ZERO_ROOT,
  LightApiError,
  normalizeRoot,
  type ChainSyncIndexingSource,
  type LightApiOptions,
  type LightIndexSource,
  type LightMerkleProof,
  type LightTreeSource,
  type NullifierStreamOptions,
  type RealUtxoTreeSource,
} from "./protocol.js";
import type { IndexReadiness } from "../index-readiness.js";
import { chainFor, networkFor } from "../networks.js";
import type { NetworkName, TXIDVersion } from "@railgun-community/shared-models";

const readNullifierFromStreamEntry = (entry: unknown): string | null => {
  let key: unknown = entry;
  if (
    typeof entry === "object" &&
    entry !== null &&
    "key" in entry
  ) {
    key = (entry as { key?: unknown }).key;
  }
  const text = Buffer.isBuffer(key) ? key.toString("utf8") : String(key ?? "");
  const last = text.split(":").at(-1)?.toLowerCase() ?? "";
  return NULLIFIER_PATTERN.test(last) ? last : null;
};

const scanNullifierRange = async (
  merkletree: RealUtxoTreeSource,
  tree: number,
  after: string | null,
  limit: number,
): Promise<string[]> => {
  if (!merkletree.db?.level?.createReadStream) {
    throw new Error("Nullifier LevelDB is unavailable.");
  }
  const zeroPath = merkletree.getNullifierDBPath(tree, ZERO_NULLIFIER);
  const prefix = zeroPath
    .slice(0, -1)
    .map((part) => part.toLowerCase())
    .join(":");
  const startKey = `${prefix}:${after ?? ""}`;
  const options: NullifierStreamOptions = {
    ...(after ? { gt: startKey } : { gte: startKey }),
    lte: `${prefix}:~`,
    limit,
    keys: true,
    values: false,
  };
  const stream = merkletree.db.level.createReadStream(options);

  return new Promise<string[]>((resolve, reject) => {
    const nullifiers: string[] = [];
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(nullifiers);
      }
    };

    stream.on("data", (entry: unknown) => {
      const nullifier = readNullifierFromStreamEntry(entry);
      if (!nullifier) {
        finish(new Error("Nullifier LevelDB returned an invalid key."));
        stream.destroy?.();
        return;
      }
      nullifiers.push(nullifier);
      if (nullifiers.length >= limit) {
        finish();
        stream.destroy?.();
      }
    });
    stream.on("error", finish);
    stream.on("end", () => finish());
  });
};

const wrapUtxoTree = (
  merkletree: RealUtxoTreeSource,
): LightTreeSource => ({
  getLatestTreeAndIndex: () => merkletree.getLatestTreeAndIndex(),
  getTreeLength: (tree) => merkletree.getTreeLength(tree),
  getRoot: (tree) => merkletree.getRoot(tree),
  getCommitmentRange: (tree, start, end) =>
    merkletree.getCommitmentRange(tree, start, end),
  getNullifiers: (tree, after, limit) =>
    scanNullifierRange(merkletree, tree, after, limit),
  getMerkleProof: (tree, leaf) => merkletree.getMerkleProof(tree, leaf),
});

export const createChainSyncLightSource = (
  chainSync: ChainSyncIndexingSource,
): LightIndexSource => ({
  isRunning: () => chainSync.isRunning(),
  isNetworkLoaded: (network) => chainSync.isNetworkLoaded(network),
  readiness: (network) => chainSync.readiness(network),
  scanActivity: (network) => chainSync.getEngine().scanActivity(network),
  lastSyncedBlock: (network, txidVersion) =>
    chainSync.getEngine().lastSyncedBlock(network, txidVersion),
  tree: (network, txidVersion) =>
    wrapUtxoTree(
      chainSync
        .getEngine()
        .getUTXOMerkletree(
          txidVersion,
          chainFor(networkFor(network)),
        ) as unknown as RealUtxoTreeSource,
    ),
  provider: (network) => {
    const provider = chainSync.getEngine().provider(network);
    return {
      call: (transaction) => provider.call(transaction),
      getBlockNumber: () => provider.getBlockNumber(),
      sendRawTransaction: async (raw) => {
        const response = await provider.broadcastTransaction(raw);
        return response.hash;
      },
      getTransactionCount: (address, tag) =>
        provider.getTransactionCount(address, tag),
      getBalance: (address, tag) => provider.getBalance(address, tag),
      feeData: async () => {
        const [fees, block] = await Promise.all([
          provider.getFeeData(),
          provider.getBlock("latest"),
        ]);
        return {
          baseFeePerGas: block?.baseFeePerGas ?? null,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          maxFeePerGas: fees.maxFeePerGas,
        };
      },
      estimateGas: (transaction) => provider.estimateGas(transaction),
      getTransactionReceipt: async (hash) => {
        const receipt = await provider.getTransactionReceipt(hash);
        if (!receipt) return null;
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.gasPrice,
        };
      },
    };
  },
});

export const requireConfiguredSource = (
  options: LightApiOptions,
): LightIndexSource => {
  if (!options.source) {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index is not configured.",
    );
  }
  return options.source;
};

const requireRunningSource = (
  options: LightApiOptions,
): LightIndexSource => {
  if (!options.source) {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index is not running.",
    );
  }
  let running: boolean;
  try {
    running = options.source.isRunning();
  } catch {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index state is temporarily unavailable.",
    );
  }
  if (!running) {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index is not running.",
    );
  }
  return options.source;
};

export const requireSource = (
  options: LightApiOptions,
  network: NetworkName,
): LightIndexSource => {
  const source = requireRunningSource(options);
  let loaded: boolean;
  try {
    loaded = source.isNetworkLoaded(network);
  } catch {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index state is temporarily unavailable.",
    );
  }
  if (!loaded) {
    throw new LightApiError(
      503,
      "LIGHT_NETWORK_NOT_LOADED",
      `${network} is not loaded on the light index.`,
    );
  }
  return source;
};

export const requireReadySource = (
  options: LightApiOptions,
  network: NetworkName,
): LightIndexSource => {
  const source = requireSource(options, network);
  let readiness: IndexReadiness;
  try {
    readiness = source.readiness(network);
  } catch {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_SYNCING",
      "The light index state is temporarily unavailable.",
    );
  }
  if (!readiness.ready) {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_SYNCING",
      "The light index has not completed its initial chain sync.",
    );
  }
  return source;
};

export const requireTreeFromSource = async (
  source: LightIndexSource,
  network: NetworkName,
  txidVersion: TXIDVersion,
  treeNumber?: number,
): Promise<LightTreeSource> => {
  const tree = readLightIndexSync(() => source.tree(network, txidVersion));
  if (treeNumber !== undefined) {
    await requireTree(tree, treeNumber);
  }
  return tree;
};

export const requireReadyTree = async (
  options: LightApiOptions,
  network: NetworkName,
  txidVersion: TXIDVersion,
  treeNumber?: number,
): Promise<LightTreeSource> => {
  const source = requireReadySource(options, network);
  return requireTreeFromSource(source, network, txidVersion, treeNumber);
};

export const readLightIndexSync = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LightApiError) throw error;
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index read is temporarily unavailable.",
    );
  }
};

export const readLightIndex = async <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LightApiError) throw error;
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index read is temporarily unavailable.",
    );
  }
};

const normalizeHex32 = (value: unknown, label: string): string => {
  try {
    return normalizeRoot(value);
  } catch {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      `The light index returned an invalid ${label}.`,
    );
  }
};

export const normalizeTreeRoot = (value: unknown): string =>
  normalizeHex32(value, "tree root");

export const normalizeMerkleProof = (value: unknown): LightMerkleProof => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index returned an invalid Merkle proof.",
    );
  }
  const proof = value as Record<string, unknown>;
  if (!Array.isArray(proof.elements) || proof.elements.length !== 16) {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index returned an invalid Merkle proof.",
    );
  }
  return {
    leaf: normalizeHex32(proof.leaf, "Merkle proof leaf"),
    elements: Array.from(proof.elements, (element) =>
      normalizeHex32(element, "Merkle proof element"),
    ),
    indices: normalizeHex32(proof.indices, "Merkle proof indices"),
    root: normalizeHex32(proof.root, "Merkle proof root"),
  };
};

export const normalizeLatestTree = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index returned an invalid tree pointer.",
    );
  }
  return value;
};

export const normalizeTreeLength = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LightApiError(
      503,
      "LIGHT_INDEX_UNAVAILABLE",
      "The light index returned an invalid tree length.",
    );
  }
  return value;
};

export const requireTree = async (
  tree: LightTreeSource,
  treeNumber: number,
): Promise<void> => {
  const { tree: rawLatest } = await readLightIndex(() =>
    tree.getLatestTreeAndIndex(),
  );
  const latest = normalizeLatestTree(rawLatest);
  if (treeNumber > latest) {
    throw new LightApiError(
      404,
      "TREE_NOT_FOUND",
      `Tree ${treeNumber} does not exist.`,
    );
  }
};

export const latestTreeInfo = async (
  tree: LightTreeSource,
): Promise<{ latest: number; leaves: number; root: string }> => {
  const { tree: rawLatest } = await readLightIndex(() =>
    tree.getLatestTreeAndIndex(),
  );
  const latest = normalizeLatestTree(rawLatest);
  const leaves = normalizeTreeLength(
    await readLightIndex(() => tree.getTreeLength(latest)),
  );
  const root = leaves > 0
    ? normalizeTreeRoot(
        await readLightIndex(() => tree.getRoot(latest)),
      )
    : ZERO_ROOT;
  return { latest, leaves, root };
};
