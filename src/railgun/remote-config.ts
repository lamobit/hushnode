import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  Network,
  WebSocketProvider,
} from "ethers";
import type { ProviderJson } from "@railgun-community/shared-models";
import { settleCleanup, withTimeout } from "../async-lifecycle.js";
import {
  HTTP_URL_PROTOCOLS,
  normalizeServiceUrl,
} from "../service-url.js";
import { createLogger } from "../logger.js";
import {
  MAX_PROVIDER_URLS_PER_NETWORK,
  NETWORKS,
  applyProviderOverrides,
  normalizeProviderUrls,
  type NetworkDefinition,
} from "../networks.js";

const log = createLogger("remote-config");

const REMOTE_CONFIG_CONTRACT =
  "0x5e982525d50046A813DBf55Ae72a3E00e99fbC94";
const ETHEREUM_MAINNET = Network.from(1);
const REMOTE_CONFIG_TIMEOUT_MS = 8_000;
const FALLBACK_TRUSTED_FEE_SIGNER =
  "0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k";
const DEFAULT_PUB_SUB_TOPIC = "/waku/2/rs/5/1";

export const MAX_REMOTE_CONFIG_BYTES = 256 * 1024;
export const MAX_REMOTE_CONFIG_RPC_RESPONSE_BYTES =
  MAX_REMOTE_CONFIG_BYTES * 3;
export const MAX_REMOTE_CONFIG_RPC_URLS = 8;
export const MAX_REMOTE_NETWORKS = 32;
export const MAX_REMOTE_PROVIDERS_PER_NETWORK = 8;
export const MAX_DIRECT_PEERS = 64;
export const MAX_PPOI_NODE_URLS = 16;
export const MAX_BLACKLIST_ENTRIES = 4_096;
export const MAX_TRUSTED_FEE_SIGNERS = 32;

const MAX_REMOTE_TOPIC_LENGTH = 256;
const MAX_DIRECT_PEER_LENGTH = 2_048;
const MAX_BLACKLIST_ENTRY_LENGTH = 256;
const MAX_FEE_SIGNER_LENGTH = 256;
const MAX_VERSION_LENGTH = 64;
const CHAIN_ID_PATTERN = /^\d+$/;

export const DEFAULT_PPOI_NODE_URLS = [
  "https://ppoi.fdi.network",
] as const;

export type RemoteNetworkConfig = {
  name?: string;
  providers?: Array<string | ProviderJson>;
  flags?: Record<string, boolean>;
};

export type RemoteConfig = {
  currentVersionNumber?: string;
  minVersionNumber?: string;
  wakuPubSubTopic?: string;
  additionalDirectPeers?: string[];
  publicPoiAggregatorUrls?: string[];
  blacklist?: string[];
  network?: Record<string, RemoteNetworkConfig>;
  trustedFeeSigner?: string | string[];
};

export type EffectiveRemoteConfig = {
  pubSubTopic: string;
  additionalDirectPeers: string[];
  poiNodeUrls: string[];
  blacklist: string[];
  trustedFeeSigners: string[];
  source: "remote" | "fallback";
};

type ProviderNetwork = Pick<NetworkDefinition, "chainId" | "providers">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asValues = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [value];

const boundedStrings = (
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] => {
  const strings: string[] = [];
  const seen = new Set<string>();
  for (const item of asValues(value)) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > maxLength || seen.has(trimmed)) continue;
    seen.add(trimmed);
    strings.push(trimmed);
    if (strings.length >= maxItems) break;
  }
  return strings;
};

const boundedString = (
  value: unknown,
  maxLength: number,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
};

const boundedHttpUrls = (
  value: unknown,
  maxItems: number,
): string[] => {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of asValues(value)) {
    const url = normalizeServiceUrl(item, HTTP_URL_PROTOCOLS, {
      stripTrailingSlash: true,
    });
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= maxItems) break;
  }
  return urls;
};

const providerValues = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const providers: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      providers.push(item);
    } else if (isRecord(item) && typeof item.provider === "string") {
      providers.push(item.provider);
    }
  }
  return providers;
};

