import { createRequire } from "node:module";
import path from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("txid-sync");

const TXID_SYNC_BATCH_SIZE = 1_000;
const TXID_SYNC_TIMEOUT_MS = 90_000;
const TXID_TIMEOUT_MESSAGE =
  "Timeout querying Graph for QuickSync of RAILGUN Transactions";

type ArgumentNode = {
  name?: { value?: string };
  value?: { kind?: string; value?: string } | null;
};

type SelectionNode = {
  kind?: string;
  name?: { value?: string };
  arguments?: ArgumentNode[];
  selectionSet?: { selections?: SelectionNode[] };
};

type DocumentNode = {
  definitions?: Array<{ selectionSet?: { selections?: SelectionNode[] } }>;
};

type GraphqlModule = {
  GetRailgunTransactionsAfterGraphIDDocument?: DocumentNode;
};

type TimeoutFn = (
  promise: Promise<unknown>,
  milliseconds: number,
  error?: Error,
) => Promise<unknown>;

type EngineModule = {
  setEngineTxidSyncBatchSize?: (size: number) => void;
};

type PromisesModule = {
  promiseTimeout?: TimeoutFn;
};

export const applyTxidQueryLimit = (
  document: DocumentNode | undefined,
  limitValue = TXID_SYNC_BATCH_SIZE,
): boolean => {
  for (const definition of document?.definitions ?? []) {
    const transactions = definition.selectionSet?.selections?.find(
      (selection) =>
        selection.kind === "Field" &&
        selection.name?.value === "transactions",
    );
    const limit = transactions?.arguments?.find(
      (argument) => argument.name?.value === "limit",
    );
    if (!limit?.value) continue;
    limit.value.value = String(limitValue);
    return true;
  }
  return false;
};

export const patchTxidTimeout = (
  promises: PromisesModule,
  timeoutMs = TXID_SYNC_TIMEOUT_MS,
  timeoutMessage = TXID_TIMEOUT_MESSAGE,
): boolean => {
  const originalPromiseTimeout = promises.promiseTimeout;
  if (typeof originalPromiseTimeout !== "function") return false;
  promises.promiseTimeout = (promise, milliseconds, error) =>
    originalPromiseTimeout(
      promise,
      error?.message === timeoutMessage
        ? Math.max(milliseconds, timeoutMs)
        : milliseconds,
      error,
    );
  return true;
};

let tuned = false;

/**
 * The wallet SDK asks the Squid indexer for 10,000 TXIDs per request and
 * rejects the request after 20 seconds. That response is roughly 11 MB, which
 * takes well over 20 seconds on ordinary consumer connections, so the TXID
 * tree never commits its first batch. Use smaller batches, allow the slow
 * response to finish, and keep the engine's loop threshold in sync.
 *
 * This targets the pinned @railgun-community/wallet 11.2.0 internals. Remove
 * the shim once the SDK exposes the subgraph page size and timeout.
 */
export const tuneTxidSync = (): void => {
  if (tuned) return;
  try {
    const require = createRequire(import.meta.url);
    const walletEntry = require.resolve("@railgun-community/wallet");
    const walletRequire = createRequire(walletEntry);
    const walletRoot = path.dirname(walletEntry);

    const graphql = walletRequire(
      path.join(
        walletRoot,
        "services/railgun/railgun-txids/graphql/index.js",
      ),
    ) as GraphqlModule;

    const engine = walletRequire("@railgun-community/engine") as EngineModule;
    if (typeof engine.setEngineTxidSyncBatchSize !== "function") {
      log.warn(
        "TXID sync tuning skipped: setEngineTxidSyncBatchSize is unavailable",
      );
      return;
    }

    if (
      !applyTxidQueryLimit(
        graphql.GetRailgunTransactionsAfterGraphIDDocument,
        TXID_SYNC_BATCH_SIZE,
      )
    ) {
      log.warn(
        "TXID sync tuning skipped: the RAILGUN transaction query shape changed",
      );
      return;
    }

    engine.setEngineTxidSyncBatchSize(TXID_SYNC_BATCH_SIZE);

    const sharedRoot = path.dirname(
      walletRequire.resolve("@railgun-community/shared-models"),
    );
    const promises = walletRequire(
      path.join(sharedRoot, "utils/promises.js"),
    ) as PromisesModule;
    const timeoutPatched = patchTxidTimeout(promises);
    if (timeoutPatched) {
      log.info(
        `TXID sync tuned: batch=${TXID_SYNC_BATCH_SIZE}, timeout=${TXID_SYNC_TIMEOUT_MS}ms`,
      );
    } else {
      log.warn(
        `TXID sync partially tuned: batch=${TXID_SYNC_BATCH_SIZE}, timeout unchanged because promiseTimeout is unavailable`,
      );
    }

    tuned = true;
  } catch (error) {
    log.warn("TXID sync tuning failed", error);
  }
};
