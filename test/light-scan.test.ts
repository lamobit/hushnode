import assert from "node:assert/strict";
import test from "node:test";
import {
  NetworkName,
  RailgunProxyDeploymentBlock,
  TXIDVersion,
} from "@railgun-community/shared-models";
import {
  loadRemoteScanTreeLengths,
  mapRemoteScanNotes,
  MAX_REMOTE_SCAN_TREES,
  nextScanCursor,
  parseShareableViewingKey,
  RemoteScanService,
  REMOTE_SCAN_STOP_TIMEOUT_MS,
  ScanApiError,
  walletTreeScanComplete,
  type RailgunTxo,
  type RemoteScanNote,
  type RemoteScanRunner,
} from "../src/light-scan.js";
import {
  normalizeRemoteScanResult,
  type RemoteScanResult,
} from "../src/railgun/scan-result.js";

const VIEWING_PRIVATE_KEY = "11".repeat(32);
const SPENDING_PUBLIC_KEY = "22".repeat(32);
const msgpackStr8 = (value: string): string =>
  `d940${Buffer.from(value, "utf8").toString("hex")}`;
const SHAREABLE_KEY =
  "82" +
  "a5" +
  Buffer.from("vpriv", "utf8").toString("hex") +
  msgpackStr8(VIEWING_PRIVATE_KEY) +
  "a4" +
  Buffer.from("spub", "utf8").toString("hex") +
  msgpackStr8(SPENDING_PUBLIC_KEY);
const SHAREABLE_KEY_2 =
  "82" +
  "a5" +
  Buffer.from("vpriv", "utf8").toString("hex") +
  msgpackStr8("33".repeat(32)) +
  "a4" +
  Buffer.from("spub", "utf8").toString("hex") +
  msgpackStr8("44".repeat(32));
const SHAREABLE_KEY_3 =
  "82" +
  "a5" +
  Buffer.from("vpriv", "utf8").toString("hex") +
  msgpackStr8("55".repeat(32)) +
  "a4" +
  Buffer.from("spub", "utf8").toString("hex") +
  msgpackStr8("66".repeat(32));
const SHAREABLE_KEY_4 =
  "82" +
  "a5" +
  Buffer.from("vpriv", "utf8").toString("hex") +
  msgpackStr8("77".repeat(32)) +
  "a4" +
  Buffer.from("spub", "utf8").toString("hex") +
  msgpackStr8("88".repeat(32));
const TOKEN = "scan-token-0123456789abcdef";

