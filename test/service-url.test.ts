import assert from "node:assert/strict";
import test from "node:test";
import {
  HTTP_URL_PROTOCOLS,
  RPC_URL_PROTOCOLS,
  normalizeServiceUrl,
} from "../src/service-url.js";

test("service URL normalization enforces protocols and canonical form", () => {
  assert.equal(
    normalizeServiceUrl(" https://example.com/rpc ", RPC_URL_PROTOCOLS),
    "https://example.com/rpc",
  );
  assert.equal(
    normalizeServiceUrl("wss://example.com/socket", RPC_URL_PROTOCOLS),
    "wss://example.com/socket",
  );
  assert.equal(
    normalizeServiceUrl("wss://example.com/socket", HTTP_URL_PROTOCOLS),
    undefined,
  );
  assert.equal(
    normalizeServiceUrl("file:///tmp/rpc", RPC_URL_PROTOCOLS),
    undefined,
  );
  assert.equal(normalizeServiceUrl("not a URL", RPC_URL_PROTOCOLS), undefined);
});

test("service URL normalization strips trailing slashes when requested", () => {
  assert.equal(
    normalizeServiceUrl("https://poi.example/", HTTP_URL_PROTOCOLS, {
      stripTrailingSlash: true,
    }),
    "https://poi.example",
  );
  assert.equal(
    normalizeServiceUrl("https://example.com/", RPC_URL_PROTOCOLS, {
      maxLength: 10,
    }),
    undefined,
  );
});
