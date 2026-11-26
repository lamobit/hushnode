import type {
  NetworkName,
  ProviderJson,
} from "@railgun-community/shared-models";
import { settleCleanup, withTimeout } from "../async-lifecycle.js";
import { mapWithConcurrency } from "../concurrency.js";
import { RAILGUN_FEE_SELECTORS } from "./fees.js";

const MAX_PROVIDER_CANDIDATES = 12;
const MAX_PROVIDERS = 2;
const PROVIDER_DISCOVERY_CONCURRENCY = 4;
const HEAD_BLOCK_TOLERANCE = 100;

const PROVIDER_PROBE_ATTEMPTS = 2;
const PROVIDER_PROBE_RETRY_MS = 750;
const RPC_HEALTH_CHECK_TIMEOUT_MS = 12_000;

export type ProviderProbe = {
  config: ProviderJson;
  block: number;
};

export type ProviderProbeFn = (
  network: NetworkName,
  config: ProviderJson,
) => Promise<ProviderProbe | undefined>;

export type ProbeNetworkDefinition = {
  chainId: number;
  proxyContract: string;
};

export type RpcProbeProvider = {
  send(method: string, params: unknown[]): Promise<unknown>;
  getBlock(tag: "latest"): Promise<{ number: number } | null>;
  call(transaction: { to: string; data: string }): Promise<string>;
  destroy(): void | Promise<void>;
};

export type RpcProviderProbeOptions = {
  createProvider: (url: string, chainId: number) => RpcProbeProvider;
  definitionFor: (network: NetworkName) => ProbeNetworkDefinition;
  onFailure?: (host: string, error: unknown) => void;
  onCleanupFailure?: (host: string, error: unknown) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  retryMs?: number;
  timeoutMs?: number;
};

const isProviderProbe = (
  probe: ProviderProbe | undefined,
): probe is ProviderProbe => Boolean(probe);

const providerHost = (value: string): string => {
  try {
    return new URL(value).host;
  } catch {
    return "invalid provider URL";
  }
};

const rpcChainId = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    return undefined;
  }
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const isValidBlockNumber = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    // Startup may have no other active handle, so this timer must stay
    // referenced until the retry actually runs.
    setTimeout(resolve, milliseconds);
  });

export const createRpcProviderProbe = (
  options: RpcProviderProbeOptions,
): ProviderProbeFn => {
  const attempts = options.attempts ?? PROVIDER_PROBE_ATTEMPTS;
  const retryMs = options.retryMs ?? PROVIDER_PROBE_RETRY_MS;
  const timeoutMs =
    options.timeoutMs ?? RPC_HEALTH_CHECK_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("Provider probe attempts must be a positive integer.");
  }
  if (!Number.isFinite(retryMs) || retryMs < 0) {
    throw new Error("Provider probe retry delay must be non-negative.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Provider probe timeout must be non-negative.");
  }

  return async (network, providerConfig) => {
    const definition = options.definitionFor(network);
    const url = providerConfig.provider;
    const host = providerHost(url);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let provider: RpcProbeProvider | undefined;
      try {
        const activeProvider = options.createProvider(
          url,
          definition.chainId,
        );
        provider = activeProvider;
        // Static networks skip ethers' own chain detection, so verify the
        // remote chain explicitly before trusting any contract response.
        const [chainIdValue, block] = await withTimeout(
          Promise.all([
            activeProvider.send("eth_chainId", []),
            activeProvider.getBlock("latest"),
          ]),
          timeoutMs,
          "RPC health check timed out.",
        );
        const chainId = rpcChainId(chainIdValue);
        if (chainId === undefined) {
          throw new Error("RPC returned an invalid chain ID.");
        }
        if (chainId !== definition.chainId) {
          throw new Error(
            `RPC chain ID mismatch: expected ${definition.chainId}, received ${chainId}.`,
          );
        }
        if (!block || !isValidBlockNumber(block.number)) {
          throw new Error("RPC returned no valid latest block.");
        }
        // Keep this batch at three calls: the SDK's fees() does the same and
        // some free RPC plans reject larger JSON-RPC batches.
        const fees = await withTimeout(
          Promise.all(
            RAILGUN_FEE_SELECTORS.map((data) =>
              activeProvider.call({
                to: definition.proxyContract,
                data,
              }),
            ),
          ),
          timeoutMs,
          "RPC fee health check timed out.",
        );
        if (fees.some((fee) => !fee || fee === "0x")) {
          throw new Error("RPC returned no RAILGUN contract data.");
        }
        return {
          config: providerConfig,
          block: block.number,
        };
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleep(retryMs);
      } finally {
        if (provider) {
          const cleanup = await settleCleanup(
            () => provider?.destroy(),
            timeoutMs,
            "RPC provider cleanup timed out.",
          );
          if (!cleanup.ok) {
            options.onCleanupFailure?.(host, cleanup.error);
          }
        }
      }
    }

    options.onFailure?.(host, lastError);
    return undefined;
  };
};

export const discoverReachableProviders = async (
  network: NetworkName,
  providers: readonly ProviderJson[],
  probe: ProviderProbeFn,
): Promise<ProviderJson[]> => {
  const unique = [
    ...new Map(
      providers.map((provider) => [provider.provider, provider]),
    ).values(),
  ].slice(0, MAX_PROVIDER_CANDIDATES);
  const probes = (
    await mapWithConcurrency(
      unique,
      PROVIDER_DISCOVERY_CONCURRENCY,
      (provider) => probe(network, provider),
    )
  ).filter(isProviderProbe);
  if (!probes.length) {
    throw new Error("No reachable RPC provider.");
  }
  const blocks = probes.map((entry) => entry.block).sort((a, b) => a - b);
  const median = blocks[Math.floor(blocks.length / 2)] ?? blocks[0]!;
  const nearHead = probes.filter(
    (entry) => Math.abs(entry.block - median) <= HEAD_BLOCK_TOLERANCE,
  );
  const priority = new Map(
    unique.map((provider, index) => [provider.provider, index]),
  );
  return (nearHead.length ? nearHead : probes)
    .sort(
      (left, right) =>
        (priority.get(left.config.provider) ?? 0) -
        (priority.get(right.config.provider) ?? 0),
    )
    // Two providers give one-of-two failover: the RAILGUN SDK's fallback
    // quorum is weight-based, so more providers actually require more
    // concurrent successes from these rate-limited public endpoints.
    .slice(0, MAX_PROVIDERS)
    .map((entry) => entry.config);
};