const note = (leaf = 0): RemoteScanNote => ({
  tree: 0,
  leaf,
  hash: "aa".repeat(32),
  blockNumber: 123,
  txid: "0x" + "bb".repeat(32),
  kind: "transact",
  commitmentType: "TransactCommitmentV2",
  tokenHash: "00".repeat(12) + "cc".repeat(20),
  value: "1000",
  random: "dd".repeat(15),
  senderRandom: null,
  memo: null,
  nullifier: "ee".repeat(32),
  spent: false,
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForDone = async (
  service: RemoteScanService,
  jobId: string,
): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (["queued", "running"].includes(service.status(jobId).status)) {
    if (Date.now() > deadline) throw new Error("scan job did not finish");
    await wait(5);
  }
};

test("parses the fixed shareable viewing key encoding", () => {
  const parsed = parseShareableViewingKey(SHAREABLE_KEY.toUpperCase());
  assert.equal(parsed.viewingPrivateKey, VIEWING_PRIVATE_KEY);
  assert.equal(parsed.spendingPublicKey, SPENDING_PUBLIC_KEY);
  assert.equal(parsed.canonical, SHAREABLE_KEY);
});

test("accepts bin and wide-length msgpack encodings", () => {
  const msgpackBin8 = (hex: string): string =>
    `c420${hex}`;
  const binEncoded =
    "82" +
    "a5" +
    Buffer.from("vpriv", "utf8").toString("hex") +
    msgpackBin8(VIEWING_PRIVATE_KEY) +
    "a4" +
    Buffer.from("spub", "utf8").toString("hex") +
    msgpackBin8(SPENDING_PUBLIC_KEY);
  const fromBin = parseShareableViewingKey(binEncoded);
  assert.equal(fromBin.viewingPrivateKey, VIEWING_PRIVATE_KEY);
  assert.equal(fromBin.spendingPublicKey, SPENDING_PUBLIC_KEY);
  assert.equal(fromBin.canonical, SHAREABLE_KEY);

  const str16Encoded =
    "82" +
    "a5" +
    Buffer.from("vpriv", "utf8").toString("hex") +
    "da0040" +
    Buffer.from(VIEWING_PRIVATE_KEY, "utf8").toString("hex") +
    "a4" +
    Buffer.from("spub", "utf8").toString("hex") +
    "da0040" +
    Buffer.from(SPENDING_PUBLIC_KEY, "utf8").toString("hex");
  const fromStr16 = parseShareableViewingKey(str16Encoded);
  assert.equal(fromStr16.canonical, SHAREABLE_KEY);
});

test("accepts textual vpriv and spub pairs", () => {
  const json = JSON.stringify({
    vpriv: VIEWING_PRIVATE_KEY,
    spub: SPENDING_PUBLIC_KEY,
  });
  assert.equal(parseShareableViewingKey(json).canonical, SHAREABLE_KEY);
  const query = `vpriv=${VIEWING_PRIVATE_KEY}&spub=${SPENDING_PUBLIC_KEY}`;
  assert.equal(parseShareableViewingKey(query).canonical, SHAREABLE_KEY);
});

test("accepts raw 32-byte key pairs from stale clients", () => {
  const viewing = Buffer.from(VIEWING_PRIVATE_KEY, "hex");
  const spending = Buffer.from(SPENDING_PUBLIC_KEY, "hex");
  const raw = Buffer.concat([viewing, spending]).toString("hex");
  assert.equal(parseShareableViewingKey(raw).canonical, SHAREABLE_KEY);

  const withHeader = `82${raw}`;
  assert.equal(parseShareableViewingKey(withHeader).canonical, SHAREABLE_KEY);
});

test("accepts the 80-byte broken string/raw viewing key", () => {
  const legacy = Buffer.concat([
    Buffer.from("82a57670726976d940", "hex"),
    Buffer.from(VIEWING_PRIVATE_KEY, "hex"),
    Buffer.from("a473707562d940", "hex"),
    Buffer.from(SPENDING_PUBLIC_KEY, "hex"),
  ]);
  assert.equal(legacy.length, 80);
  assert.equal(
    parseShareableViewingKey(legacy.toString("hex")).canonical,
    SHAREABLE_KEY,
  );
});

test("rejects malformed shareable viewing keys", () => {
  assert.throws(
    () => parseShareableViewingKey(SHAREABLE_KEY.slice(0, -2)),
    (error) =>
      error instanceof ScanApiError &&
      error.code === "INVALID_SHAREABLE_VIEWING_KEY",
  );
  assert.throws(
    () => parseShareableViewingKey(SHAREABLE_KEY + "00"),
    (error) =>
      error instanceof ScanApiError &&
      error.code === "INVALID_SHAREABLE_VIEWING_KEY",
  );
  assert.throws(
    () =>
      parseShareableViewingKey(
        "82a5" +
          Buffer.from("vpriv", "utf8").toString("hex") +
          msgpackStr8(VIEWING_PRIVATE_KEY),
      ),
    (error) =>
      error instanceof ScanApiError &&
      error.code === "INVALID_SHAREABLE_VIEWING_KEY",
  );
  assert.throws(
    () => parseShareableViewingKey("82c0c0"),
    (error) =>
      error instanceof ScanApiError &&
      error.code === "INVALID_SHAREABLE_VIEWING_KEY",
  );
});

test("viewing key errors do not echo key material", () => {
  for (const partialKey of [
    "11".repeat(31),
    `82${"11".repeat(31)}`,
  ]) {
    assert.throws(
      () => parseShareableViewingKey(partialKey),
      (error) =>
        error instanceof ScanApiError &&
        !error.message.includes("0x11") &&
        !error.message.includes(partialKey.slice(0, 8)),
    );
  }
});

test("maps railgun TXOs into portable notes", () => {
  const base: RailgunTxo = {
    tree: 3,
    position: 7,
    txid: "0x" + "ab".repeat(32),
    blockNumber: 456,
    spendtxid: false,
    nullifier: "0x" + "cd".repeat(32),
    commitmentType: "TransactCommitmentV2",
    note: {
      hash: 123n,
      random: "ef".repeat(15),
      value: 9_000n,
      memoText: "hello",
      senderRandom: "01".repeat(15),
      tokenData: {
        tokenType: 0,
        tokenAddress: "0x" + "12".repeat(20),
        tokenSubID: "0x00",
      },
    },
  };
  const mapped = mapRemoteScanNotes([base], true);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]?.leaf, 7);
  assert.equal(mapped[0]?.hash, 123n.toString(16).padStart(64, "0"));
  assert.equal(mapped[0]?.tokenHash, "00".repeat(12) + "12".repeat(20));
  assert.equal(mapped[0]?.value, "9000");
  assert.equal(mapped[0]?.memo, "hello");
  assert.equal(mapped[0]?.spent, false);

  const nft = {
    ...base,
    note: {
      ...base.note,
      tokenData: { ...base.note.tokenData, tokenType: 1 },
    },
  };
  const legacy = { ...base, commitmentType: "LegacyGeneratedCommitment" };
  const spent = { ...base, spendtxid: "0x" + "33".repeat(32) };
  assert.equal(mapRemoteScanNotes([nft, legacy], true).length, 0);
  assert.equal(mapRemoteScanNotes([spent], false).length, 0);
  assert.equal(mapRemoteScanNotes([spent], true)[0]?.spent, true);
  assert.equal(
    mapRemoteScanNotes([base, { ...base, position: 8 }], true, 2).length,
    2,
  );
  assert.throws(
    () =>
      mapRemoteScanNotes(
        [base, { ...base, position: 8 }, { ...base, position: 9 }],
        true,
        2,
      ),
    /note limit/,
  );
});

