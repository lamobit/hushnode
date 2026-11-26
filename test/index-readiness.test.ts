import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveIndexReadiness,
  notStartedReadiness,
} from "../src/index-readiness.js";

const health = {
  initialized: true,
  running: true,
  networkLoaded: true,
  stopping: false,
};

test("readiness only serves after a complete initial sync", () => {
  assert.deepEqual(notStartedReadiness(), {
    ready: false,
    state: "starting",
    retryAttempt: 0,
    lastCompletedAt: null,
  });
  assert.deepEqual(
    deriveIndexReadiness(
      { status: "syncing", retryAttempt: 0 },
      health,
    ),
    {
      ready: false,
      state: "syncing",
      retryAttempt: 0,
      lastCompletedAt: null,
    },
  );
  assert.deepEqual(
    deriveIndexReadiness(
      { status: "ready", retryAttempt: 0, lastCompletedAt: 123 },
      health,
    ),
    {
      ready: true,
      state: "ready",
      retryAttempt: 0,
      lastCompletedAt: 123,
    },
  );
});

test("readiness reports degradation for stopped or failed runtimes", () => {
  assert.equal(
    deriveIndexReadiness(
      { status: "error", retryAttempt: 3, lastCompletedAt: 100 },
      health,
    ).state,
    "degraded",
  );
  assert.equal(
    deriveIndexReadiness(
      { status: "ready", retryAttempt: 0, lastCompletedAt: 100 },
      { ...health, stopping: true },
    ).ready,
    false,
  );
  assert.equal(
    deriveIndexReadiness(
      { status: "ready", retryAttempt: 0, lastCompletedAt: 100 },
      { ...health, running: false },
    ).state,
    "degraded",
  );
  assert.equal(
    deriveIndexReadiness(
      { status: "idle", retryAttempt: 0 },
      { ...health, initialized: false, running: false, networkLoaded: false },
    ).state,
    "starting",
  );
});
