import assert from "node:assert/strict";
import test from "node:test";
import { NetworkName } from "@railgun-community/shared-models";
import { LightCatalog } from "../src/light-api/catalog.js";
import type {
  PublicActivityItem,
  PublicActivityResult,
} from "../src/public-activity.js";

const ADDRESS = `0x${"11".repeat(20)}`;

const activityItem = (index: number): PublicActivityItem => ({
  hash: `0x${index.toString(16).padStart(64, "0")}`,
  timestamp: 1_000 - index,
  blockNumber: index,
  fee: null,
  status: "completed",
  from: null,
  to: null,
  legs: [],
});

test("activity cache reuses complete results until their TTL expires", async () => {
  let now = 0;
  let calls = 0;
  const result: PublicActivityResult = {
    items: [activityItem(0)],
    complete: true,
    warnings: [],
  };
  const catalog = new LightCatalog({
    now: () => now,
    publicActivityFetcher: async () => {
      calls += 1;
      return result;
    },
  });

  assert.equal(
    (await catalog.activity(NetworkName.Arbitrum, ADDRESS)).items.length,
    1,
  );
  assert.equal(
    (await catalog.activity(NetworkName.Arbitrum, ADDRESS)).items.length,
    1,
  );
  assert.equal(calls, 1);

  now = 15_000;
  await catalog.activity(NetworkName.Arbitrum, ADDRESS);
  assert.equal(calls, 2);
});

test("partial activity results use a short TTL and cache at most 300 items", async () => {
  let now = 0;
  let calls = 0;
  const result: PublicActivityResult = {
    items: Array.from({ length: 301 }, (_, index) => activityItem(index)),
    complete: false,
    warnings: ["TRANSACTION_HISTORY_UNAVAILABLE"],
  };
  const catalog = new LightCatalog({
    now: () => now,
    publicActivityFetcher: async () => {
      calls += 1;
      return result;
    },
  });

  assert.equal(
    (await catalog.activity(NetworkName.Arbitrum, ADDRESS)).items.length,
    300,
  );
  now = 4_999;
  assert.equal(
    (await catalog.activity(NetworkName.Arbitrum, ADDRESS)).items.length,
    300,
  );
  assert.equal(calls, 1);

  now = 5_000;
  await catalog.activity(NetworkName.Arbitrum, ADDRESS);
  assert.equal(calls, 2);
});