test("runner results are normalized to known note fields", () => {
  const result = normalizeRemoteScanResult(
    {
      notes: [{ ...note(), extra: "must not be published" }],
      nextFromBlock: 123,
    },
    100,
  );
  assert.equal(result.notes.length, 1);
  assert.equal("extra" in result.notes[0]!, false);
  assert.equal(result.nextFromBlock, 123);
  assert.throws(
    () =>
      normalizeRemoteScanResult(
        { notes: [], nextFromBlock: -1 },
        100,
      ),
    /nextFromBlock/,
  );
});

test("runner normalization rejects sparse and oversized note fields", () => {
  const sparseNotes = Array(2) as RemoteScanNote[];
  sparseNotes[0] = note(0);
  assert.throws(
    () =>
      normalizeRemoteScanResult(
        { notes: sparseNotes, nextFromBlock: null },
        100,
      ),
    /note 1 must be an object/,
  );
  assert.throws(
    () =>
      normalizeRemoteScanResult(
        {
          notes: [{ ...note(), random: "a".repeat(129) }],
          nextFromBlock: null,
        },
        100,
      ),
    /random has an invalid encoding/,
  );
  assert.throws(
    () =>
      normalizeRemoteScanResult(
        {
          notes: [{ ...note(), value: "9".repeat(78) }],
          nextFromBlock: null,
        },
        100,
      ),
    /value has an invalid value/,
  );
});

test("recognizes an already-scanned wallet without progress callbacks", () => {
  assert.equal(
    walletTreeScanComplete(
      { treeScannedHeights: [10, 20, 5] },
      [10, 20, 5],
    ),
    true,
  );
  assert.equal(
    walletTreeScanComplete(
      { treeScannedHeights: [10, 19, 5] },
      [10, 20, 5],
    ),
    false,
  );
});

