import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProxyUrl,
  selectProxy,
} from "../src/network.js";

test("proxy URLs normalize without altering supported values", () => {
  assert.equal(
    normalizeProxyUrl("proxy.example:8080"),
    "http://proxy.example:8080",
  );
});

test("proxy URLs normalize schemes, whitespace, and trailing slashes", () => {
  assert.equal(
    normalizeProxyUrl("  HTTPS://Proxy.Example:8443/  "),
    "https://proxy.example:8443",
  );
});

test("proxy URLs reject unsupported protocols and missing hosts", () => {
  assert.throws(
    () => normalizeProxyUrl("socks5://proxy.example:1080"),
    /Unsupported proxy protocol/,
  );
  assert.throws(
    () => normalizeProxyUrl("http://:8080"),
    /not a valid URL/,
  );
});

test("proxy selection honors explicit precedence and schema fallback", () => {
  assert.deepEqual(
    selectProxy({
      HUSH_NODE_NETWORK_PROXY: "proxy.internal:8080",
      HTTPS_PROXY: "http://generic.example:8080",
    }),
    {
      key: "HUSH_NODE_NETWORK_PROXY",
      url: "http://proxy.internal:8080",
    },
  );
  assert.deepEqual(selectProxy({}), undefined);
});

test("proxy selection ignores malformed generic environment values", (context) => {
  context.mock.method(console, "warn", () => undefined);
  assert.deepEqual(
    selectProxy({
      HTTPS_PROXY: "socks5://unsupported.example:1080",
      HTTP_PROXY: "fallback.example:3128",
    }),
    {
      key: "HTTP_PROXY",
      url: "http://fallback.example:3128",
    },
  );
});

test("the explicit proxy setting fails closed when malformed", () => {
  assert.throws(
    () =>
      selectProxy({
        HUSH_NODE_NETWORK_PROXY: "socks5://unsupported.example:1080",
        HTTPS_PROXY: "http://fallback.example:8080",
      }),
    /Unsupported proxy protocol/,
  );
});

test("proxy URL errors do not echo credentials", () => {
  const credential = ["unit", "test", "credential"].join("-");
  const malformed = `http://user:${credential}@[invalid`;

  assert.throws(
    () => normalizeProxyUrl(malformed),
    (error) =>
      error instanceof Error &&
      error.message === "Proxy URL is not a valid URL." &&
      !error.message.includes(credential),
  );
});
