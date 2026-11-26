import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { NetworkName } from "@railgun-community/shared-models";
import dotenv from "dotenv";

export const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const CHAIN_SYNC_INTERVAL_MIN_SECONDS = 15;
export const CHAIN_SYNC_INTERVAL_MAX_SECONDS = Math.floor(
  MAX_TIMER_DELAY_MS / 1_000,
);

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

export const parseIntegerEnv = (
  value: string | undefined,
  fallback: number,
  envName: string,
): number => {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${envName} must be a base-10 integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${envName} must be a safe integer.`);
  }
  return parsed;
};

export const parseBoundedIntegerEnv = (
  value: string | undefined,
  fallback: number,
  envName: string,
  minimum: number,
  maximum: number,
): number => {
  const parsed = parseIntegerEnv(value, fallback, envName);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(
      `${envName} must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
};

const envInteger = (envName: string, fallback: number): number =>
  parseIntegerEnv(process.env[envName], fallback, envName);

const boundedEnvInteger = (
  envName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number =>
  parseBoundedIntegerEnv(
    process.env[envName],
    fallback,
    envName,
    minimum,
    maximum,
  );

export const parseEvmTargetList = (
  value: string | undefined,
  envName: string,
): string[] => {
  const entries = (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > 128) {
    throw new Error(`${envName} must contain at most 128 addresses.`);
  }
  const invalid = entries.filter(
    (entry) => !/^0x[0-9a-fA-F]{40}$/.test(entry),
  );
  if (invalid.length > 0) {
    throw new Error(
      `${envName} must contain 0x-prefixed 20-byte addresses.`,
    );
  }
  return [...new Set(entries.map((entry) => entry.toLowerCase()))];
};

const isLoopbackIpv4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    ) &&
    octets[0] === 127
  );
};

const isLoopbackIpv6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isLoopbackIpv4(mapped[1]);

  const groups = normalized.split(":");
  return (
    groups.length === 8 &&
    groups.slice(0, 7).every((group) => /^0+$/.test(group)) &&
    /^0*1$/.test(groups[7] ?? "")
  );
};

export const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost") return true;
  const address =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  const family = isIP(address);
  if (family === 4) return isLoopbackIpv4(address);
  if (family === 6) return isLoopbackIpv6(address);
  return false;
};

export const assertSafeBind = (
  host: string,
  allowPlaintextRemote: boolean,
): void => {
  if (isLoopbackHost(host) || allowPlaintextRemote) return;
  throw new Error(
    `Refusing to bind to non-loopback host "${host}" without TLS. ` +
      "Set ALLOW_PLAINTEXT_REMOTE=true only behind a trusted TLS reverse proxy.",
  );
};

const rawHost = process.env.HOST?.trim() || "127.0.0.1";
const port = envInteger("PORT", 8788);
if (port < 1 || port > 65_535) {
  throw new Error("PORT must be between 1 and 65535.");
}
const dataDir = path.resolve(
  process.env.HUSH_NODE_DATA_DIR?.trim() ||
    path.join(PROJECT_ROOT, "data"),
);
const allowPlaintextRemote =
  process.env.ALLOW_PLAINTEXT_REMOTE?.trim().toLowerCase() === "true";
const lightApiEnabled =
  process.env.LIGHT_API_ENABLED?.trim().toLowerCase() !== "false";
const lightCorsOrigins = (process.env.LIGHT_CORS_ORIGINS ?? "")
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const lightRelayEnabled =
  process.env.LIGHT_RELAY_ENABLED?.trim().toLowerCase() === "true";
const lightRelayMaxBytes = boundedEnvInteger(
  "LIGHT_RELAY_MAX_BYTES",
  131_072,
  1_024,
  1_048_576,
);
const lightRelayRatePerMinute = boundedEnvInteger(
  "LIGHT_RELAY_RATE_PER_MINUTE",
  12,
  1,
  600,
);
const lightEvmRatePerMinute = boundedEnvInteger(
  "LIGHT_EVM_RATE_PER_MINUTE",
  120,
  10,
  1_200,
);
const lightAnchorRatePerMinute = boundedEnvInteger(
  "LIGHT_ANCHOR_RATE_PER_MINUTE",
  60,
  10,
  1_200,
);
const lightReadRatePerMinute = boundedEnvInteger(
  "LIGHT_READ_RATE_PER_MINUTE",
  300,
  10,
  6_000,
);
const lightTrustProxyHops = boundedEnvInteger(
  "LIGHT_TRUST_PROXY_HOPS",
  0,
  0,
  16,
);
const lightEvmExtraTargets = {
  [NetworkName.Ethereum]: parseEvmTargetList(
    process.env.LIGHT_EVM_EXTRA_TARGETS_ETHEREUM,
    "LIGHT_EVM_EXTRA_TARGETS_ETHEREUM",
  ),
  [NetworkName.Arbitrum]: parseEvmTargetList(
    process.env.LIGHT_EVM_EXTRA_TARGETS_ARBITRUM,
    "LIGHT_EVM_EXTRA_TARGETS_ARBITRUM",
  ),
};
const lightScanSetting =
  process.env.LIGHT_SCAN_ENABLED?.trim().toLowerCase();
