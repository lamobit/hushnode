import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Database,
  Prover,
  RailgunWallet,
  ShieldNote,
  type AbstractWallet,
} from "@railgun-community/engine";
import { ChainType, TXIDVersion } from "@railgun-community/shared-models";
import { ScanStore } from "../src/railgun/scan-store.js";
import {
  SCAN_SESSION_STORAGE_CLEANUP_TIMEOUT_MS,
  ScanWallets,
} from "../src/railgun/scan-wallets.js";

const require = createRequire(import.meta.url);
const sdk = createRequire(require.resolve("@railgun-community/engine"));
const { UTXOMerkletree } = sdk(
  path.join(
    path.dirname(require.resolve("@railgun-community/engine")),
    "merkletree/utxo-merkletree.js",
  ),
);
const { initPoseidonPromise } = sdk(
  path.join(
    path.dirname(require.resolve("@railgun-community/engine")),
    "utils/poseidon.js",
  ),
);
const msgpack = sdk("msgpack-lite") as {
  encode: (value: unknown) => Buffer;
};
const prover = new Prover({
  assertArtifactExists() {
    throw new Error("No proving in scan tests");
  },
  async getArtifacts() {
    throw new Error("No proving in scan tests");
  },
  async getArtifactsPOI() {
    throw new Error("No proving in scan tests");
  },
});
const chain = { type: ChainType.EVM, id: 42161 };
const version = TXIDVersion.V2_PoseidonMerkle;

const fixture = async () => {
  await initPoseidonPromise;
  const publicDB = new ScanStore();
  const seedDB = new ScanStore();
  const owner = await RailgunWallet.fromMnemonic(
    seedDB,
    "33".repeat(32),
    "test test test test test test test test test test test junk",
    0,
    undefined,
    prover,
  );
  const key = owner.generateShareableViewingKey();
  const tree = await UTXOMerkletree.create(
    publicDB,
    chain,
    version,
    async () => true,
  );
  await seedDB.dispose();
  return { publicDB, owner, key, tree };
};

const seedShieldNote = async (
  owner: Awaited<ReturnType<typeof fixture>>["owner"],
  tree: Awaited<ReturnType<typeof fixture>>["tree"],
): Promise<void> => {
  const token = {
    tokenType: 0,
    tokenAddress: "0x" + "44".repeat(20),
    tokenSubID: "0".repeat(64),
  };
  // ShieldNote is abstract only in its declaration; runtime construction is supported.
  const note = new (ShieldNote as unknown as new (
    ...args: unknown[]
  ) => ShieldNote)(owner.masterPublicKey, "55".repeat(16), 123456n, token);
  const serialized = await note.serialize(
    Buffer.from("66".repeat(32), "hex"),
    owner.getViewingKeyPair().pubkey,
  );
  const leaf = {
    commitmentType: "ShieldCommitment",
    hash: ShieldNote.getShieldNoteHash(
      note.notePublicKey,
      note.tokenHash,
      note.value,
    )
      .toString(16)
      .padStart(64, "0"),
    preImage: {
      ...serialized.preimage,
      value: note.value.toString(16).padStart(32, "0"),
    },
    encryptedBundle: serialized.ciphertext.encryptedBundle,
    shieldKey: serialized.ciphertext.shieldKey,
    txid: "77".repeat(32),
    blockNumber: 100,
    utxoTree: 0,
    utxoIndex: 0,
    fee: "0",
  };
  await tree.queueLeaves(0, 0, [leaf]);
  await tree.updateTreesFromWriteQueue();
};

test("private store rejects oversized writes atomically and cannot be reused after disposal", async () => {
  const db = new ScanStore(200);
  try {
    await db.put(["01"], "aa");
    const bytes = db.usedBytes;
    await assert.rejects(
      db.batch([
        { type: "put", key: Database.pathToKey(["02"]), value: "bb" },
        {
          type: "put",
          key: Database.pathToKey(["03"]),
          value: "cc".repeat(300),
        },
      ]),
      /storage limit/,
    );
    assert.equal(db.usedBytes, bytes);
    await assert.rejects(db.get(["02"]));
  } finally {
    await db.dispose();
  }
  assert.equal(db.usedBytes, 0);
  await assert.rejects(db.put(["04"], "aa"), /closed/);
});