const parseRemoteNetworks = (
  value: unknown,
): Record<string, RemoteNetworkConfig> | undefined => {
  if (!isRecord(value)) return undefined;
  const networks: Record<string, RemoteNetworkConfig> = {};
  let accepted = 0;
  for (const [chainId, rawNetwork] of Object.entries(value)) {
    if (accepted >= MAX_REMOTE_NETWORKS) break;
    if (!CHAIN_ID_PATTERN.test(chainId) || !isRecord(rawNetwork)) continue;
    const providers = normalizeProviderUrls(
      providerValues(rawNetwork.providers),
      MAX_REMOTE_PROVIDERS_PER_NETWORK,
    );
    if (providers.length > 0) {
      networks[chainId] = { providers };
      accepted += 1;
    }
  }
  return Object.keys(networks).length > 0 ? networks : undefined;
};

export const parseRemoteConfigPayload = (raw: string): RemoteConfig => {
  if (Buffer.byteLength(raw, "utf8") > MAX_REMOTE_CONFIG_BYTES) {
    throw new Error("Remote config exceeds the configured size limit.");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("Remote config must be a JSON object.");
  }

  const config: RemoteConfig = {};
  const currentVersionNumber = boundedString(
    parsed.currentVersionNumber,
    MAX_VERSION_LENGTH,
  );
  if (currentVersionNumber) {
    config.currentVersionNumber = currentVersionNumber;
  }
  const minVersionNumber = boundedString(
    parsed.minVersionNumber,
    MAX_VERSION_LENGTH,
  );
  if (minVersionNumber) {
    config.minVersionNumber = minVersionNumber;
  }
  const pubSubTopic = boundedString(
    parsed.wakuPubSubTopic,
    MAX_REMOTE_TOPIC_LENGTH,
  );
  if (pubSubTopic) config.wakuPubSubTopic = pubSubTopic;

  const directPeers = boundedStrings(
    parsed.additionalDirectPeers,
    MAX_DIRECT_PEERS,
    MAX_DIRECT_PEER_LENGTH,
  );
  if (directPeers.length > 0) {
    config.additionalDirectPeers = directPeers;
  }

  const poiNodeUrls = boundedHttpUrls(
    parsed.publicPoiAggregatorUrls,
    MAX_PPOI_NODE_URLS,
  );
  if (poiNodeUrls.length > 0) {
    config.publicPoiAggregatorUrls = poiNodeUrls;
  }

  const blacklist = boundedStrings(
    parsed.blacklist,
    MAX_BLACKLIST_ENTRIES,
    MAX_BLACKLIST_ENTRY_LENGTH,
  );
  if (blacklist.length > 0) config.blacklist = blacklist;

  const trustedFeeSigners = boundedStrings(
    parsed.trustedFeeSigner,
    MAX_TRUSTED_FEE_SIGNERS,
    MAX_FEE_SIGNER_LENGTH,
  );
  if (trustedFeeSigners.length > 0) {
    config.trustedFeeSigner = trustedFeeSigners;
  }

  const networks = parseRemoteNetworks(parsed.network);
  if (networks) config.network = networks;
  return config;
};

export const applyRemoteProviders = (
  config: RemoteConfig,
  networks: readonly ProviderNetwork[],
): number => {
  let changed = 0;
  for (const [chainIdText, remoteNetwork] of Object.entries(
    config.network ?? {},
  )) {
    if (!CHAIN_ID_PATTERN.test(chainIdText)) continue;
    const chainId = Number(chainIdText);
    if (!Number.isSafeInteger(chainId)) continue;
    const network = networks.find((entry) => entry.chainId === chainId);
    if (!network) continue;

    const remoteProviders = normalizeProviderUrls(
      providerValues(remoteNetwork.providers),
      MAX_REMOTE_PROVIDERS_PER_NETWORK,
    );
    if (remoteProviders.length === 0) continue;
    const merged = normalizeProviderUrls(
      [...remoteProviders, ...network.providers],
      MAX_PROVIDER_URLS_PER_NETWORK,
    );
    if (
      merged.length === network.providers.length &&
      merged.every((provider, index) => provider === network.providers[index])
    ) {
      continue;
    }
    network.providers = merged;
    changed += 1;
  }
  return changed;
};

