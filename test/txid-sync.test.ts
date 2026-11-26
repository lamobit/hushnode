import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  applyTxidQueryLimit,
  patchTxidTimeout,
  tuneTxidSync,
} from "../src/railgun/txid-sync.js";

type QueryDocument = Parameters<typeof applyTxidQueryLimit>[0];

const queryDocument = (
  limit: unknown,
): QueryDocument =>
  ({
    definitions: [
      {
        selectionSet: {
          selections: [
            {
              kind: "Field",
              name: { value: "transactions" },
              arguments: [
                { name: { value: "orderBy" }, value: { value: "id_ASC" } },
                { name: { value: "limit" }, value: limit },
              ],
            },
          ],
        },
      },
    ],
  }) as QueryDocument;

test("transaction query limit patching rejects unknown document shapes", () => {
  assert.equal(applyTxidQueryLimit(undefined), false);
  assert.equal(applyTxidQueryLimit({}), false);
  assert.equal(
    applyTxidQueryLimit({
      definitions: [
        {
          selectionSet: {
            selections: [{ kind: "Field", name: { value: "transactions" } }],
          },
        },
      ],
    }),
    false,
  );
});

test("transaction query limit patching updates only the page-size argument", () => {
  const document = queryDocument({ kind: "IntValue", value: "10000" });
  assert.equal(applyTxidQueryLimit(document, 1_000), true);
  const selections =
    document?.definitions?.[0]?.selectionSet?.selections ?? [];
  assert.equal(selections[0]?.arguments?.[0]?.value?.value, "id_ASC");
  assert.equal(selections[0]?.arguments?.[1]?.value?.value, "1000");
});

test("TXID timeout patching extends only the matching SDK timeout", async () => {
  const calls: Array<{
    milliseconds: number;
    error: Error | undefined;
  }> = [];
  const promises = {
    promiseTimeout: async (
      promise: Promise<unknown>,
      milliseconds: number,
      error?: Error,
    ) => {
      calls.push({ milliseconds, error });
      return promise;
    },
  };

  assert.equal(patchTxidTimeout(promises, 90_000, "TXID sync timed out"), true);
  await promises.promiseTimeout(
    Promise.resolve("short"),
    20_000,
    new Error("TXID sync timed out"),
  );
  await promises.promiseTimeout(
    Promise.resolve("larger"),
    120_000,
    new Error("TXID sync timed out"),
  );
  await promises.promiseTimeout(
    Promise.resolve("unrelated"),
    20_000,
    new Error("another request timed out"),
  );

  assert.deepEqual(
    calls.map((call) => call.milliseconds),
    [90_000, 120_000, 20_000],
  );
  assert.equal(calls[0]?.error?.message, "TXID sync timed out");
  assert.equal(calls[2]?.error?.message, "another request timed out");
});

test("TXID timeout patching reports unavailable SDK hooks", () => {
  assert.equal(patchTxidTimeout({}), false);
});

test("TXID tuning applies the pinned SDK limits exactly once", async () => {
  const require = createRequire(import.meta.url);
  const walletRoot = path.dirname(
    require.resolve("@railgun-community/wallet"),
  );
  const graphql = require(
    path.join(
      walletRoot,
      "services/railgun/railgun-txids/graphql/index.js",
    ),
  ) as {
    GetRailgunTransactionsAfterGraphIDDocument?: QueryDocument;
  };
  const engine = require("@railgun-community/engine") as {
    getEngineTxidSyncBatchSize?: () => number;
  };
  const sharedRoot = path.dirname(
    require.resolve("@railgun-community/shared-models"),
  );
  const promises = require(path.join(
    sharedRoot,
    "utils/promises.js",
  )) as {
    promiseTimeout?: (...args: unknown[]) => Promise<unknown>;
  };

  const originalTimeout = promises.promiseTimeout;
  tuneTxidSync();

  const transactions =
    graphql.GetRailgunTransactionsAfterGraphIDDocument?.definitions?.[0]
      ?.selectionSet?.selections?.find(
        (selection) =>
          selection.kind === "Field" &&
          selection.name?.value === "transactions",
      );
  const limit = transactions?.arguments?.find(
    (argument) => argument.name?.value === "limit",
  );
  assert.equal(limit?.value?.value, "1000");
  assert.equal(engine.getEngineTxidSyncBatchSize?.(), 1_000);
  assert.notEqual(promises.promiseTimeout, originalTimeout);

  const patchedTimeout = promises.promiseTimeout;
  tuneTxidSync();
  assert.equal(promises.promiseTimeout, patchedTimeout);
});