test("private store serializes concurrent writes and keeps its capacity ledger exact", async () => {
  const db = new ScanStore(1_024);
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        db.put([index.toString(16).padStart(2, "0")], "aa"),
      ),
    );
    assert.equal(db.usedBytes, 12 * 65);
  } finally {
    await db.dispose();
  }

  const bounded = new ScanStore(650);
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        bounded.put([index.toString(16).padStart(2, "0")], "aa"),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      10,
    );
    assert.equal(bounded.usedBytes, 650);
  } finally {
    await bounded.dispose();
  }
});

test("private store does not commit capacity after a failed underlying write", async () => {
  const db = new ScanStore(1_024);
  const level = db.level as unknown as {
    put: (...args: unknown[]) => Promise<void>;
  };
  const original = level.put.bind(db.level);
  level.put = async () => {
    throw new Error("simulated disk failure");
  };
  try {
    await assert.rejects(db.put(["01"], "aa"), /Failed to put value/);
    assert.equal(db.usedBytes, 0);
    await assert.rejects(db.put(["02"], "bb"));
  } finally {
    level.put = original;
    await db.dispose();
  }
  assert.equal(db.usedBytes, 0);
  assert.equal(db.isClosed(), true);
});

test("real SDK scanning stores decrypted notes only in the private store and refreshes old spends", async () => {
  const { publicDB, owner, key, tree } = await fixture();
  const sessions = new ScanWallets({ prover });
  let privateDB!: ScanStore;
  try {
    const token = {
      tokenType: 0,
      tokenAddress: "0x" + "44".repeat(20),
      tokenSubID: "0".repeat(64),
    };
    // ShieldNote is abstract only in its declaration; runtime construction is supported.
    const note = new (ShieldNote as unknown as new (
      ...args: unknown[]
    ) => ShieldNote)(owner.masterPublicKey, "55".repeat(16), 123456n, token);
    const serialized = await note.serialize(
      Buffer.from("66".repeat(32), "hex"),
      owner.getViewingKeyPair().pubkey,
    );
    const leaf = {
      commitmentType: "ShieldCommitment",
      hash: ShieldNote.getShieldNoteHash(
        note.notePublicKey,
        note.tokenHash,
        note.value,
      )
        .toString(16)
        .padStart(64, "0"),
      preImage: {
        ...serialized.preimage,
        value: note.value.toString(16).padStart(32, "0"),
      },
      encryptedBundle: serialized.ciphertext.encryptedBundle,
      shieldKey: serialized.ciphertext.shieldKey,
      txid: "77".repeat(32),
      blockNumber: 100,
      utxoTree: 0,
      utxoIndex: 0,
      fee: "0",
    };
    await tree.queueLeaves(0, 0, [leaf]);
    await tree.updateTreesFromWriteQueue();
    const input = { key, chain, version, fromBlock: 0, tree };
    let nullifier = "";
    await sessions.use(input, async ({ wallet, store }) => {
      privateDB = store;
      await wallet.decryptBalances(version, chain, undefined, true);
      const txos = await wallet.TXOs(version, chain);
      assert.equal(txos.length, 1);
      assert.equal(txos[0]!.note.value, 123456n);
      nullifier = txos[0]!.nullifier;
    });
    const walletPrefix = [Buffer.from("wallet").toString("hex")];
    assert.equal((await publicDB.getNamespaceKeys(walletPrefix)).length, 0);
    assert.ok((await privateDB.getNamespaceKeys(walletPrefix)).length > 0);
    tree.getNullifierTxid = async (value: string) =>
      value === nullifier ? "88".repeat(32) : undefined;
    await sessions.use(input, async ({ wallet }) => {
      assert.equal(
        (wallet as unknown as { db: ScanStore }).db,
        privateDB,
      );
      wallet.invalidateCommitmentsCache(chain);
      assert.equal(
        (await wallet.TXOs(version, chain))[0]!.spendtxid,
        "88".repeat(32),
      );
    });
  } finally {
    await sessions.stop();
    await publicDB.dispose();
  }
  assert.equal(privateDB.usedBytes, 0);
  assert.equal(privateDB.isClosed(), true);
});