test("ignores trees intentionally skipped by the creation tree", () => {
  assert.equal(
    walletTreeScanComplete(
      { treeScannedHeights: [0, 0, 8], creationTree: 2 },
      [50, 60, 8],
    ),
    true,
  );
  assert.equal(
    walletTreeScanComplete(
      { treeScannedHeights: [0, 0, 7], creationTree: 2 },
      [50, 60, 8],
    ),
    false,
  );
});

test("tree length reads reject invalid pointers and bound database fan-out", async () => {
  let active = 0;
  let maxActive = 0;
  const tree = {
    async getTreeLength(index: number) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(1);
      active -= 1;
      return index + 1;
    },
  };

  const lengths = await loadRemoteScanTreeLengths(tree, 63);
  assert.equal(lengths.length, 64);
  assert.equal(lengths[0], 1);
  assert.equal(lengths[63], 64);
  assert.ok(maxActive > 1);
  assert.ok(maxActive <= 16);

  let reads = 0;
  await assert.rejects(
    loadRemoteScanTreeLengths(
      {
        async getTreeLength() {
          reads += 1;
          return 1;
        },
      },
      MAX_REMOTE_SCAN_TREES,
    ),
    /invalid tree pointer/,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    loadRemoteScanTreeLengths(tree, -1),
    /invalid tree pointer/,
  );
  await assert.rejects(
    loadRemoteScanTreeLengths(
      { getTreeLength: async () => 65_537 },
      0,
    ),
    /invalid tree length/,
  );
});

test("authorizes scan tokens in constant-time comparison", () => {
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async () => ({ notes: [], nextFromBlock: null }),
  });
  service.authorize(`Bearer ${TOKEN}`);
  assert.throws(
    () => service.authorize("Bearer wrong-token"),
    (error) =>
      error instanceof ScanApiError &&
      error.status === 401 &&
      error.code === "SCAN_UNAUTHORIZED",
  );
  assert.throws(
    () => service.authorize(undefined),
    (error) =>
      error instanceof ScanApiError &&
      error.code === "SCAN_UNAUTHORIZED",
  );
  void service.stop();
});

test("only reports a resumable cursor once the synced head covers the request", () => {
  assert.equal(nextScanCursor(100, 500), 500);
  assert.equal(nextScanCursor(100, 100), 100);
  assert.equal(nextScanCursor(100, 99), null);
  assert.equal(nextScanCursor(100, undefined), null);
});

test("runs a scan job and returns mapped notes", async () => {
  const runner: RemoteScanRunner = async (_input, context) => {
    context.onProgress({ progress: 0.5, stage: "scanning" });
    return { notes: [note(0), note(1)], nextFromBlock: 123 };
  };
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
  });
  const jobId = service.start({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
    fromBlock: 0,
  });
  await waitForDone(service, jobId);
  const view = service.status(jobId);
  assert.equal(view.status, "done");
  assert.equal(view.progress, 1);
  assert.equal(view.found, 2);
  assert.equal(view.notes?.length, 2);
  assert.equal(view.notes?.[0]?.value, "1000");
  assert.equal(view.nextFromBlock, 123);
  await service.stop();
});

test("defaults remote scans to the RAILGUN deployment block", async () => {
  let scannedFrom = 0;
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async (input) => {
      scannedFrom = input.fromBlock;
      return { notes: [], nextFromBlock: null };
    },
  });
  const jobId = service.start({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  });
  await waitForDone(service, jobId);
  assert.equal(
    scannedFrom,
    RailgunProxyDeploymentBlock[NetworkName.Arbitrum],
  );
  await service.stop();
});

test("cancels a running scan and frees the job slot", async () => {
  const runner: RemoteScanRunner = (_input, context) =>
    new Promise((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => reject(new Error("cancelled")),
        { once: true },
      );
    });
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
    maxJobs: 1,
  });
  const jobId = service.start({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  });
  const queued = service.start({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY_2,
  });
  assert.equal(service.status(queued).status, "queued");
  assert.equal(service.status(queued).stage, "queued");
  assert.equal(service.cancel(jobId).status, "cancelled");
  await wait(10);
  assert.equal(service.status(queued).status, "running");
  service.cancel(queued);
  await service.stop();
});

