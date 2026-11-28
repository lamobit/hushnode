import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createHttpApp } from "../src/http-app.js";
import type { LightApiOptions } from "../src/light-api.js";
import {
  BroadcasterRelay,
  BroadcasterRelayError,
  parseAmount,
  parseCalldata,
  parseNullifiers,
  parsePreTransactionPOIs,
  parseQuoteId,
  parseTokenHash,
  tokenAddressFromHash,
} from "../src/railgun/broadcaster-relay.js";
import { BroadcasterTransportError } from "../src/railgun/broadcasters.js";

const withServer = async (
  light: LightApiOptions,
  run: (base: string) => Promise<void>,
): Promise<void> => {
  const { app } = createHttpApp({ light });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
};

const tokenHash = `${"0".repeat(24)}${"11".repeat(20)}`;
const quoteId = "a".repeat(32);
const hash = `0x${"ab".repeat(32)}`;

const fakeRelay = {
  async quote(input: {
    network: string;
    txidVersion: string;
    tokenHash: string;
  }) {
    return {
      id: quoteId,
      network: input.network,
      txidVersion: input.txidVersion,
      tokenHash: input.tokenHash,
      feeRecipient: `0zk1${"q".repeat(100)}`,
      fee: 100n,
      minGasPrice: 2_000_000n,
      expiresAt: Date.now() + 60_000,
    };
  },
  async transact() {
    return { hash };
  },
  async startTransact() {
    return { id: quoteId, status: "pending" as const };
  },
  async transactStatus() {
    return { id: quoteId, status: "submitted" as const, hash };
  },
  async stop() {},
};

test("parses relay request fields strictly", () => {
  assert.equal(parseTokenHash(`0x${tokenHash}`), tokenHash);
  assert.throws(() => parseTokenHash("0x1234"), BroadcasterRelayError);
  assert.equal(parseAmount("1500"), 1_500n);
  assert.throws(() => parseAmount("0"), BroadcasterRelayError);
  assert.equal(parseCalldata("0xdeadbeef"), "0xdeadbeef");
  assert.throws(() => parseCalldata("deadbeef"), BroadcasterRelayError);
  const nullifier = `0x${"11".repeat(32)}`;
  assert.deepEqual(parseNullifiers([nullifier.toUpperCase()]), [
    nullifier.toLowerCase(),
  ]);
  assert.throws(() => parseNullifiers([]), BroadcasterRelayError);
  assert.equal(parseQuoteId(quoteId), quoteId);
  assert.throws(() => parseQuoteId("nope"), BroadcasterRelayError);
});

test("recovers the token address from a RAILGUN token hash", () => {
  assert.equal(
    tokenAddressFromHash(tokenHash),
    `0x${"11".repeat(20)}`,
  );
  assert.throws(
    () => tokenAddressFromHash("11".repeat(32)),
    BroadcasterRelayError,
  );
});

test("bounds broadcaster amounts to uint256", () => {
  assert.equal(parseAmount(`${"0".repeat(100)}1`), 1n);
  const max = (1n << 256n) - 1n;
  assert.equal(parseAmount(max.toString(10)), max);
  assert.throws(
    () => parseAmount((1n << 256n).toString(10)),
    BroadcasterRelayError,
  );
  assert.throws(() => parseAmount("9".repeat(79)), BroadcasterRelayError);
});

test("validates pre-transaction POI payloads", () => {
  const listKey = "aa".repeat(32);
  const leafKey = "bb".repeat(32);
  const poi = {
    snarkProof: {
      pi_a: ["1", "2"],
      pi_b: [
        ["3", "4"],
        ["5", "6"],
      ],
      pi_c: ["7", "8"],
    },
    txidMerkleroot: "11".repeat(32),
    poiMerkleroots: ["22".repeat(32)],
    blindedCommitmentsOut: ["33".repeat(32)],
    railgunTxidIfHasUnshield: "",
  };
  assert.deepEqual(
    parsePreTransactionPOIs({ [listKey]: { [leafKey]: poi } }),
    { [listKey]: { [leafKey]: poi } },
  );
  const rapidsnarkProof = {
    ...poi,
    snarkProof: {
      pi_a: ["1", "2", "1"],
      pi_b: [
        ["3", "4"],
        ["5", "6"],
        ["1", "0"],
      ],
      pi_c: ["7", "8", "1"],
    },
  };
  assert.deepEqual(
    parsePreTransactionPOIs({
      [listKey]: { [leafKey]: rapidsnarkProof },
    }),
    { [listKey]: { [leafKey]: poi } },
  );
  assert.throws(
    () => parsePreTransactionPOIs([]),
    BroadcasterRelayError,
  );
  assert.throws(
    () => parsePreTransactionPOIs({ nope: {} }),
    BroadcasterRelayError,
  );
  assert.throws(
    () => parsePreTransactionPOIs({ [listKey]: [] }),
    BroadcasterRelayError,
  );
  assert.throws(
    () =>
      parsePreTransactionPOIs({
        [listKey]: {
          [leafKey]: { ...poi, snarkProof: {} },
        },
      }),
    BroadcasterRelayError,
  );
});