test("remote scan wallets skip commitment types their result cannot include", async () => {
  const { publicDB, key, tree } = await fixture();
  const sessions = new ScanWallets({ prover });
  try {
    await sessions.use(
      { key, chain, version, fromBlock: 0, tree },
      async ({ wallet }) => {
        const scannable = wallet as unknown as {
          createScannedDBCommitments: (
            txidVersion: TXIDVersion,
            leaf: { commitmentType: string },
            ...args: unknown[]
          ) => Promise<unknown[]>;
        };
        assert.deepEqual(
          await scannable.createScannedDBCommitments(version, {
            commitmentType: "LegacyGeneratedCommitment",
          }),
          [],
        );
      },
    );
  } finally {
    await sessions.stop();
    await publicDB.dispose();
  }
});

test("session eviction, lifetime, earlier birthdays and failure release keys and storage", async () => {
  const { publicDB, key, tree } = await fixture();
  let now = 0;
  const sessions = new ScanWallets({
    prover,
    maxSessions: 1,
    idleMs: 10,
    lifetimeMs: 20,
    now: () => now,
  });
  const input = { key, chain, version, fromBlock: 100, tree };
  let original!: AbstractWallet;
  let store!: ScanStore;
  try {
    await sessions.use(input, async (session) => {
      original = session.wallet;
      store = session.store;
    });
    now = 5;
    await sessions.use(input, async ({ wallet }) =>
      assert.equal(wallet, original),
    );
    await sessions.use({ ...input, fromBlock: 0 }, async ({ wallet }) =>
      assert.notEqual(wallet, original),
    );
    assert.ok(
      original.getViewingKeyPair().privateKey.every((byte) => byte === 0),
    );
    assert.equal(store.isClosed(), true);
    await sessions.use(input, async (session) => {
      original = session.wallet;
      store = session.store;
    });
    now = 16;
    await sessions.prune();
    assert.equal(store.isClosed(), true);
    await sessions.use(input, async (session) => {
      original = session.wallet;
      store = session.store;
    });
    await assert.rejects(
      sessions.use(input, async () => {
        throw new Error("scan failed");
      }),
      /scan failed/,
    );
    assert.equal(store.isClosed(), true);
  } finally {
    await sessions.stop();
    await publicDB.dispose();
  }
});

test("concurrent session acquisition cannot exceed capacity or reuse a busy wallet", async () => {
  const { publicDB, key, tree } = await fixture();
  const sessions = new ScanWallets({ prover, maxSessions: 1 });
  const input = { key, chain, version, fromBlock: 0, tree };
  let release!: () => void;
  let acquired!: () => void;
  const started = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const task = sessions.use(input, async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  try {
    await started;
    await assert.rejects(
      sessions.use(input, async () => undefined),
      /already being scanned/,
    );
    await assert.rejects(
      sessions.use(
        { ...input, chain: { ...chain, id: 1 } },
        async () => undefined,
      ),
      /capacity/,
    );
  } finally {
    release();
    await task;
    await sessions.stop();
    await publicDB.dispose();
  }
});

test("LRU eviction and absolute lifetime apply even to repeatedly used sessions", async () => {
  const { publicDB, key, tree } = await fixture();
  let now = 0;
  const sessions = new ScanWallets({
    prover,
    maxSessions: 1,
    idleMs: 100,
    lifetimeMs: 10,
    now: () => now,
  });
  const input = { key, chain, version, fromBlock: 0, tree };
  let store!: ScanStore;
  try {
    await sessions.use(input, async (session) => {
      store = session.store;
    });
    now = 9;
    await sessions.use(input, async (session) =>
      assert.equal(session.store, store),
    );
    now = 10;
    await sessions.prune();
    assert.equal(store.isClosed(), true);
    await sessions.use(input, async (session) => {
      store = session.store;
    });
    await sessions.use(
      { ...input, chain: { ...chain, id: 1 } },
      async ({ store: next }) => {
        assert.notEqual(next, store);
        assert.equal(store.isClosed(), true);
      },
    );
  } finally {
    await sessions.stop();
    await publicDB.dispose();
  }
});

test("session cleanup continues after a failing step and is retried", async () => {
  const { publicDB, key, tree } = await fixture();
  const sessions = new ScanWallets({ prover, maxSessions: 1 });
  const input = { key, chain, version, fromBlock: 0, tree };
  let wallet!: AbstractWallet;
  let store!: ScanStore;
  try {
    await sessions.use(input, async (session) => {
      wallet = session.wallet;
      store = session.store;
    });
    const originalRemoveListeners =
      wallet.removeAllListeners.bind(wallet);
    (
      wallet as unknown as { removeAllListeners: () => void }
    ).removeAllListeners = () => {
      throw new Error("simulated listener cleanup failure");
    };

    await assert.rejects(
      sessions.use(input, async () => {
        throw new Error("scan failed");
      }),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.message === "scan failed",
    );
    assert.ok(
      wallet
        .getViewingKeyPair()
        .privateKey.every((byte) => byte === 0),
    );
    assert.equal(store.isClosed(), true);
    await assert.rejects(
      sessions.use(input, async () => undefined),
      /capacity/,
    );

    (
      wallet as unknown as { removeAllListeners: () => void }
    ).removeAllListeners = originalRemoveListeners;
    await sessions.prune();
    await sessions.use(input, async () => undefined);
  } finally {
    await sessions.stop();
    await publicDB.dispose();
  }
});

test("stop bounds storage cleanup and preserves its failure", async (context) => {
  const { publicDB, key, tree } = await fixture();
  const sessions = new ScanWallets({ prover });
  const input = { key, chain, version, fromBlock: 0, tree };
  let wallet!: AbstractWallet;
  let store!: ScanStore;
  try {
    await sessions.use(input, async (session) => {
      wallet = session.wallet;
      store = session.store;
    });
    const dispose = store.dispose.bind(store);
    store.dispose = async () => new Promise<void>(() => undefined);
    context.mock.timers.enable({ apis: ["setTimeout"] });

    const stopping = sessions.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(SCAN_SESSION_STORAGE_CLEANUP_TIMEOUT_MS);
    await assert.rejects(stopping, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /session cleanup was incomplete/);
      assert.ok(
        error.errors.some(
          (cause) =>
            cause instanceof Error &&
            /storage cleanup timed out/.test(cause.message),
        ),
      );
      return true;
    });
    assert.ok(
      wallet
        .getViewingKeyPair()
        .privateKey.every((byte) => byte === 0),
    );

    store.dispose = dispose;
    await sessions.stop();
    assert.equal(store.isClosed(), true);
    assert.equal(store.usedBytes, 0);
  } finally {
    await publicDB.dispose();
  }
});

