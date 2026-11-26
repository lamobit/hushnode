import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { FetchRequest } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  ProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
} from "undici";
import "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("network");

const PROXY_ENV_KEYS = [
  "HUSH_NODE_NETWORK_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

export type ProxyChoice = {
  key: (typeof PROXY_ENV_KEYS)[number];
  url: string;
};

export const normalizeProxyUrl = (raw: string): string => {
  const value = raw.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Proxy URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Unsupported proxy protocol "${url.protocol}"; use an HTTP(S) proxy.`,
    );
  }
  if (!url.hostname) throw new Error("Proxy URL has no hostname.");
  return url.href.replace(/\/$/, "");
};

export const selectProxy = (
  env: NodeJS.ProcessEnv = process.env,
): ProxyChoice | undefined => {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      return { key, url: normalizeProxyUrl(value) };
    } catch (error) {
      if (key === "HUSH_NODE_NETWORK_PROXY") throw error;
      log.warn(`ignoring unusable proxy from ${key}`, error);
      continue;
    }
  }
  return undefined;
};

const proxyLabel = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
};

let initialized = false;
let configuredProxy: ProxyChoice | undefined;

/**
 * Returns the proxy selected by initializeNetwork(). Other transports that do
 * not use fetch/axios (for example libp2p TCP) can reuse the same decision.
 */
export const getNetworkProxy = (): ProxyChoice | undefined =>
  initialized ? configuredProxy : selectProxy();

export const initializeNetwork = (): void => {
  if (initialized) return;

  // Some public RPC/PPOI endpoints publish unreachable IPv6 addresses. Node's
  // happy-eyeballs attempts can then consume the full request timeout.
  dns.setDefaultResultOrder("ipv4first");
  if (typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(false);
  }

  const proxy = selectProxy();
  if (!proxy) {
    configuredProxy = undefined;
    initialized = true;
    log.info("network configured: direct connection, IPv4 preferred");
    return;
  }

  // Construct both transports before mutating process or module globals, so a
  // rejected proxy leaves initialization retryable.
  const dispatcher = new ProxyAgent(proxy.url);
  const nodeAgent = new HttpsProxyAgent(proxy.url);

  // Axios (used by the RAILGUN PPOI client) reads these at request time.
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
  ]) {
    process.env[key] = proxy.url;
  }

  // RAILGUN's fetch-based clients (QuickSync, prices, etc.).
  setGlobalDispatcher(dispatcher);
  globalThis.fetch = ((input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])) as typeof fetch;

  // RAILGUN's QuickSync/TXID GraphQL client uses @whatwg-node/fetch, which
  // calls node:http(s).request directly and ignores the fetch patched above.
  http.globalAgent = nodeAgent;
  https.globalAgent = nodeAgent as unknown as typeof https.globalAgent;

  // Ethers uses its own FetchRequest rather than global fetch.
  FetchRequest.registerGetUrl(
    FetchRequest.createGetUrlFunc({
      agent: nodeAgent,
    }),
  );

  configuredProxy = proxy;
  initialized = true;
  log.info(
    `network configured: proxy ${proxyLabel(proxy.url)} via ${proxy.key}, IPv4 preferred`,
  );
};
