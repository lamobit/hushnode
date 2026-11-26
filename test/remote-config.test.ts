import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PROVIDER_URLS_PER_NETWORK } from "../src/networks.js";
import {
  MAX_BLACKLIST_ENTRIES,
  MAX_DIRECT_PEERS,
  MAX_PPOI_NODE_URLS,
  MAX_REMOTE_CONFIG_BYTES,
  MAX_REMOTE_NETWORKS,
  MAX_REMOTE_PROVIDERS_PER_NETWORK,
  MAX_TRUSTED_FEE_SIGNERS,
  applyRemoteProviders,
  effectiveRemoteConfig,
  fallbackRemoteConfig,
  loadRemoteConfig,
  parseRemoteConfigPayload,
} from "../src/railgun/remote-config.js";

test("remote config parser rejects oversized and non-object payloads", () => {
  assert.throws(
    () => parseRemoteConfigPayload("x".repeat(MAX_REMOTE_CONFIG_BYTES + 1)),
    /size limit/,
  );
  assert.throws(
    () => parseRemoteConfigPayload("[]"),
    /JSON object/,
  );
  assert.throws(
    () => parseRemoteConfigPayload("{"),
    SyntaxError,
  );
});

test("remote config parser drops malformed fields and bounds lists", () => {
  const prototypeNetwork = JSON.parse(
    '{"__proto__":{"providers":["https://prototype.example"]}}',
  ) as Record<string, unknown>;
  const config = parseRemoteConfigPayload(
    JSON.stringify({
      currentVersionNumber: "1".repeat(65),
      wakuPubSubTopic: " /waku/2/rs/5/1 ",
      additionalDirectPeers: Array.from(
        { length: MAX_DIRECT_PEERS + 4 },
        (_, index) => `/ip4/127.0.0.1/tcp/${30_000 + index}`,
      ),
      publicPoiAggregatorUrls: [
        "file:///tmp/poi",
        "not a URL",
        ...Array.from(
          { length: MAX_PPOI_NODE_URLS + 4 },
          (_, index) => `https://poi-${index}.example/`,
        ),
      ],
      blacklist: Array.from(
        { length: MAX_BLACKLIST_ENTRIES + 100 },
        (_, index) => `0x${index.toString(16).padStart(40, "0")}`,
      ),
      trustedFeeSigner: Array.from(
        { length: MAX_TRUSTED_FEE_SIGNERS + 4 },
        (_, index) => `0zk${index.toString(36)}`,
      ),
      network: {
        "1": {
          providers: [
            "https://rpc-0.example",
            "wss://rpc-1.example",
            "ftp://rpc-invalid.example",
            "not a URL",
            ...Array.from(
              { length: MAX_REMOTE_PROVIDERS_PER_NETWORK + 8 },
              (_, index) => `https://rpc-${index + 2}.example`,
            ),
          ],
        },
        "42161": {
          providers: [42, { provider: 43 }, { provider: null }],
        },
        "56": {
          providers: ["https://bsc.example"],
        },
        ...prototypeNetwork,
      },
    }),
  );

  assert.equal(config.currentVersionNumber, undefined);
  assert.equal(config.wakuPubSubTopic, "/waku/2/rs/5/1");
  assert.equal(config.additionalDirectPeers?.length, MAX_DIRECT_PEERS);
  assert.equal(
    config.publicPoiAggregatorUrls?.length,
    MAX_PPOI_NODE_URLS,
  );
  assert.equal(
    config.publicPoiAggregatorUrls?.[0],
    "https://poi-0.example",
  );
  assert.equal(config.blacklist?.length, MAX_BLACKLIST_ENTRIES);
  assert.equal(config.trustedFeeSigner?.length, MAX_TRUSTED_FEE_SIGNERS);

  const providers = config.network?.["1"]?.providers;
  assert.equal(providers?.length, MAX_REMOTE_PROVIDERS_PER_NETWORK);
  assert.equal(providers?.[0], "https://rpc-0.example");
  assert.equal(providers?.[1], "wss://rpc-1.example");
  assert.equal(
    providers?.some((provider) => /^ftp:/i.test(String(provider))),
    false,
  );
  assert.deepEqual(config.network?.["56"]?.providers, [
    "https://bsc.example",
  ]);
  assert.equal(config.network?.["42161"], undefined);
  assert.equal(Object.hasOwn(config.network ?? {}, "__proto__"), false);
});