const lightScanToken = process.env.LIGHT_SCAN_TOKEN?.trim() ?? "";
const lightScanEnabled =
  lightScanSetting === "true" ||
  (lightScanSetting !== "false" &&
    lightApiEnabled &&
    lightScanToken.length > 0);
if (lightScanEnabled) {
  if (!lightApiEnabled) {
    throw new Error(
      "LIGHT_SCAN_ENABLED requires LIGHT_API_ENABLED=true.",
    );
  }
  if (lightScanToken.length < 24) {
    throw new Error(
      "LIGHT_SCAN_TOKEN must be at least 24 characters when scan is enabled.",
    );
  }
}
const lightBroadcasterEnabled =
  process.env.LIGHT_BROADCASTER_ENABLED?.trim().toLowerCase() === "true";
if (lightBroadcasterEnabled && !lightApiEnabled) {
  throw new Error(
    "LIGHT_BROADCASTER_ENABLED requires LIGHT_API_ENABLED=true.",
  );
}
const lightBroadcasterRatePerMinute = boundedEnvInteger(
  "LIGHT_BROADCASTER_RATE_PER_MINUTE",
  30,
  1,
  600,
);
const lightBroadcasterTransactRatePerMinute = boundedEnvInteger(
  "LIGHT_BROADCASTER_TRANSACT_RATE_PER_MINUTE",
  10,
  1,
  600,
);
const lightScanMaxJobs = boundedEnvInteger(
  "LIGHT_SCAN_MAX_JOBS",
  1,
  1,
  4,
);
const lightScanTtlSeconds = boundedEnvInteger(
  "LIGHT_SCAN_TTL_SECONDS",
  120,
  60,
  3_600,
);
const lightScanTimeoutSeconds = boundedEnvInteger(
  "LIGHT_SCAN_TIMEOUT_SECONDS",
  900,
  60,
  3_600,
);
const lightScanRatePerMinute = boundedEnvInteger(
  "LIGHT_SCAN_RATE_PER_MINUTE",
  6,
  1,
  120,
);
const lightScanMaxNotes = boundedEnvInteger(
  "LIGHT_SCAN_MAX_NOTES",
  5_000,
  100,
  20_000,
);
// Read by the vendored engine patch while decrypting; validated here so a bad
// value fails the process at startup instead of silently using the fallback.
const lightScanBatchSize = boundedEnvInteger(
  "HUSH_SCAN_BATCH_SIZE",
  200,
  100,
  4_000,
);
const lightScanCacheDir = path.resolve(
  process.env.LIGHT_SCAN_CACHE_DIR?.trim() ||
    path.join(dataDir, "scan"),
);
const lightScanCacheTtlSeconds = boundedEnvInteger(
  "LIGHT_SCAN_CACHE_TTL_SECONDS",
  7 * 24 * 60 * 60,
  0,
  365 * 24 * 60 * 60,
);
const lightScanCacheMaxBuckets = boundedEnvInteger(
  "LIGHT_SCAN_CACHE_MAX_BUCKETS",
  64,
  1,
  1_024,
);
const lightScanCacheMaxBytes = boundedEnvInteger(
  "LIGHT_SCAN_CACHE_MAX_BYTES",
  512 * 1024 * 1024,
  32 * 1024 * 1024,
  8 * 1024 * 1024 * 1024,
);
const chainSyncIntervalSeconds = boundedEnvInteger(
  "HUSH_NODE_CHAIN_SYNC_INTERVAL_SECONDS",
  60,
  CHAIN_SYNC_INTERVAL_MIN_SECONDS,
  CHAIN_SYNC_INTERVAL_MAX_SECONDS,
);
export const config = {
  host: rawHost,
  port,
  dataDir,
  engineDatabasePath: path.join(dataDir, "railgun", "db"),
  engineArtifactPath: path.join(dataDir, "railgun", "artifacts"),
  allowPlaintextRemote,
  lightApiEnabled,
  lightCorsOrigins,
  lightRelayEnabled,
  lightRelayMaxBytes,
  lightRelayRatePerMinute,
  lightBroadcasterEnabled,
  lightBroadcasterRatePerMinute,
  lightBroadcasterTransactRatePerMinute,
  lightEvmRatePerMinute,
  lightAnchorRatePerMinute,
  lightReadRatePerMinute,
  lightTrustProxyHops,
  lightEvmExtraTargets,
  lightScanEnabled,
  lightScanToken,
  lightScanMaxJobs,
  lightScanTtlMs: lightScanTtlSeconds * 1_000,
  lightScanTimeoutMs: lightScanTimeoutSeconds * 1_000,
  lightScanRatePerMinute,
  lightScanMaxNotes,
  lightScanBatchSize,
  lightScanCacheDir,
  lightScanCacheTtlMs: lightScanCacheTtlSeconds * 1_000,
  lightScanCacheMaxBuckets,
  lightScanCacheMaxBytes,
  chainSyncIntervalMs: chainSyncIntervalSeconds * 1_000,
  isLoopback: isLoopbackHost(rawHost),
} as const;