test("stop reports sessions that are still busy", async () => {
  const { publicDB, key, tree } = await fixture();
  const sessions = new ScanWallets({ prover });
  const input = { key, chain, version, fromBlock: 0, tree };
  let release!: () => void;
  let acquired!: () => void;
  const started = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const task = sessions.use(input, async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });

  try {
    await started;
    await assert.rejects(
      sessions.stop(),
      /session cleanup was incomplete/,
    );
    release();
    await task;
    await sessions.stop();
  } finally {
    release();
    await task;
    await publicDB.dispose();
  }
});

const scanCacheKey = (key: string): string =>
  createHash("sha256")
    .update(key)
    .update(`:${chain.type}:${chain.id}:${version}`)
    .digest("hex");

const metaPathFor = (rootDir: string, key: string): string => {
  const cacheKey = scanCacheKey(key);
  return path.join(
    rootDir,
    cacheKey.slice(0, 2),
    cacheKey,
    "meta.json",
  );
};

test("disk cache resumes completed scans across session restarts", async () => {
  const { publicDB, owner, key, tree } = await fixture();
  await seedShieldNote(owner, tree);
  const rootDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hush-scan-wallets-"),
  );
  let now = 0;
  const options = {
    prover,
    idleMs: 10,
    lifetimeMs: 1_000,
    maxSessions: 1,
    now: () => now,
    cache: { rootDir, ttlMs: 60_000 },
  };
  const first = new ScanWallets(options);
  const input = { key, chain, version, fromBlock: 0, tree };
  let firstStore!: ScanStore;
  try {
    await first.use(input, async ({ wallet, store }) => {
      firstStore = store;
      await wallet.decryptBalances(version, chain, undefined, true);
      assert.equal((await wallet.TXOs(version, chain)).length, 1);
    });
    const metaPath = metaPathFor(rootDir, key);
    const metaAfterScan = JSON.parse(
      await fs.promises.readFile(metaPath, "utf8"),
    ) as { bytes: number };

    now = 11;
    await first.prune();
    assert.equal(firstStore.isClosed(), true);
    const savedMeta = JSON.parse(
      await fs.promises.readFile(metaPath, "utf8"),
    ) as { bytes: number };
    assert.ok(savedMeta.bytes > 0);
    assert.equal(metaAfterScan.bytes, 0);

    const second = new ScanWallets({ ...options, now: () => 20 });
    try {
      let progressCalls = 0;
      await second.use(input, async ({ wallet, store }) => {
        assert.notEqual(store, firstStore);
        await wallet.decryptBalances(
          version,
          chain,
          () => {
            progressCalls += 1;
          },
          true,
        );
        assert.equal(progressCalls, 0);
        assert.equal((await wallet.TXOs(version, chain)).length, 1);
      });
    } finally {
      await second.stop();
    }
  } finally {
    await first.stop();
    await publicDB.dispose();
    await fs.promises.rm(rootDir, {
      recursive: true,
      force: true,
    });
  }
});