test("remote providers are merged ahead of built-ins with hard caps", () => {
  const network = {
    chainId: 1,
    providers: Array.from(
      { length: MAX_PROVIDER_URLS_PER_NETWORK },
      (_, index) => `https://builtin-${index}.example`,
    ),
  };
  const config = {
    network: {
      "1": {
        providers: [
          "https://remote-0.example",
          "ftp://remote-invalid.example",
          ...Array.from(
            { length: MAX_REMOTE_PROVIDERS_PER_NETWORK + 8 },
            (_, index) => `https://remote-${index + 1}.example`,
          ),
        ],
      },
      "999": {
        providers: ["https://unknown-chain.example"],
      },
    },
  };

  assert.equal(applyRemoteProviders(config, [network]), 1);
  assert.equal(network.providers.length, MAX_PROVIDER_URLS_PER_NETWORK);
  assert.equal(network.providers[0], "https://remote-0.example");
  assert.equal(
    network.providers[1],
    "https://remote-1.example",
  );
  assert.equal(
    network.providers[MAX_REMOTE_PROVIDERS_PER_NETWORK],
    "https://builtin-0.example",
  );
  assert.equal(
    network.providers.some((provider) => /^ftp:/i.test(provider)),
    false,
  );
  assert.equal(applyRemoteProviders(config, [network]), 0);
});

test("remote config accepts valid networks after malformed entries", () => {
  const network = Object.fromEntries([
    ...Array.from(
      { length: MAX_REMOTE_NETWORKS + 8 },
      (_, index) => [
        `invalid-${index}`,
        { providers: ["https://ignored.example"] },
      ],
    ),
    ...Array.from(
      { length: MAX_REMOTE_NETWORKS + 4 },
      (_, index) => [
        String(1_000 + index),
        { providers: [`https://chain-${index}.example`] },
      ],
    ),
  ]);

  const config = parseRemoteConfigPayload(JSON.stringify({ network }));
  assert.equal(
    Object.keys(config.network ?? {}).length,
    MAX_REMOTE_NETWORKS,
  );
  assert.deepEqual(config.network?.["1000"]?.providers, [
    "https://chain-0.example",
  ]);
  assert.deepEqual(
    config.network?.[String(1_000 + MAX_REMOTE_NETWORKS - 1)]?.providers,
    [
      `https://chain-${MAX_REMOTE_NETWORKS - 1}.example`,
    ],
  );
  assert.equal(
    config.network?.[String(1_000 + MAX_REMOTE_NETWORKS)],
    undefined,
  );
});

test("effective remote config normalizes topic, PPOI URLs, and fee signers", () => {
  const effective = effectiveRemoteConfig(
    {
      wakuPubSubTopic: "invalid topic",
      publicPoiAggregatorUrls: [
        "file:///tmp/poi",
        "https://poi.example/",
      ],
      trustedFeeSigner: ["0ZKFEESIGNER"],
    },
    "remote",
  );

  assert.equal(effective.pubSubTopic, "/waku/2/rs/5/1");
  assert.deepEqual(effective.poiNodeUrls, ["https://poi.example"]);
  assert.deepEqual(effective.trustedFeeSigners, [
    "0ZKFEESIGNER".toLowerCase(),
  ]);
  assert.equal(effective.source, "remote");

  const fallback = fallbackRemoteConfig();
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(fallback.poiNodeUrls, ["https://ppoi.fdi.network"]);
  assert.equal(fallback.trustedFeeSigners.length, 1);
});

test("remote config loading falls back without attempting invalid RPC URLs", async () => {
  const config = await loadRemoteConfig([
    "file:///tmp/rpc",
    "not a URL",
  ]);
  assert.equal(config.source, "fallback");
  assert.deepEqual(config.poiNodeUrls, ["https://ppoi.fdi.network"]);
});