test("queues scans beyond capacity in order and dedupes queued work", async () => {
  const releases: Array<(result: RemoteScanResult) => void> = [];
  const started: string[] = [];
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    maxJobs: 1,
    runner: async (input) => {
      started.push(input.shareableViewingKey);
      return await new Promise<RemoteScanResult>((resolve) => {
        releases.push(resolve);
      });
    },
  });
  const input = {
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  };
  const second = { ...input, shareableViewingKey: SHAREABLE_KEY_2 };
  const third = { ...input, shareableViewingKey: SHAREABLE_KEY_3 };
  try {
    const first = service.start(input);
    const queuedSecond = service.start(second);
    const queuedThird = service.start(third);
    assert.equal(service.start(second), queuedSecond);
    assert.equal(started.length, 1);
    assert.deepEqual(
      [first, queuedSecond, queuedThird].map(
        (id) => service.status(id).status,
      ),
      ["running", "queued", "queued"],
    );

    releases[0]!({ notes: [], nextFromBlock: null });
    await waitForDone(service, first);
    await wait(10);
    assert.equal(started.length, 2);
    assert.equal(service.status(queuedSecond).status, "running");
    assert.equal(service.status(queuedThird).status, "queued");

    releases[1]!({ notes: [], nextFromBlock: null });
    await waitForDone(service, queuedSecond);
    await wait(10);
    assert.equal(service.status(queuedThird).status, "running");
    releases[2]!({ notes: [], nextFromBlock: null });
    await waitForDone(service, queuedThird);
  } finally {
    await service.stop();
  }
});

test("keeps cold scans from blocking warm refreshes", async () => {
  const releases = new Map<string, (result: RemoteScanResult) => void>();
  const started: string[] = [];
  const cold = new Set([SHAREABLE_KEY, SHAREABLE_KEY_3]);
  const runner = (async (input: { shareableViewingKey: string }) => {
    started.push(input.shareableViewingKey);
    return await new Promise<RemoteScanResult>((resolve) => {
      releases.set(input.shareableViewingKey, resolve);
    });
  }) as RemoteScanRunner;
  runner.classify = (input) =>
    cold.has(input.shareableViewingKey) ? "cold" : "warm";
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
    maxJobs: 2,
  });
  const input = (shareableViewingKey: string) => ({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey,
  });
  try {
    const coldA = service.start(input(SHAREABLE_KEY));
    const coldB = service.start(input(SHAREABLE_KEY_3));
    const warmA = service.start(input(SHAREABLE_KEY_2));
    assert.deepEqual(
      [coldA, coldB, warmA].map((id) => service.status(id).status),
      ["running", "queued", "running"],
    );

    releases.get(SHAREABLE_KEY_2)!({
      notes: [],
      nextFromBlock: null,
    });
    await waitForDone(service, warmA);
    await wait(10);
    assert.equal(service.status(coldB).status, "queued");

    const warmB = service.start(input(SHAREABLE_KEY_4));
    assert.equal(service.status(warmB).status, "running");

    releases.get(SHAREABLE_KEY)!({ notes: [], nextFromBlock: null });
    await waitForDone(service, coldA);
    await wait(10);
    assert.equal(service.status(coldB).status, "running");
    assert.deepEqual(started, [
      SHAREABLE_KEY,
      SHAREABLE_KEY_2,
      SHAREABLE_KEY_4,
      SHAREABLE_KEY_3,
    ]);

    releases.get(SHAREABLE_KEY_4)!({ notes: [], nextFromBlock: null });
    releases.get(SHAREABLE_KEY_3)!({ notes: [], nextFromBlock: null });
    await waitForDone(service, warmB);
    await waitForDone(service, coldB);
  } finally {
    await service.stop();
  }
});

test("returns the running job for a repeated scan of the same wallet", async () => {
  const release: Array<(result: RemoteScanResult) => void> = [];
  let runs = 0;
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async () => {
      runs += 1;
      return await new Promise<RemoteScanResult>((resolve) => {
        release.push(resolve);
      });
    },
    maxJobs: 1,
  });
  const input = {
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  };
  try {
    const first = service.start(input);
    const second = service.start(input);
    assert.equal(second, first);
    assert.equal(runs, 1);
    release[0]!({ notes: [note()], nextFromBlock: null });
    await waitForDone(service, first);
  } finally {
    await service.stop();
  }
});