test("rejects unknown quotes before touching the relay", async () => {
  const relay = new BroadcasterRelay({
    broadcasters: {
      ensureChain: async () => undefined,
      bestForToken: () => undefined,
      submit: async () => hash,
      stop: async () => undefined,
    } as never,
    provider: (() => {
      throw new Error("provider should not be called");
    }) as never,
  });
  await assert.rejects(
    relay.transact({
      network: "Arbitrum" as never,
      txidVersion: "V2_PoseidonMerkle" as never,
      calldata: "0x1234",
      quoteId,
      nullifiers: [`0x${"11".repeat(32)}`],
    }),
    (error: unknown) =>
      error instanceof BroadcasterRelayError && error.status === 404,
  );
});

test("returns immediately while the broadcaster submission is in flight", async () => {
  let resolveSubmit: ((value: string) => void) | undefined;
  let submitCalls = 0;
  const relay = new BroadcasterRelay({
    broadcasters: {
      ensureChain: async () => undefined,
      bestForToken: () => ({
        railgunAddress: `0zk1${"q".repeat(100)}`,
        tokenAddress: `0x${"11".repeat(20)}`,
        tokenFee: { feesID: "fees-1", feePerUnitGas: "1000000000000000000" },
      }),
      submit: async () => {
        submitCalls += 1;
        return new Promise<string>((resolve) => {
          resolveSubmit = resolve;
        });
      },
      stop: async () => undefined,
    } as never,
    provider: (() => ({
      feeData: async () => ({
        baseFeePerGas: 10_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    })) as never,
  });
  const quoted = await relay.quote({
    network: "Ethereum" as never,
    txidVersion: "V2_PoseidonMerkle" as never,
    tokenHash,
    amount: 10n ** 18n,
    unshield: false,
  });
  const input = {
    network: "Ethereum" as never,
    txidVersion: "V2_PoseidonMerkle" as never,
    calldata: "0x1234",
    quoteId: quoted.id,
    nullifiers: [`0x${"11".repeat(32)}`],
  };

  const startedAt = Date.now();
  const status = await relay.startTransact(input);
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(status, { id: quoted.id, status: "pending" });

  const duplicate = await relay.startTransact(input);
  assert.deepEqual(duplicate, { id: quoted.id, status: "pending" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(submitCalls, 1);
  assert.deepEqual(await relay.transactStatus(quoted.id), {
    id: quoted.id,
    status: "pending",
  });

  resolveSubmit?.(hash);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await relay.transactStatus(quoted.id), {
    id: quoted.id,
    status: "submitted",
    hash,
  });
});

test("allows retrying a quote after a transient broadcaster failure", async () => {
  let submitCalls = 0;
  const relay = new BroadcasterRelay({
    broadcasters: {
      ensureChain: async () => undefined,
      bestForToken: () => ({
        railgunAddress: `0zk1${"q".repeat(100)}`,
        tokenAddress: `0x${"11".repeat(20)}`,
        tokenFee: { feesID: "fees-1", feePerUnitGas: "1000000000000000000" },
      }),
      submit: async () => {
        submitCalls += 1;
        if (submitCalls === 1) {
          throw new BroadcasterTransportError("relay busy");
        }
        return hash;
      },
      stop: async () => undefined,
    } as never,
    provider: (() => ({
      feeData: async () => ({
        baseFeePerGas: 10_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    })) as never,
  });
  const quoted = await relay.quote({
    network: "Ethereum" as never,
    txidVersion: "V2_PoseidonMerkle" as never,
    tokenHash,
    amount: 10n ** 18n,
    unshield: false,
  });
  const input = {
    network: "Ethereum" as never,
    txidVersion: "V2_PoseidonMerkle" as never,
    calldata: "0x1234",
    quoteId: quoted.id,
    nullifiers: [`0x${"11".repeat(32)}`],
  };

  await relay.startTransact(input);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await relay.transactStatus(quoted.id), {
    id: quoted.id,
    status: "failed",
    code: "BROADCASTER_UNAVAILABLE",
    message: "The broadcaster network is temporarily unavailable.",
  });

  assert.deepEqual(await relay.startTransact(input), {
    id: quoted.id,
    status: "pending",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(submitCalls, 2);
  assert.deepEqual(await relay.transactStatus(quoted.id), {
    id: quoted.id,
    status: "submitted",
    hash,
  });
});

test("broadcaster routes are disabled unless configured", async () => {
  await withServer({ enabled: true }, async (base) => {
    const response = await fetch(`${base}/api/light/v1/broadcaster/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { code?: string }).code,
      "BROADCASTER_DISABLED",
    );
  });
});

test("quotes and submits through the broadcaster routes", async () => {
  await withServer(
    { enabled: true, broadcaster: fakeRelay as never },
    async (base) => {
      const quote = await fetch(`${base}/api/light/v1/broadcaster/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "arbitrum",
          txidVersion: "V2_PoseidonMerkle",
          tokenHash,
          amount: "1000000",
          unshield: false,
        }),
      });
      assert.equal(quote.status, 200);
      const quoted = (await quote.json()) as Record<string, unknown>;
      assert.equal(quoted.id, quoteId);
      assert.equal(quoted.network, "arbitrum");
      assert.equal(quoted.tokenHash, tokenHash);
      assert.equal(quoted.feeRecipient, `0zk1${"q".repeat(100)}`);
      assert.equal(quoted.fee, "100");
      assert.equal(quoted.minGasPrice, "2000000");
      assert.equal(typeof quoted.expiresAt, "number");

      const transact = await fetch(
        `${base}/api/light/v1/broadcaster/transact`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum",
            txidVersion: "V2_PoseidonMerkle",
            calldata: "0x1234",
            quote: { id: quoteId },
            nullifiers: [`0x${"11".repeat(32)}`],
          }),
        },
      );
      assert.equal(transact.status, 200);
      assert.deepEqual(await transact.json(), { hash });
    },
  );
});

