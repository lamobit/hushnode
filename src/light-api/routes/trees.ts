import type { Router } from "express";
import { throwIfAborted } from "../../abort.js";
import { asyncRoute } from "../http.js";
import {
  normalizeLatestTree,
  normalizeMerkleProof,
  normalizeTreeRoot,
  normalizeTreeLength,
  readLightIndex,
  requireReadyTree,
} from "../index-source.js";
import {
  DEFAULT_MAX_NOTES,
  DEFAULT_MAX_NULLIFIERS,
  MAX_NOTES,
  MAX_NULLIFIERS,
  NULLIFIER_PATTERN,
  ZERO_ROOT,
  LightApiError,
  parseLimitParam,
  parseIntParam,
  parseNetwork,
  parseNullifierCursor,
  parseTxidVersion,
  publicNetwork,
  type LightApiOptions,
} from "../protocol.js";

export const registerTreeRoutes = (
  router: Router,
  options: LightApiOptions,
  maxTrees: number,
): void => {
  router.get(
    "/trees",
    asyncRoute(async (request, response, signal) => {
      throwIfAborted(signal);
      const network = parseNetwork(request.query.network);
      const txidVersion = parseTxidVersion(request.query.txidVersion);
      const tree = await requireReadyTree(options, network, txidVersion);
      const { tree: rawLatest } = await readLightIndex(() =>
        tree.getLatestTreeAndIndex(),
      );
      const latestTree = normalizeLatestTree(rawLatest);
      const start = Math.max(0, latestTree - maxTrees + 1);
      const trees: Array<{ tree: number; leaves: number; root: string }> = [];
      for (let index = start; index <= latestTree; index += 1) {
        throwIfAborted(signal);
        const leaves = normalizeTreeLength(
          await readLightIndex(() => tree.getTreeLength(index)),
        );
        throwIfAborted(signal);
        trees.push({
          tree: index,
          leaves,
          root: leaves > 0
            ? normalizeTreeRoot(
                await readLightIndex(() => tree.getRoot(index)),
              )
            : ZERO_ROOT,
        });
      }
      throwIfAborted(signal);
      response.json({
        network: publicNetwork(network),
        txidVersion,
        latestTree,
        trees,
      });
    }),
  );

  router.get(
    "/trees/:tree/notes",
    asyncRoute(async (request, response, signal) => {
      throwIfAborted(signal);
      const network = parseNetwork(request.query.network);
      const txidVersion = parseTxidVersion(request.query.txidVersion);
      const treeNumber = parseIntParam(request.params.tree, "tree");
      const start = parseIntParam(request.query.start ?? "0", "start");
      const limit = parseLimitParam(
        request.query.limit,
        DEFAULT_MAX_NOTES,
        MAX_NOTES,
      );
      const tree = await requireReadyTree(
        options,
        network,
        txidVersion,
        treeNumber,
      );
      const leaves = normalizeTreeLength(
        await readLightIndex(() => tree.getTreeLength(treeNumber)),
      );
      throwIfAborted(signal);
      if (start >= leaves) {
        response.json({
          tree: treeNumber,
          start,
          leaves,
          notes: [],
          next: null,
        });
        return;
      }
      const end = Math.min(start + limit - 1, leaves - 1);
      const range = await readLightIndex(() =>
        tree.getCommitmentRange(treeNumber, start, end),
      );
      const expected = end - start + 1;
      throwIfAborted(signal);
      const commitments = Array.isArray(range)
        ? Array.from(range.slice(0, expected))
        : [];
      if (
        !Array.isArray(range) ||
        range.length < expected ||
        commitments.some(
          (commitment) =>
            typeof commitment !== "object" ||
            commitment === null ||
            Array.isArray(commitment),
        )
      ) {
        throw new LightApiError(
          503,
          "LIGHT_INDEX_UNAVAILABLE",
          "The light index returned an invalid commitment range.",
        );
      }
      const notes = commitments.map((commitment, offset) => {
        const candidate = commitment.utxoIndex;
        const index =
          commitment.utxoTree === treeNumber &&
          typeof candidate === "number" &&
          Number.isSafeInteger(candidate) &&
          candidate >= start &&
          candidate <= end
            ? candidate
            : start + offset;
        return { ...commitment, index };
      });
      const lastIndex = notes.at(-1)?.index;
      const nextIndex =
        typeof lastIndex === "number"
          ? lastIndex + 1
          : notes.length > 0
            ? start + notes.length
            : end + 1;
      throwIfAborted(signal);
      response.json({
        tree: treeNumber,
        start,
        leaves,
        notes,
        next: nextIndex < leaves ? nextIndex : null,
      });
    }),
  );

  router.get(
    "/trees/:tree/nullifiers",
    asyncRoute(async (request, response, signal) => {
      throwIfAborted(signal);
      const network = parseNetwork(request.query.network);
      const txidVersion = parseTxidVersion(request.query.txidVersion);
      const treeNumber = parseIntParam(request.params.tree, "tree");
      const after = parseNullifierCursor(request.query.after);
      const limit = parseLimitParam(
        request.query.limit,
        DEFAULT_MAX_NULLIFIERS,
        MAX_NULLIFIERS,
      );
      const tree = await requireReadyTree(
        options,
        network,
        txidVersion,
        treeNumber,
      );
      let raw: string[];
      try {
        raw = await tree.getNullifiers(treeNumber, after, limit + 1);
      } catch {
        throwIfAborted(signal);
        throw new LightApiError(
          503,
          "NULLIFIER_INDEX_UNAVAILABLE",
          "The nullifier index is temporarily unavailable.",
        );
      }
      const bounded = Array.isArray(raw) && raw.length <= limit + 1;
      const values = bounded ? Array.from(raw) : [];
      if (
        !bounded ||
        values.some(
          (value) =>
            typeof value !== "string" ||
            !NULLIFIER_PATTERN.test(value.toLowerCase()),
        )
      ) {
        throw new LightApiError(
          503,
          "NULLIFIER_INDEX_UNAVAILABLE",
          "The nullifier index is temporarily unavailable.",
        );
      }
      const nullifiers = values
        .slice(0, limit)
        .map((value) => value.toLowerCase());
      const next = values.length > limit
        ? nullifiers.at(-1) ?? null
        : null;
      throwIfAborted(signal);
      response.json({
        tree: treeNumber,
        nullifiers,
        next,
      });
    }),
  );

  router.get(
    "/trees/:tree/proof/:leaf",
    asyncRoute(async (request, response, signal) => {
      throwIfAborted(signal);
      const network = parseNetwork(request.query.network);
      const txidVersion = parseTxidVersion(request.query.txidVersion);
      const treeNumber = parseIntParam(request.params.tree, "tree");
      const leaf = parseIntParam(request.params.leaf, "leaf");
      const tree = await requireReadyTree(
        options,
        network,
        txidVersion,
        treeNumber,
      );
      const leaves = normalizeTreeLength(
        await readLightIndex(() => tree.getTreeLength(treeNumber)),
      );
      throwIfAborted(signal);
      if (leaf >= leaves) {
        throw new LightApiError(
          404,
          "LEAF_NOT_FOUND",
          `Leaf ${leaf} is outside tree ${treeNumber}.`,
        );
      }
      const proof = normalizeMerkleProof(
        await readLightIndex(() =>
          tree.getMerkleProof(treeNumber, leaf),
        ),
      );
      throwIfAborted(signal);
      response.json({
        tree: treeNumber,
        leaf,
        proof,
      });
    }),
  );
};