test("reserves capacity for a queued cold scan", async () => {
  const releases: Array<{
    key: string;
    resolve: (result: RemoteScanResult) => void;
  }> = [];
  const runner: RemoteScanRunner = async (input) =>
    await new Promise<RemoteScanResult>((resolve) => {
      releases.push({ key: input.shareableViewingKey, resolve });
    });
  runner.classify = (input) =>
    input.shareableViewingKey === SHAREABLE_KEY_3 ? "cold" : "warm";
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
    maxJobs: 2,
  });
  const input = (shareableViewingKey: string) => ({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey,
  });
  try {
    const warmA = service.start(input(SHAREABLE_KEY));
    const warmB = service.start(input(SHAREABLE_KEY_2));
    const cold = service.start(input(SHAREABLE_KEY_3));
    const warmC = service.start(input(SHAREABLE_KEY_4));
    assert.deepEqual(
      [warmA, warmB, cold, warmC].map((id) => service.status(id).status),
      ["running", "running", "queued", "queued"],
    );

    releases[0]!.resolve({ notes: [], nextFromBlock: null });
    await waitForDone(service, warmA);
    await wait(10);
    assert.equal(service.status(cold).status, "running");
    assert.equal(service.status(warmC).status, "queued");

    releases.find((entry) => entry.key === SHAREABLE_KEY_2)!.resolve({
      notes: [],
      nextFromBlock: null,
    });
    await waitForDone(service, warmB);
    await wait(10);
    assert.equal(service.status(warmC).status, "running");
  } finally {
    for (const entry of releases) {
      entry.resolve({ notes: [], nextFromBlock: null });
    }
    await wait(20);
    await service.stop();
  }
});

test("abandoned scans clear the viewing key immediately", async () => {
  let release!: (result: RemoteScanResult) => void;
  let capturedInput: { shareableViewingKey: string } | undefined;
  const runner: RemoteScanRunner = async (input) => {
    capturedInput = input;
    return await new Promise<RemoteScanResult>((resolve) => {
      release = resolve;
    });
  };
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
  });
  const id = service.start({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  });
  assert.equal(capturedInput?.shareableViewingKey, SHAREABLE_KEY);

  service.cancel(id);
  assert.equal(capturedInput?.shareableViewingKey, "");

  release({ notes: [], nextFromBlock: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await service.stop();
});

test("cancelIfPresent releases abandoned jobs idempotently", async () => {
  let capturedInput: { shareableViewingKey: string } | undefined;
  let runnerSignal: AbortSignal | undefined;
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async (input, context) => {
      capturedInput = input;
      runnerSignal = context.signal;
      return await new Promise<RemoteScanResult>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
      });
    },
  });
  const id = service.start({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  });
  await wait(5);

  service.cancelIfPresent(id);
  service.cancelIfPresent(id);
  service.cancelIfPresent("not-a-job");
  assert.equal(capturedInput?.shareableViewingKey, "");
  assert.equal(runnerSignal?.aborted, true);
  assert.throws(
    () => service.status(id),
    (error) =>
      error instanceof ScanApiError &&
      error.status === 404 &&
      error.code === "SCAN_NOT_FOUND",
  );
  await service.stop();
});

test("rejects unsupported txid versions", () => {
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async () => ({ notes: [], nextFromBlock: null }),
  });
  assert.throws(
    () =>
      service.start({
        network: NetworkName.Arbitrum,
        txidVersion: TXIDVersion.V3_PoseidonMerkle,
        shareableViewingKey: SHAREABLE_KEY,
      }),
    (error) =>
      error instanceof ScanApiError &&
      error.code === "UNSUPPORTED_TXID_VERSION",
  );
  void service.stop();
});