export const effectiveRemoteConfig = (
  config: RemoteConfig,
  source: "remote" | "fallback",
): EffectiveRemoteConfig => {
  const configuredPoiUrls = boundedHttpUrls(
    config.publicPoiAggregatorUrls,
    MAX_PPOI_NODE_URLS,
  );
  const configuredFeeSigners = boundedStrings(
    config.trustedFeeSigner,
    MAX_TRUSTED_FEE_SIGNERS,
    MAX_FEE_SIGNER_LENGTH,
  ).map((value) => value.toLowerCase());
  const configuredTopic = boundedString(
    config.wakuPubSubTopic,
    MAX_REMOTE_TOPIC_LENGTH,
  );

  return {
    pubSubTopic:
      configuredTopic && !/\s/.test(configuredTopic)
        ? configuredTopic
        : DEFAULT_PUB_SUB_TOPIC,
    additionalDirectPeers: boundedStrings(
      config.additionalDirectPeers,
      MAX_DIRECT_PEERS,
      MAX_DIRECT_PEER_LENGTH,
    ),
    poiNodeUrls:
      configuredPoiUrls.length > 0
        ? configuredPoiUrls
        : [...DEFAULT_PPOI_NODE_URLS],
    blacklist: boundedStrings(
      config.blacklist,
      MAX_BLACKLIST_ENTRIES,
      MAX_BLACKLIST_ENTRY_LENGTH,
    ),
    trustedFeeSigners:
      configuredFeeSigners.length > 0
        ? configuredFeeSigners
        : [FALLBACK_TRUSTED_FEE_SIGNER],
    source,
  };
};

export const fallbackRemoteConfig = (): EffectiveRemoteConfig =>
  effectiveRemoteConfig({}, "fallback");

const createRemoteConfigRequest = (rpcUrl: string): FetchRequest => {
  const request = new FetchRequest(rpcUrl);
  request.timeout = REMOTE_CONFIG_TIMEOUT_MS;
  request.processFunc = async (_request, response) => {
    const declared = Number(response.headers["content-length"]);
    if (
      Number.isFinite(declared) &&
      declared > MAX_REMOTE_CONFIG_RPC_RESPONSE_BYTES
    ) {
      throw new Error(
        "Remote config RPC response exceeds the configured size limit.",
      );
    }
    const body = response.body;
    if (
      body &&
      body.byteLength > MAX_REMOTE_CONFIG_RPC_RESPONSE_BYTES
    ) {
      throw new Error(
        "Remote config RPC response exceeds the configured size limit.",
      );
    }
    return response;
  };
  return request;
};

const fetchRemoteConfig = async (rpcUrl: string): Promise<RemoteConfig> => {
  const provider = /^wss?:/i.test(rpcUrl)
    ? new WebSocketProvider(rpcUrl, ETHEREUM_MAINNET, {
        staticNetwork: true,
      })
    : new JsonRpcProvider(createRemoteConfigRequest(rpcUrl), ETHEREUM_MAINNET, {
        staticNetwork: true,
      });
  try {
    const contract = new Contract(
      REMOTE_CONFIG_CONTRACT,
      ["function getConfig() public view returns (string memory str)"],
      provider,
    );
    const raw = await withTimeout(
      contract.getFunction("getConfig")() as Promise<string>,
      REMOTE_CONFIG_TIMEOUT_MS,
      "remote config request timed out",
    );
    return parseRemoteConfigPayload(raw);
  } finally {
    const cleanup = await settleCleanup(
      () => provider.destroy(),
      REMOTE_CONFIG_TIMEOUT_MS,
      "Remote config provider cleanup timed out.",
    );
    if (!cleanup.ok) {
      log.warn("remote config provider cleanup failed", cleanup.error);
    }
  }
};

export const loadRemoteConfig = async (
  rpcUrls: string[],
): Promise<EffectiveRemoteConfig> => {
  const urls = normalizeProviderUrls(rpcUrls, MAX_REMOTE_CONFIG_RPC_URLS);
  if (urls.length === 0) return fallbackRemoteConfig();

  try {
    // The remote-config contract only exists on Ethereum mainnet. Read it from
    // the configured Ethereum RPC list, letting the first successful node win.
    const parsed = await Promise.any(
      urls.map((rpcUrl) => fetchRemoteConfig(rpcUrl)),
    );
    const changed = applyRemoteProviders(parsed, NETWORKS);
    applyProviderOverrides();
    const result = effectiveRemoteConfig(parsed, "remote");
    log.info(`loaded remote config; ${changed} RPC list(s) updated`);
    return result;
  } catch (error) {
    log.warn(
      "remote config unavailable; using built-in RPCs and trusted fee signer",
      error,
    );
    return fallbackRemoteConfig();
  }
};
