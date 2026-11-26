import assert from "node:assert/strict";
import test from "node:test";
import { NetworkName } from "@railgun-community/shared-models";
import { networkFor } from "../src/networks.js";
import {
  fetchPublicActivity,
  mapPublicActivity,
} from "../src/public-activity.js";

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}`;
const unknownToken = "0x1234567890abcdef1234567890abcdef12345678";
const network = NetworkName.Arbitrum;
const definition = networkFor(network);
const usdt = definition.tokens.find((token) => token.symbol === "USDT");
assert.ok(usdt);

const nativeTransaction = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  hash,
  status: "ok",
  from: { hash: owner },
  to: { hash: other },
  value: "1000000000000000000",
  fee: { type: "actual", value: "21000000000000" },
  timestamp: "2026-11-24T12:00:00.000000Z",
  block_number: 123_456,
  ...overrides,
});

const tokenTransfer = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  transaction_hash: hash,
  from: { hash: other },
  to: { hash: owner },
  token: {
    address_hash: usdt.address,
    symbol: usdt.symbol,
    decimals: String(usdt.decimals),
  },
  total: { value: "2500000", decimals: String(usdt.decimals) },
  timestamp: "2026-11-24T12:00:00.000000Z",
  block_number: 123_456,
  ...overrides,
});

test("maps native sends with fee, direction and timestamp", () => {
  const items = mapPublicActivity(
    network,
    owner,
    [nativeTransaction()],
    [],
  );

  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.hash, hash);
  assert.equal(item.status, "completed");
  assert.equal(item.timestamp, Date.parse("2026-11-24T12:00:00.000000Z"));
  assert.equal(item.blockNumber, 123_456);
  assert.equal(item.fee, "21000000000000");
  assert.deepEqual(item.legs, [
    {
      direction: "out",
      tokenAddress: null,
      symbol: definition.nativeSymbol,
      decimals: definition.nativeDecimals,
      value: "1000000000000000000",
    },
  ]);
});

test("merges token transfers and native value for the same transaction", () => {
  const items = mapPublicActivity(
    network,
    owner,
    [nativeTransaction()],
    [tokenTransfer()],
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.legs.length, 2);
  assert.deepEqual(
    items[0]?.legs.map((leg) => [leg.direction, leg.symbol, leg.value]).sort(),
    [
      ["in", "USDT", "2500000"],
      ["out", definition.nativeSymbol, "1000000000000000000"],
    ].sort(),
  );
});

test("keeps failed native transfers and ignores reverted token transfers", () => {
  const items = mapPublicActivity(
    network,
    owner,
    [nativeTransaction({ status: "error" })],
    [tokenTransfer()],
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.status, "failed");
  assert.equal(items[0]?.legs.length, 1);
});

test("known tokens ignore upstream labels and merge address casing with decimal fallback", () => {
  const items = mapPublicActivity(network, owner, [], [
    tokenTransfer({
      token: { address_hash: usdt.address.toUpperCase().replace("0X", "0x"), symbol: "SPOOF" },
      total: { value: "2" },
    }),
    tokenTransfer({
      token: { address_hash: usdt.address.toLowerCase(), symbol: "OTHER" },
      total: { value: "3" },
    }),
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]?.legs, [{
    direction: "in",
    tokenAddress: usdt.address.toLowerCase(),
    symbol: usdt.symbol,
    decimals: usdt.decimals,
    value: "5",
  }]);
});

test("labels unknown tokens without trusting spoofed symbols", () => {
  const items = mapPublicActivity(
    network,
    owner,
    [],
    [
      tokenTransfer({
        token: { address_hash: unknownToken, symbol: "USDT" },
        total: { value: "1", decimals: "18" },
      }),
      tokenTransfer({
        transaction_hash: `0x${"cd".repeat(32)}`,
        token: { address_hash: unknownToken, symbol: "FOO" },
        total: { value: "2", decimals: "18" },
      }),
    ],
  );

  assert.deepEqual(
    items.map((item) => item.legs[0]?.symbol).sort(),
    ["ERC-20 0x1234…5678", "FOO · 0x1234…5678"].sort(),
  );
});

test("bounds activity amounts to uint256 before conversion", () => {
  const max = ((1n << 256n) - 1n).toString();
  const accepted = mapPublicActivity(
    network,
    owner,
    [
      nativeTransaction({
        value: max,
        fee: { value: `1${"0".repeat(78)}` },
      }),
    ],
    [],
  );
  assert.equal(accepted[0]?.legs[0]?.value, max);
  assert.equal(accepted[0]?.fee, null);

  const hexAccepted = mapPublicActivity(
    network,
    owner,
    [nativeTransaction({ value: `0x${"f".repeat(64)}` })],
    [],
  );
  assert.equal(hexAccepted[0]?.legs[0]?.value, max);

  const rejected = mapPublicActivity(
    network,
    owner,
    [nativeTransaction({ value: `1${"0".repeat(78)}` })],
    [
      tokenTransfer({
        total: { value: `1${"0".repeat(78)}`, decimals: "6" },
      }),
    ],
  );
  assert.deepEqual(rejected, []);
});

test("rejects timestamps outside the JavaScript date range", () => {
  const items = mapPublicActivity(
    network,
    owner,
    [nativeTransaction({ timestamp: 1e300 })],
    [],
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.timestamp, 0);
});

test("falls back to token transfers when the transaction endpoint fails", async () => {
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/transactions")) {
      return new Response("upstream unavailable", { status: 503 });
    }
    return Response.json({
      items: [tokenTransfer()],
      next_page_params: null,
    });
  };

  const result = await fetchPublicActivity(network, owner, fetchImpl);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.legs[0]?.symbol, "USDT");
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ["TRANSACTION_HISTORY_UNAVAILABLE"]);
});

test("public history requests reject upstream redirects", async () => {
  const redirects: Array<RequestInit["redirect"]> = [];
  const fetchImpl = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    redirects.push(init?.redirect);
    return Response.json({ items: [], next_page_params: null });
  };
  await fetchPublicActivity(network, owner, fetchImpl);
  assert.deepEqual(redirects, ["error", "error"]);
});

test("public activity forwards caller cancellation to both upstream requests", async () => {
  const abort = new AbortController();
  let requests = 0;
  let aborted = 0;
  const fetchImpl = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> =>
    await new Promise<Response>((_resolve, reject) => {
      requests += 1;
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted += 1;
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });

  const pending = fetchPublicActivity(network, owner, {
    fetchImpl,
    signal: abort.signal,
  });
  assert.equal(requests, 2);
  abort.abort(new Error("client disconnected"));
  await assert.rejects(pending, /client disconnected/);
  assert.equal(aborted, 2);
});

test("marks truncated pagination instead of presenting it as complete", async () => {
  let transactionRequests = 0;
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/token-transfers")) {
      return Response.json({ items: [], next_page_params: null });
    }
    transactionRequests += 1;
    if (transactionRequests === 1) {
      return Response.json({
        items: [nativeTransaction()],
        next_page_params: { page: 2 },
      });
    }
    return new Response("upstream unavailable", { status: 503 });
  };

  const result = await fetchPublicActivity(network, owner, fetchImpl);
  assert.equal(result.items.length, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ["TRANSACTION_HISTORY_TRUNCATED"]);
});

test("rejects unsafe pagination parameters instead of claiming completeness", async () => {
  const cases: Record<string, unknown>[] = [
    Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`param${index}`, index]),
    ),
    { page: { nested: true } },
    { page: "x".repeat(513) },
  ];

  for (const nextPageParams of cases) {
    let transactionRequests = 0;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/token-transfers")) {
        return Response.json({ items: [], next_page_params: null });
      }
      transactionRequests += 1;
      return Response.json({
        items: [nativeTransaction()],
        next_page_params: nextPageParams,
      });
    };

    const result = await fetchPublicActivity(network, owner, fetchImpl);
    assert.equal(result.complete, false);
    assert.deepEqual(result.warnings, ["TRANSACTION_HISTORY_INVALID"]);
    assert.equal(transactionRequests, 1);
  }
});

test("caps each public history source at the API item limit", async () => {
  let transactionRequests = 0;
  const transactions = Array.from({ length: 301 }, (_, index) =>
    nativeTransaction({
      hash: `0x${index.toString(16).padStart(64, "0")}`,
    }),
  );
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/token-transfers")) {
      return Response.json({ items: [], next_page_params: null });
    }
    transactionRequests += 1;
    return Response.json({
      items: transactions,
      next_page_params: { page: 2 },
    });
  };

  const result = await fetchPublicActivity(network, owner, fetchImpl);
  assert.equal(result.items.length, 300);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ["TRANSACTION_HISTORY_TRUNCATED"]);
  assert.equal(transactionRequests, 1);
});

test("marks malformed history responses instead of returning a complete empty result", async () => {
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/token-transfers")) {
      return Response.json([tokenTransfer()]);
    }
    return Response.json({
      items: [nativeTransaction()],
      next_page_params: "not-a-page-object",
    });
  };

  const result = await fetchPublicActivity(network, owner, fetchImpl);
  assert.equal(result.items.length, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, [
    "TRANSACTION_HISTORY_INVALID",
    "TOKEN_TRANSFER_HISTORY_INVALID",
  ]);
});

test("fails closed when both public history sources are unavailable", async () => {
  await assert.rejects(
    fetchPublicActivity(
      network,
      owner,
      async () => new Response("upstream unavailable", { status: 503 }),
    ),
    /Blockscout HTTP 503/,
  );
});