test("starts a submission asynchronously and exposes its status", async () => {
  let statusCalls = 0;
  const relay = {
    ...fakeRelay,
    async startTransact() {
      return { id: quoteId, status: "pending" as const };
    },
    async transactStatus() {
      statusCalls += 1;
      return statusCalls === 1
        ? { id: quoteId, status: "pending" as const }
        : { id: quoteId, status: "submitted" as const, hash };
    },
  };
  await withServer(
    { enabled: true, broadcaster: relay as never },
    async (base) => {
      const body = {
        network: "arbitrum",
        txidVersion: "V2_PoseidonMerkle",
        calldata: "0x1234",
        quote: { id: quoteId },
        nullifiers: [`0x${"11".repeat(32)}`],
        async: true,
      };
      const started = await fetch(
        `${base}/api/light/v1/broadcaster/transact`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      assert.equal(started.status, 202);
      assert.deepEqual(await started.json(), {
        id: quoteId,
        status: "pending",
      });

      const pending = await fetch(
        `${base}/api/light/v1/broadcaster/transact/${quoteId}`,
      );
      assert.equal(pending.status, 200);
      assert.deepEqual(await pending.json(), {
        id: quoteId,
        status: "pending",
      });

      const submitted = await fetch(
        `${base}/api/light/v1/broadcaster/transact/${quoteId}`,
      );
      assert.equal(submitted.status, 200);
      assert.deepEqual(await submitted.json(), {
        id: quoteId,
        status: "submitted",
        hash,
      });
    },
  );
});

test("rejects unsupported networks on the quote route", async () => {
  await withServer(
    { enabled: true, broadcaster: fakeRelay as never },
    async (base) => {
      const response = await fetch(
        `${base}/api/light/v1/broadcaster/quote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "polygon",
            txidVersion: "V2_PoseidonMerkle",
            tokenHash,
            amount: "1",
          }),
        },
      );
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { code?: string }).code,
        "UNSUPPORTED_NETWORK",
      );
    },
  );
});

test("rejects malformed pre-transaction POIs on the transact route", async () => {
  await withServer(
    { enabled: true, broadcaster: fakeRelay as never },
    async (base) => {
      const response = await fetch(
        `${base}/api/light/v1/broadcaster/transact`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "arbitrum",
            txidVersion: "V2_PoseidonMerkle",
            calldata: "0x1234",
            quote: { id: quoteId },
            nullifiers: [`0x${"11".repeat(32)}`],
            preTransactionPOIs: [],
          }),
        },
      );
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { code?: string }).code,
        "INVALID_PRE_TRANSACTION_POIS",
      );
    },
  );
});