test("disk cache rebuilds when the requested birthday is earlier", async () => {
  const { publicDB, owner, key, tree } = await fixture();
  await seedShieldNote(owner, tree);
  const rootDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hush-scan-wallets-"),
  );
  const first = new ScanWallets({
    prover,
    cache: { rootDir, ttlMs: 60_000 },
  });
  let firstStore!: ScanStore;
  try {
    const laterBirthday = { key, chain, version, fromBlock: 100, tree };
    await first.use(laterBirthday, async ({ wallet, store }) => {
      firstStore = store;
      await wallet.decryptBalances(version, chain, undefined, true);
      assert.equal((await wallet.TXOs(version, chain)).length, 1);
    });
    await first.stop();

    const metaPath = metaPathFor(rootDir, key);
    const originalMeta = JSON.parse(
      await fs.promises.readFile(metaPath, "utf8"),
    ) as { fromBlock: number };
    assert.equal(originalMeta.fromBlock, 100);

    const second = new ScanWallets({
      prover,
      cache: { rootDir, ttlMs: 60_000 },
    });
    try {
      let progressCalls = 0;
      await second.use(
        { ...laterBirthday, fromBlock: 50 },
        async ({ wallet, store }) => {
          assert.notEqual(store, firstStore);
          await wallet.decryptBalances(
            version,
            chain,
            () => {
              progressCalls += 1;
            },
            true,
          );
          assert.ok(progressCalls > 0);
          assert.equal((await wallet.TXOs(version, chain)).length, 1);
        },
      );
    } finally {
      await second.stop();
    }
    const rebuiltMeta = JSON.parse(
      await fs.promises.readFile(metaPath, "utf8"),
    ) as { fromBlock: number };
    assert.equal(rebuiltMeta.fromBlock, 50);
  } finally {
    await publicDB.dispose();
    await fs.promises.rm(rootDir, {
      recursive: true,
      force: true,
    });
  }
});

test("disk cache rejects heights beyond the current tree length", async () => {
  const { publicDB, owner, key, tree } = await fixture();
  await seedShieldNote(owner, tree);
  const rootDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hush-scan-wallets-"),
  );
  const first = new ScanWallets({
    prover,
    cache: { rootDir, ttlMs: 60_000 },
  });
  const input = { key, chain, version, fromBlock: 0, tree };
  let firstStore!: ScanStore;
  try {
    await first.use(input, async ({ wallet, store }) => {
      firstStore = store;
      await wallet.decryptBalances(version, chain, undefined, true);
      const details = await wallet.getWalletDetails(version, chain);
      const detailsMap = await wallet.getWalletDetailsMap(chain);
      detailsMap[version] = {
        ...details,
        treeScannedHeights: [2],
      };
      await store.put(
        wallet.getWalletDetailsPath(chain),
        msgpack.encode(detailsMap),
      );
    });
    await first.stop();

    const second = new ScanWallets({
      prover,
      cache: { rootDir, ttlMs: 60_000 },
    });
    try {
      let progressCalls = 0;
      await second.use(input, async ({ wallet, store }) => {
        assert.notEqual(store, firstStore);
        await wallet.decryptBalances(
          version,
          chain,
          () => {
            progressCalls += 1;
          },
          true,
        );
        assert.ok(progressCalls > 0);
        assert.equal((await wallet.TXOs(version, chain)).length, 1);
      });
    } finally {
      await second.stop();
    }
  } finally {
    await publicDB.dispose();
    await fs.promises.rm(rootDir, {
      recursive: true,
      force: true,
    });
  }
});
