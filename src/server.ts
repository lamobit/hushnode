import http from "node:http";
import {
  ChainSyncService,
  CHAIN_SYNC_STOP_TIMEOUT_MS,
} from "./chain-sync-service.js";
import {
  assertSafeBind,
  config,
} from "./config.js";
import { closeHttpServer } from "./http-shutdown.js";
import { createHttpApp } from "./http-app.js";
import { createChainSyncLightSource } from "./light-api.js";
import {
  createRemoteScanRunner,
  RemoteScanService,
  REMOTE_SCAN_STOP_TIMEOUT_MS,
} from "./light-scan.js";
import { createLogger } from "./logger.js";
import { initializeNetwork } from "./network.js";
import { BroadcasterNetwork } from "./railgun/broadcasters.js";
import { BroadcasterRelay } from "./railgun/broadcaster-relay.js";

const log = createLogger("server");
const chainSync = new ChainSyncService();
// The engine patch reads this while decrypting a scan batch; config.ts has
// already validated and clamped the value.
process.env.HUSH_SCAN_BATCH_SIZE = String(config.lightScanBatchSize);
const remoteScan = config.lightScanEnabled
  ? new RemoteScanService({
      enabled: true,
      token: config.lightScanToken,
      runner: createRemoteScanRunner(chainSync, {
        maxNotes: config.lightScanMaxNotes,
        cache:
          config.lightScanCacheTtlMs > 0
            ? {
                rootDir: config.lightScanCacheDir,
                ttlMs: config.lightScanCacheTtlMs,
                maxBuckets: config.lightScanCacheMaxBuckets,
                maxTotalBytes: config.lightScanCacheMaxBytes,
              }
            : undefined,
      }),
      maxJobs: config.lightScanMaxJobs,
      ttlMs: config.lightScanTtlMs,
      timeoutMs: config.lightScanTimeoutMs,
      maxNotes: config.lightScanMaxNotes,
      ratePerMinute: config.lightScanRatePerMinute,
    })
  : undefined;

const SHUTDOWN_DRAIN_TIMEOUT_MS = 35_000;
const INTERACTIVE_DRAIN_TIMEOUT_MS = 5_000;
const SHUTDOWN_CLEANUP_GRACE_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS =
  SHUTDOWN_DRAIN_TIMEOUT_MS +
  REMOTE_SCAN_STOP_TIMEOUT_MS +
  CHAIN_SYNC_STOP_TIMEOUT_MS +
  SHUTDOWN_CLEANUP_GRACE_MS;

let httpServer: http.Server | undefined;
let broadcasterRelay: BroadcasterRelay | undefined;
let shuttingDown = false;
let shutdownExitCode = 0;
let shutdownPromise: Promise<void> | undefined;

const shutdown = (
  reason: string,
  exitCode = 0,
  drainTimeoutMs = SHUTDOWN_DRAIN_TIMEOUT_MS,
): Promise<void> => {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  log.info(`shutting down (${reason})`);
  shutdownPromise = (async () => {
    const deadline = setTimeout(() => {
      log.error(
        `graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS / 1_000}s; terminating`,
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    if (httpServer) {
      await closeHttpServer(httpServer, {
        drainTimeoutMs,
        onError: (error) => {
          log.error("HTTP server close failed", error);
          shutdownExitCode = 1;
        },
      });
      log.info("HTTP server stopped");
    }

    const cleanup = async (
      label: string,
      operation: () => Promise<unknown>,
    ) => {
      try {
        await operation();
      } catch (error) {
        log.error(`${label} cleanup failed`, error);
        shutdownExitCode = 1;
      }
    };
    await cleanup("remote scan", async () => remoteScan?.stop());
    await cleanup("broadcaster relay", async () => broadcasterRelay?.stop());
    await cleanup("chain sync", () => chainSync.stop());
    clearTimeout(deadline);
    log.info("shutdown complete");
    process.exit(shutdownExitCode);
  })();
  return shutdownPromise;
};

const start = async (): Promise<void> => {
  initializeNetwork();
  assertSafeBind(config.host, config.allowPlaintextRemote);
  const lightSource = createChainSyncLightSource(chainSync);
  if (config.lightBroadcasterEnabled) {
    broadcasterRelay = new BroadcasterRelay({
      broadcasters: new BroadcasterNetwork(() => chainSync.getRemoteConfig()),
      provider: (network) => lightSource.provider(network),
    });
  }
  const httpApp = createHttpApp({
    light: {
      enabled: config.lightApiEnabled,
      isNetworkReady: (network) => chainSync.readiness(network).ready,
      source: lightSource,
      corsOrigins: config.lightCorsOrigins,
      relayEnabled: config.lightRelayEnabled,
      relayMaxBytes: config.lightRelayMaxBytes,
      relayRatePerMinute: config.lightRelayRatePerMinute,
      evmRatePerMinute: config.lightEvmRatePerMinute,
      anchorRatePerMinute: config.lightAnchorRatePerMinute,
      readRatePerMinute: config.lightReadRatePerMinute,
      extraAllowedEvmTargets: config.lightEvmExtraTargets,
      ...(broadcasterRelay
        ? {
            broadcaster: broadcasterRelay,
            broadcasterRatePerMinute:
              config.lightBroadcasterRatePerMinute,
            broadcasterTransactRatePerMinute:
              config.lightBroadcasterTransactRatePerMinute,
          }
        : {}),
      ...(remoteScan ? { scan: remoteScan } : {}),
    },
    trustProxyHops: config.lightTrustProxyHops,
  });

  if (config.lightApiEnabled) {
    await chainSync.initialize();
  }
  if (shuttingDown) return;

  httpServer = http.createServer(httpApp.app);
  httpServer.requestTimeout = 10 * 60_000;
  httpServer.headersTimeout = 65_000;
  httpServer.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer!.once("error", onError);
    httpServer!.listen(config.port, config.host, () => {
      httpServer!.off("error", onError);
      resolve();
    });
  });
  httpServer.on("error", (error) => {
    if (shuttingDown) {
      log.warn("HTTP server error during shutdown", error);
      return;
    }
    log.error("HTTP server error", error);
    void shutdown("server error", 1);
  });

  const address = httpServer.address();
  const port =
    address && typeof address === "object" ? address.port : config.port;
  log.info(`HushNode listening on http://${config.host}:${port}`);
  log.info(`data directory: ${config.dataDir}`);
  if (!config.isLoopback) {
    log.warn(
      "non-loopback bind explicitly allowed; use TLS and a trusted reverse proxy",
    );
  }
  if (!config.lightApiEnabled) {
    log.warn("LIGHT_API_ENABLED=false; light routes return 404");
  }

  if (config.lightApiEnabled) {
    chainSync.start();
  }
};

process.on("unhandledRejection", (error) => {
  log.error("unhandled rejection; shutting down", error);
  void shutdown("unhandled rejection", 1);
});
process.on("uncaughtException", (error) => {
  log.error("uncaught exception; shutting down", error);
  void shutdown("uncaught exception", 1);
});
const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
  if (shuttingDown) {
    log.warn(`${signal} received during shutdown; exiting immediately`);
    process.exit(1);
  }
  void shutdown(
    signal,
    0,
    signal === "SIGINT"
      ? INTERACTIVE_DRAIN_TIMEOUT_MS
      : SHUTDOWN_DRAIN_TIMEOUT_MS,
  );
};
process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);

start().catch((error) => {
  if (shuttingDown) {
    log.warn("startup interrupted by shutdown", error);
    return;
  }
  log.error("startup failed", error);
  void shutdown("startup failure", 1);
});
