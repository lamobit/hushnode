import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeBind,
  CHAIN_SYNC_INTERVAL_MAX_SECONDS,
  CHAIN_SYNC_INTERVAL_MIN_SECONDS,
  isLoopbackHost,
  parseBoundedIntegerEnv,
  parseEvmTargetList,
  parseIntegerEnv,
} from "../src/config.js";

test("loopback binds are safe without a remote acknowledgement", () => {
  for (const host of [
    "127.0.0.1",
    "127.0.0.2",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "localhost",
  ]) {
    assert.equal(isLoopbackHost(host), true);
    assert.doesNotThrow(() => assertSafeBind(host, false));
  }
});

test("non-loopback binds fail closed without explicit acknowledgement", () => {
  for (const host of [
    "0.0.0.0",
    "::",
    "10.0.0.5",
    "wallet.example.com",
    "127.evil.com",
    "127.0.0.1.evil",
    "128.0.0.1",
  ]) {
    assert.equal(isLoopbackHost(host), false);
    assert.throws(
      () => assertSafeBind(host, false),
      /Refusing to bind to non-loopback host/,
    );
    assert.doesNotThrow(() => assertSafeBind(host, true));
  }
});

test("integer environment values must be complete safe integers", () => {
  assert.equal(parseIntegerEnv(undefined, 7, "TEST_INTEGER"), 7);
  assert.equal(parseIntegerEnv("  -12 ", 7, "TEST_INTEGER"), -12);
  assert.equal(parseIntegerEnv("0", 7, "TEST_INTEGER"), 0);
  for (const value of [
    "120abc",
    "1.5",
    "1e3",
    "0x10",
    "  ",
    "9007199254740992",
  ]) {
    if (value.trim() === "") {
      assert.equal(parseIntegerEnv(value, 7, "TEST_INTEGER"), 7);
      continue;
    }
    assert.throws(
      () => parseIntegerEnv(value, 7, "TEST_INTEGER"),
      /TEST_INTEGER must be a (base-10|safe) integer/,
    );
  }
});

test("bounded integer environment values fail fast outside their range", () => {
  assert.equal(parseBoundedIntegerEnv(undefined, 7, "TEST_INTEGER", 1, 10), 7);
  assert.equal(parseBoundedIntegerEnv("1", 7, "TEST_INTEGER", 1, 10), 1);
  assert.equal(parseBoundedIntegerEnv("10", 7, "TEST_INTEGER", 1, 10), 10);
  assert.throws(
    () => parseBoundedIntegerEnv("0", 7, "TEST_INTEGER", 1, 10),
    /between 1 and 10/,
  );
  assert.throws(
    () => parseBoundedIntegerEnv("11", 7, "TEST_INTEGER", 1, 10),
    /between 1 and 10/,
  );
});

test("chain sync intervals stay within timer-safe bounds", () => {
  const envName = "HUSH_NODE_CHAIN_SYNC_INTERVAL_SECONDS";
  assert.equal(
    parseBoundedIntegerEnv(
      String(CHAIN_SYNC_INTERVAL_MIN_SECONDS),
      60,
      envName,
      CHAIN_SYNC_INTERVAL_MIN_SECONDS,
      CHAIN_SYNC_INTERVAL_MAX_SECONDS,
    ),
    CHAIN_SYNC_INTERVAL_MIN_SECONDS,
  );
  assert.equal(
    parseBoundedIntegerEnv(
      String(CHAIN_SYNC_INTERVAL_MAX_SECONDS),
      60,
      envName,
      CHAIN_SYNC_INTERVAL_MIN_SECONDS,
      CHAIN_SYNC_INTERVAL_MAX_SECONDS,
    ),
    CHAIN_SYNC_INTERVAL_MAX_SECONDS,
  );
  for (const value of [
    CHAIN_SYNC_INTERVAL_MIN_SECONDS - 1,
    CHAIN_SYNC_INTERVAL_MAX_SECONDS + 1,
  ]) {
    assert.throws(
      () =>
        parseBoundedIntegerEnv(
          String(value),
          60,
          envName,
          CHAIN_SYNC_INTERVAL_MIN_SECONDS,
          CHAIN_SYNC_INTERVAL_MAX_SECONDS,
        ),
      /between 15 and 2147483/,
    );
  }
});

test("EVM extra target lists are normalized and deduplicated", () => {
  const first = `0x${"Aa".repeat(20)}`;
  const second = `0x${"bb".repeat(20)}`;
  assert.deepEqual(
    parseEvmTargetList(
      `${first}, ${second}\n0x${"AA".repeat(20)}`,
      "LIGHT_EVM_EXTRA_TARGETS_ARBITRUM",
    ),
    [first.toLowerCase(), second],
  );
  assert.deepEqual(
    parseEvmTargetList(undefined, "LIGHT_EVM_EXTRA_TARGETS_ARBITRUM"),
    [],
  );
});

test("EVM extra target lists reject malformed addresses", () => {
  assert.throws(
    () =>
      parseEvmTargetList(
        "0x1234",
        "LIGHT_EVM_EXTRA_TARGETS_ETHEREUM",
      ),
    /0x-prefixed 20-byte addresses/,
  );
  assert.throws(
    () =>
      parseEvmTargetList(
        Array.from({ length: 129 }, () => `0x${"11".repeat(20)}`).join(","),
        "LIGHT_EVM_EXTRA_TARGETS_ETHEREUM",
      ),
    /at most 128/,
  );
});