test("oversized scan results fail without publishing partial notes or advancing a cursor", async () => {
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    maxNotes: 100,
    runner: async () => ({
      notes: Array.from({ length: 101 }, (_, i) => note(i)),
      nextFromBlock: 1000,
    }),
  });
  try {
    const id = service.start({
      network: NetworkName.Arbitrum,
      txidVersion: TXIDVersion.V2_PoseidonMerkle,
      shareableViewingKey: SHAREABLE_KEY,
    });
    await waitForDone(service, id);
    const result = service.status(id);
    assert.equal(result.status, "error");
    assert.equal(result.notes, undefined);
    assert.equal(result.nextFromBlock, null);
    assert.match(result.error!, /note limit/);
  } finally {
    await service.stop();
  }
});

test("malformed runner results fail closed without publishing notes", async () => {
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async () =>
      ({
        notes: [{ ...note(), txid: "not-a-transaction-hash" }],
        nextFromBlock: null,
      }) as unknown as RemoteScanResult,
  });
  try {
    const id = service.start({
      network: NetworkName.Arbitrum,
      txidVersion: TXIDVersion.V2_PoseidonMerkle,
      shareableViewingKey: SHAREABLE_KEY,
    });
    await waitForDone(service, id);
    const result = service.status(id);
    assert.equal(result.status, "error");
    assert.equal(result.notes, undefined);
    assert.equal(result.nextFromBlock, null);
    assert.match(result.error!, /invalid result/);
  } finally {
    await service.stop();
  }
});

test("mapRemoteScanNotes normalizes transaction hashes", () => {
  const map = mapRemoteScanNotes(
    [
      {
        tree: 0,
        position: 1,
        txid: "AB".repeat(32),
        blockNumber: 100,
        spendtxid: false,
        nullifier: "22".repeat(32),
        commitmentType: "ShieldCommitment",
        note: {
          hash: 1n,
          random: "33".repeat(16),
          value: 5n,
          tokenData: {
            tokenType: 0,
            tokenAddress: "00".repeat(20),
            tokenSubID: "0",
          },
        },
      },
    ],
    true,
  );
  assert.equal(map.length, 1);
  assert.equal(map[0]!.txid, `0x${"ab".repeat(32)}`);
});

test("completed results are deleted explicitly or expire at the deadline", async () => {
  let now = 0;
  let stopped = false;
  const runner: RemoteScanRunner = async () => ({
    notes: [note()],
    nextFromBlock: null,
  });
  runner.stop = async () => {
    stopped = true;
  };
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
    now: () => now,
    ttlMs: 60_000,
  });
  const input = {
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  };
  try {
    const first = service.start(input);
    await waitForDone(service, first);
    assert.equal(service.cancel(first).found, 0);
    assert.throws(() => service.status(first), /not found/);
    const second = service.start(input);
    await waitForDone(service, second);
    now = 60_000;
    assert.throws(() => service.status(second), /not found/);
  } finally {
    await service.stop();
  }
  assert.equal(stopped, true);
});

test("completed job retention has a hard capacity bound", async () => {
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async () => ({ notes: [], nextFromBlock: null }),
  });
  const input = {
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  };
  try {
    const ids: string[] = [];
    for (let i = 0; i < 32; i++) {
      const id = service.start(input);
      ids.push(id);
      await waitForDone(service, id);
    }
    assert.throws(
      () => service.start(input),
      (error) => error instanceof ScanApiError && error.code === "SCAN_BUSY",
    );
    service.cancel(ids[0]!);
    await waitForDone(service, service.start(input));
  } finally {
    await service.stop();
  }
});

