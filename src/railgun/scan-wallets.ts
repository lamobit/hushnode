import { createHash, createHmac } from "node:crypto";
import {
  ViewOnlyWallet,
  type AbstractWallet,
  type Prover,
} from "@railgun-community/engine";
import { getProver } from "@railgun-community/wallet";
import type { Chain, TXIDVersion } from "@railgun-community/shared-models";
import { settleCleanup } from "../async-lifecycle.js";
import { mapWithConcurrency } from "../concurrency.js";
import { createLogger } from "../logger.js";
import {
  ScanCache,
  SCAN_CACHE_SCHEMA_VERSION,
  type ScanCacheMeta,
  type ScanCacheOptions,
} from "./scan-cache.js";
import { ScanStore } from "./scan-store.js";

const log = createLogger("scan-wallets");

export const SCAN_SESSION_STORAGE_CLEANUP_TIMEOUT_MS = 2_000;
const CLEANUP_CONCURRENCY = 4;
const SCAN_STATE_READ_CONCURRENCY = 16;
const CACHE_GC_INTERVAL_MS = 10 * 60_000;
const REMOTE_SCAN_COMMITMENT_TYPES = new Set([
  "ShieldCommitment",
  "TransactCommitmentV2",
]);

type CommitmentScannableWallet = {
  createScannedDBCommitments: (
    txidVersion: TXIDVersion,
    leaf: { commitmentType: string },
    ...args: unknown[]
  ) => Promise<unknown[]>;
};

type Session = {
  wallet: AbstractWallet;
  store: ScanStore;
  chain: Chain;
  version: TXIDVersion;
  fromBlock: number;
  lastSyncedBlock?: number;
  cacheMeta?: ScanCacheMeta;
  createdAt: number;
  lastUsedAt: number;
  busy: boolean;
};

type CleanupTarget = {
  wallet?: AbstractWallet;
  store: ScanStore;
  chain: Chain;
  version: TXIDVersion;
  cacheKey?: string;
  cacheMeta?: ScanCacheMeta;
  purge?: boolean;
};

type SessionOptions = {
  maxSessions?: number;
  idleMs?: number;
  lifetimeMs?: number;
  maxBytes?: number;
  now?: () => number;
  prover?: Prover;
  cache?: ScanCacheOptions;
};

const isLockError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /\block\b/i.test(message);
};

const sessionKeyFor = (
  key: string,
  chain: Chain,
  version: TXIDVersion,
): string =>
  createHash("sha256")
    .update(key)
    .update(`:${chain.type}:${chain.id}:${version}`)
    .digest("hex");