test("bounds aggregate result bytes and releases deleted results", async () => {
  let release: Array<(result: RemoteScanResult) => void> = [];
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async () =>
      await new Promise<RemoteScanResult>((resolve) => {
        release.push(resolve);
      }),
    maxJobs: 2,
    maxResultBytes: Buffer.byteLength(JSON.stringify([note()])),
  });
  const input = {
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  };
  try {
    const first = service.start(input);
    const second = service.start({
      ...input,
      shareableViewingKey: SHAREABLE_KEY_2,
    });
    const deadline = Date.now() + 2_000;
    while (release.length < 2) {
      if (Date.now() > deadline) throw new Error("scan jobs did not start");
      await wait(5);
    }
    release[0]!({ notes: [note(0)], nextFromBlock: null });
    release[1]!({ notes: [note(1)], nextFromBlock: null });
    await waitForDone(service, first);
    await waitForDone(service, second);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const views = [service.status(first), service.status(second)];
    assert.equal(views.filter((view) => view.status === "done").length, 1);
    const rejected = views.find((view) => view.status === "error");
    assert.match(rejected?.error ?? "", /storage limit/);

    const completed = views.find((view) => view.status === "done")!;
    service.cancel(completed.jobId);
    release = [];
    const replacement = service.start(input);
    while (release.length === 0) {
      if (Date.now() > deadline) throw new Error("replacement did not start");
      await wait(5);
    }
    release[0]!({ notes: [note(2)], nextFromBlock: null });
    await waitForDone(service, replacement);
    assert.equal(service.status(replacement).status, "done");
  } finally {
    await service.stop();
  }
});

test("timeout reports failure while retaining the slot until background work exits", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (result: { notes: RemoteScanNote[]; nextFromBlock: null }) => void;
  const service = new RemoteScanService({
    enabled: true, token: TOKEN, timeoutMs: 60_000,
    runner: async () => new Promise((resolve) => { release = resolve; }),
  });
  const input = { network: NetworkName.Arbitrum, txidVersion: TXIDVersion.V2_PoseidonMerkle, shareableViewingKey: SHAREABLE_KEY };
  try {
    const id = service.start(input);
    context.mock.timers.tick(60_000);
    assert.equal(service.status(id).status, "error");
    assert.match(service.status(id).error!, /timed out/);
    const queued = service.start(input);
    assert.equal(service.status(queued).status, "queued");
    service.cancel(queued);
    release({ notes: [], nextFromBlock: null });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally { await service.stop(); }
});

test("stop is shared and runs runner cleanup once", async () => {
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let stopCalls = 0;
  const runner: RemoteScanRunner = async () => ({
    notes: [],
    nextFromBlock: null,
  });
  runner.stop = async () => {
    stopCalls += 1;
    await stopGate;
  };
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
  });

  const firstStop = service.stop();
  const secondStop = service.stop();
  assert.equal(firstStop, secondStop);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopCalls, 1);

  releaseStop();
  await Promise.all([firstStop, secondStop]);
  assert.equal(stopCalls, 1);
});

test("stop reports workers that miss the shutdown deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (result: RemoteScanResult) => void;
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner: async () =>
      await new Promise<RemoteScanResult>((resolve) => {
        release = resolve;
      }),
  });
  service.start({
    network: NetworkName.Arbitrum,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    shareableViewingKey: SHAREABLE_KEY,
  });

  const stopping = service.stop();
  context.mock.timers.tick(REMOTE_SCAN_STOP_TIMEOUT_MS);
  await assert.rejects(stopping, /shutdown deadline/);

  release({ notes: [], nextFromBlock: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("stop reports runner cleanup failures", async () => {
  const runner: RemoteScanRunner = async () => ({
    notes: [],
    nextFromBlock: null,
  });
  runner.stop = async () => {
    throw new Error("runner cleanup failed");
  };
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
  });

  const firstStop = service.stop();
  const secondStop = service.stop();
  assert.equal(firstStop, secondStop);
  await assert.rejects(firstStop, /runner cleanup failed/);
});

test("stop bounds runner cleanup that misses the shutdown deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const runner: RemoteScanRunner = async () => ({
    notes: [],
    nextFromBlock: null,
  });
  runner.stop = async () => {
    await new Promise<void>(() => undefined);
  };
  const service = new RemoteScanService({
    enabled: true,
    token: TOKEN,
    runner,
  });

  const stopping = service.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  context.mock.timers.tick(REMOTE_SCAN_STOP_TIMEOUT_MS);
  await assert.rejects(
    stopping,
    /runner cleanup timed out/,
  );
});