/** Sessions are network-specific; an earlier birthday invalidates cached progress. */
export class ScanWallets {
  private readonly sessions = new Map<string, Session>();
  private readonly cleanupFailures = new Map<CleanupTarget, Error[]>();
  private readonly cache?: ScanCache;
  private readonly timer: NodeJS.Timeout;
  private stopped = false;
  private maintenance = Promise.resolve();
  private nextCacheGcAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: SessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cache = options.cache
      ? new ScanCache({ ...options.cache, now: this.now })
      : undefined;
    this.timer = setInterval(() => {
      void this.prune().catch(() => log.error("scan session cleanup failed"));
    }, 30_000);
    this.timer.unref();
  }

  private async cleanupTarget(target: CleanupTarget): Promise<Error[]> {
    const errors: Error[] = [];
    const attempt = (label: string, operation: () => void): void => {
      try {
        operation();
      } catch {
        errors.push(new Error(`${label} failed.`));
      }
    };

    if (target.wallet) {
      attempt("Scan wallet listener cleanup", () => {
        target.wallet?.removeAllListeners();
      });
      attempt("Scan wallet key cleanup", () => {
        target.wallet?.getViewingKeyPair().privateKey.fill(0);
      });
      attempt("Scan wallet commitment cache cleanup", () => {
        target.wallet?.invalidateCommitmentsCache(target.chain);
      });
      attempt("Scan wallet merkle tree cleanup", () => {
        target.wallet?.unloadUTXOMerkletree(target.version, target.chain);
      });
    }
    const purge = target.purge === true || !this.cache;
    const bytes = target.store.usedBytes;
    if (!purge && this.cache && target.cacheKey && target.cacheMeta) {
      try {
        await this.cache.write(target.cacheKey, {
          ...target.cacheMeta,
          bytes,
          updatedAt: this.now(),
        });
      } catch (error) {
        log.warn(
          `failed to persist scan cache metadata (${target.cacheKey.slice(0, 8)})`,
          error,
        );
      }
    }
    const storageCleanup = await settleCleanup(
      () =>
        purge
          ? target.store.dispose()
          : target.store.close(),
      SCAN_SESSION_STORAGE_CLEANUP_TIMEOUT_MS,
      "Scan storage cleanup timed out.",
    );
    if (!storageCleanup.ok) {
      errors.push(
        storageCleanup.error instanceof Error
          ? storageCleanup.error
          : new Error("Scan storage cleanup failed."),
      );
    }
    if (purge && this.cache && target.cacheKey) {
      try {
        await this.cache.remove(target.cacheKey);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error
            : new Error("Scan cache removal failed."),
        );
      }
    }

    if (errors.length > 0) {
      this.cleanupFailures.set(target, errors);
    } else {
      this.cleanupFailures.delete(target);
    }
    return errors;
  }

  private async remove(
    key: string,
    session: Session,
    purge = false,
  ): Promise<void> {
    if (this.sessions.get(key) === session) {
      this.sessions.delete(key);
    }
    const errors = await this.cleanupTarget({
      wallet: session.wallet,
      store: session.store,
      chain: session.chain,
      version: session.version,
      cacheKey: key,
      cacheMeta: session.cacheMeta
        ? {
            ...session.cacheMeta,
            lastSyncedBlock:
              session.lastSyncedBlock ??
              session.cacheMeta.lastSyncedBlock,
          }
        : undefined,
      purge: purge || this.cache === undefined,
    });
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Remote scan session cleanup was incomplete.",
      );
    }
  }

  private async retryPendingCleanup(): Promise<void> {
    await mapWithConcurrency(
      [...this.cleanupFailures.keys()],
      CLEANUP_CONCURRENCY,
      async (target) => {
        const errors = await this.cleanupTarget(target);
        if (errors.length > 0) {
          log.error(
            "scan session cleanup remains incomplete; retry scheduled",
          );
        }
      },
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.maintenance;
    let release!: () => void;
    this.maintenance = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  prune(): Promise<void> {
    return this.exclusive(() => this.pruneIdle());
  }

  private async pruneIdle(): Promise<void> {
    await this.retryPendingCleanup();
    const now = this.now();
    const expired: Array<[string, Session]> = [];
    for (const [key, session] of this.sessions) {
      if (
        !session.busy &&
        (this.stopped ||
          now - session.lastUsedAt >= (this.options.idleMs ?? 10 * 60_000) ||
          now - session.createdAt >= (this.options.lifetimeMs ?? 30 * 60_000))
      ) {
        expired.push([key, session]);
      }
    }
    await mapWithConcurrency(
      expired,
      CLEANUP_CONCURRENCY,
      async ([key, session]) => {
        try {
          await this.remove(key, session);
        } catch {
          log.error("scan session cleanup failed; retry scheduled");
        }
      },
    );
    if (this.cache && now >= this.nextCacheGcAt) {
      this.nextCacheGcAt = now + CACHE_GC_INTERVAL_MS;
      const active = new Set(this.sessions.keys());
      for (const target of this.cleanupFailures.keys()) {
        if (target.cacheKey) active.add(target.cacheKey);
      }
      try {
        await this.cache.gc(active);
      } catch (error) {
        log.warn("scan cache garbage collection failed", error);
      }
    }
  }

  private async buildWallet(
    store: ScanStore,
    input: {
      key: string;
      chain: Chain;
      version: TXIDVersion;
      tree: Parameters<AbstractWallet["loadUTXOMerkletree"]>[1];
    },
    fromBlock: number,
  ): Promise<AbstractWallet> {
    const birthdays: number[][] = [];
    birthdays[input.chain.type] = [];
    birthdays[input.chain.type]![input.chain.id] = fromBlock;
    const encryptionKey = createHmac("sha256", input.key)
      .update("hushnode-scan-cache-v1")
      .update(`:${input.chain.type}:${input.chain.id}:${input.version}`)
      .digest("hex");
    const wallet = await ViewOnlyWallet.fromShareableViewingKey(
      store,
      encryptionKey,
      input.key,
      fromBlock > 0 ? birthdays : undefined,
      this.options.prover ?? getProver(),
    );
    // Scanning only needs UTXO data; never register this wallet with the engine.
    wallet.refreshPOIsForTXIDVersion = async () => undefined;
    await wallet.loadUTXOMerkletree(input.version, input.tree);
    // Remote scan results only include Shield + V2 transact notes. Skipping
    // legacy/V3 decryption here avoids a large amount of useless ECDH work on
    // Ethereum history without changing the returned note set.
    const scannable = wallet as unknown as CommitmentScannableWallet;
    const scanCommitment = scannable.createScannedDBCommitments.bind(wallet);
    scannable.createScannedDBCommitments = async (
      txidVersion,
      leaf,
      ...args
    ) => {
      if (!REMOTE_SCAN_COMMITMENT_TYPES.has(leaf.commitmentType)) return [];
      return scanCommitment(txidVersion, leaf, ...args);
    };
    return wallet;
  }

  private async scanStateCompatible(
    wallet: AbstractWallet,
    input: {
      chain: Chain;
      version: TXIDVersion;
      tree: Parameters<AbstractWallet["loadUTXOMerkletree"]>[1];
    },
  ): Promise<boolean> {
    const details = await wallet.getWalletDetails(
      input.version,
      input.chain,
    );
    const heights = details.treeScannedHeights ?? [];
    const latestTree = await input.tree.latestTree();
    if (!Number.isSafeInteger(latestTree) || latestTree < 0) return false;

    const checks: Array<[number, number]> = [];
    for (let tree = 0; tree < heights.length; tree += 1) {
      const height = heights[tree] ?? 0;
      if (!Number.isSafeInteger(height) || height < 0) return false;
      if (height === 0) continue;
      if (tree > latestTree) return false;
      checks.push([tree, height]);
    }
    if (checks.length === 0) return true;
    const compatible = await mapWithConcurrency(
      checks,
      SCAN_STATE_READ_CONCURRENCY,
      async ([tree, height]) => {
        const length = await input.tree.getTreeLength(tree);
        return (
          Number.isSafeInteger(length) &&
          length >= 0 &&
          height <= length
        );
      },
    );
    return compatible.every(Boolean);
  }

  private sessionFor(
    wallet: AbstractWallet,
    store: ScanStore,
    input: {
      chain: Chain;
      version: TXIDVersion;
      fromBlock: number;
      lastSyncedBlock?: number;
    },
    cacheMeta?: ScanCacheMeta,
  ): Session {
    const now = this.now();
    return {
      wallet,
      store,
      chain: input.chain,
      version: input.version,
      fromBlock: input.fromBlock,
      lastSyncedBlock: input.lastSyncedBlock,
      cacheMeta,
      createdAt: now,
      lastUsedAt: now,
      busy: false,
    };
  }

  private async openCachedSession(
    input: {
      key: string;
      chain: Chain;
      version: TXIDVersion;
      fromBlock: number;
      lastSyncedBlock?: number;
      tree: Parameters<AbstractWallet["loadUTXOMerkletree"]>[1];
    },
    key: string,
    meta: ScanCacheMeta,
  ): Promise<Session | undefined> {
    const cache = this.cache!;
    let store: ScanStore | undefined;
    try {
      store = await ScanStore.open(
        cache.directoryFor(key),
        this.options.maxBytes,
      );
    } catch (error) {
      if (isLockError(error)) throw error;
      await cache.remove(key);
      return undefined;
    }

    let wallet: AbstractWallet | undefined;
    try {
      wallet = await this.buildWallet(store, input, meta.fromBlock);
    } catch (error) {
      let unhealthy = false;
      try {
        store.assertHealthy();
      } catch {
        unhealthy = true;
      }
      const cleanupErrors = await this.cleanupTarget({
        wallet,
        store,
        chain: input.chain,
        version: input.version,
        cacheKey: key,
        cacheMeta: meta,
        purge: unhealthy,
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          error instanceof Error
            ? error.message
            : "Remote scan cache recovery failed.",
        );
      }
      if (unhealthy) return undefined;
      throw error;
    }

    let compatible: boolean;
    try {
      compatible = await this.scanStateCompatible(wallet, input);
    } catch (error) {
      const cleanupErrors = await this.cleanupTarget({
        wallet,
        store,
        chain: input.chain,
        version: input.version,
        cacheKey: key,
        cacheMeta: meta,
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          error instanceof Error
            ? error.message
            : "Remote scan cache validation failed.",
        );
      }
      throw error;
    }
    if (!compatible) {
      const cleanupErrors = await this.cleanupTarget({
        wallet,
        store,
        chain: input.chain,
        version: input.version,
        cacheKey: key,
        cacheMeta: meta,
        purge: true,
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Remote scan cache recovery was incomplete.",
        );
      }
      return undefined;
    }

    log.debug(`remote scan cache hit (${key.slice(0, 8)})`);
    return this.sessionFor(
      wallet,
      store,
      {
        chain: input.chain,
        version: input.version,
        fromBlock: meta.fromBlock,
        lastSyncedBlock: input.lastSyncedBlock,
      },
      meta,
    );
  }

  private async openFreshSession(
    input: {
      key: string;
      chain: Chain;
      version: TXIDVersion;
      fromBlock: number;
      lastSyncedBlock?: number;
      tree: Parameters<AbstractWallet["loadUTXOMerkletree"]>[1];
    },
    key: string,
  ): Promise<Session> {
    const cache = this.cache;
    let meta: ScanCacheMeta | undefined;
    if (cache) {
      const now = this.now();
      const next: ScanCacheMeta = {
        schemaVersion: SCAN_CACHE_SCHEMA_VERSION,
        chainType: input.chain.type,
        chainId: input.chain.id,
        txidVersion: input.version,
        fromBlock: input.fromBlock,
        lastSyncedBlock: input.lastSyncedBlock ?? null,
        createdAt: now,
        updatedAt: now,
        bytes: 0,
      };
      meta = next;
      await cache.write(key, next);
    }

    let store: ScanStore | undefined;
    let wallet: AbstractWallet | undefined;
    try {
      store = cache
        ? await ScanStore.open(
            cache.directoryFor(key),
            this.options.maxBytes,
          )
        : new ScanStore(this.options.maxBytes);
      wallet = await this.buildWallet(store, input, input.fromBlock);
      return this.sessionFor(wallet, store, input, meta);
    } catch (error) {
      const cleanupErrors = store
        ? await this.cleanupTarget({
            wallet,
            store,
            chain: input.chain,
            version: input.version,
            cacheKey: cache ? key : undefined,
            cacheMeta: meta,
            purge: true,
          })
        : [];
      if (cache && !store && !isLockError(error)) {
        await cache.remove(key).catch(() => undefined);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          error instanceof Error
            ? error.message
            : "Remote scan session creation failed.",
        );
      }
      throw error;
    }
  }

  private async createSession(
    input: {
      key: string;
      chain: Chain;
      version: TXIDVersion;
      fromBlock: number;
      lastSyncedBlock?: number;
      tree: Parameters<AbstractWallet["loadUTXOMerkletree"]>[1];
    },
    key: string,
  ): Promise<Session> {
    if (!this.cache) {
      return this.openFreshSession(input, key);
    }

    const meta = await this.cache.read(key);
    if (
      meta &&
      this.cache.matches(meta, {
        chain: input.chain,
        txidVersion: input.version,
        fromBlock: input.fromBlock,
        lastSyncedBlock: input.lastSyncedBlock,
      })
    ) {
      const session = await this.openCachedSession(input, key, meta);
      if (session) return session;
    } else {
      await this.cache.remove(key);
    }
    return this.openFreshSession(input, key);
  }

  private async hasScanProgress(session: Session): Promise<boolean> {
    try {
      const details = await session.wallet.getWalletDetails(
        session.version,
        session.chain,
      );
      return details.treeScannedHeights.some((height) => height > 0);
    } catch {
      return false;
    }
  }

  /**
   * Admission hint for the HTTP layer. A wallet with a live session or an
   * on-disk bucket is a refresh and should not queue behind a first-time scan.
   * This never opens the wallet; a stale bucket just means the job is cold in
   * practice, which the queue tolerates.
   */
  peekWarm(input: {
    key: string;
    chain: Chain;
    version: TXIDVersion;
  }): boolean {
    const key = sessionKeyFor(input.key, input.chain, input.version);
    if (this.sessions.has(key)) return true;
    return this.cache?.has(key) ?? false;
  }

  async use<T>(
    input: {
      key: string;
      chain: Chain;
      version: TXIDVersion;
      fromBlock: number;
      lastSyncedBlock?: number;
      tree: Parameters<AbstractWallet["loadUTXOMerkletree"]>[1];
    },
    operation: (session: Pick<Session, "wallet" | "store">) => Promise<T>,
  ): Promise<T> {
    const [key, session] = await this.exclusive(async () => {
      await this.pruneIdle();
      if (this.stopped) throw new Error("Remote scanner is stopped.");
      const key = sessionKeyFor(input.key, input.chain, input.version);
      let session = this.sessions.get(key);
      if (session?.busy)
        throw new Error("This wallet is already being scanned.");
      if (session && input.fromBlock < session.fromBlock) {
        await this.remove(key, session, true);
        session = undefined;
      }
      if (
        session &&
        input.lastSyncedBlock !== undefined &&
        session.lastSyncedBlock !== undefined &&
        input.lastSyncedBlock < session.lastSyncedBlock
      ) {
        await this.remove(key, session, true);
        session = undefined;
      }
      if (!session) {
        const maxSessions = this.options.maxSessions ?? 4;
        while (
          this.sessions.size + this.cleanupFailures.size >=
          maxSessions
        ) {
          const oldest = [...this.sessions]
            .filter(([, value]) => !value.busy)
            .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
          if (!oldest)
            throw new Error("Remote scan session capacity exceeded.");
          await this.remove(...oldest);
        }
        session = await this.createSession(input, key);
        this.sessions.set(key, session);
      }
      session.busy = true;
      if (input.lastSyncedBlock !== undefined) {
        session.lastSyncedBlock = Math.max(
          session.lastSyncedBlock ?? 0,
          input.lastSyncedBlock,
        );
      }
      return [key, session] as const;
    });
    try {
      const result = await operation(session);
      session.store.assertHealthy();
      session.lastUsedAt = this.now();
      return result;
    } catch (error) {
      try {
        let storeFailed = false;
        try {
          session.store.assertHealthy();
        } catch {
          storeFailed = true;
        }
        const keepProgress = !storeFailed && (await this.hasScanProgress(session));
        await this.exclusive(() =>
          this.remove(key, session, !keepProgress),
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          error instanceof Error ? error.message : "Remote scan failed.",
        );
      }
      throw error;
    } finally {
      await this.exclusive(async () => {
        session.busy = false;
        await this.pruneIdle();
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.prune();
    const failures = [...this.cleanupFailures.values()].flat();
    if (this.sessions.size > 0) {
      failures.push(new Error("Remote scan sessions are still in use."));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Remote scan session cleanup was incomplete.",
      );
    }
  }
}
