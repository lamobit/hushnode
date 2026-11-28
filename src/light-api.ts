import express, { type Router } from "express";
import { LightCatalog } from "./light-api/catalog.js";
import type { LightRouteContext } from "./light-api/context.js";
import {
  createProtocolMiddleware,
  lightErrorHandler,
  lightNotFoundHandler,
  rateLimit,
} from "./light-api/http.js";
import { createChainSyncLightSource } from "./light-api/index-source.js";
import {
  DEFAULT_MAX_TREES,
  LIGHT_PROTOCOL_VERSION,
  allowedEvmTargets,
  type LightApiOptions,
} from "./light-api/protocol.js";
import { registerEvmRoutes } from "./light-api/routes/evm.js";
import { registerBroadcasterRoutes } from "./light-api/routes/broadcaster.js";
import { registerMarketRoutes } from "./light-api/routes/market.js";
import { registerRelayRoute } from "./light-api/routes/relay.js";
import { registerScanRoutes } from "./light-api/routes/scan.js";
import { registerStatusRoute } from "./light-api/routes/status.js";
import { registerTreeRoutes } from "./light-api/routes/trees.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";

export { LIGHT_PROTOCOL_VERSION, createChainSyncLightSource };
export type {
  BaseLightTreeSource,
  ChainSyncIndexingSource,
  ChainSyncRpcProvider,
  LightApiOptions,
  LightAnchorCheck,
  LightBlockTag,
  LightCommitment,
  LightFeeData,
  LightFeeQuote,
  LightIndexSource,
  LightMerkleProof,
  LightRpcProvider,
  LightTransactionReceipt,
  LightTreeSource,
  RealUtxoTreeSource,
} from "./light-api/protocol.js";

const RELAY_WINDOW_MS = 60_000;
const DEFAULT_RELAY_MAX_BYTES = 131_072;
const MIN_RELAY_MAX_BYTES = 1_024;
const MAX_RELAY_MAX_BYTES = 1_048_576;
const DEFAULT_RELAY_RATE_PER_MINUTE = 12;
const MAX_RELAY_RATE_PER_MINUTE = 600;
const EVM_RATE_WINDOW_MS = 60_000;
const DEFAULT_EVM_RATE_PER_MINUTE = 120;
const MAX_EVM_RATE_PER_MINUTE = 1_200;
const DEFAULT_ANCHOR_RATE_PER_MINUTE = 60;
const MIN_ANCHOR_RATE_PER_MINUTE = 10;
const MAX_ANCHOR_RATE_PER_MINUTE = 1_200;
const ANCHOR_RATE_WINDOW_MS = 60_000;
const DEFAULT_READ_RATE_PER_MINUTE = 300;
const MIN_READ_RATE_PER_MINUTE = 10;
const MAX_READ_RATE_PER_MINUTE = 6_000;
const READ_RATE_WINDOW_MS = 60_000;
const BROADCASTER_RATE_WINDOW_MS = 60_000;
const DEFAULT_BROADCASTER_QUOTE_RATE_PER_MINUTE = 30;
const DEFAULT_BROADCASTER_TRANSACT_RATE_PER_MINUTE = 10;
const BROADCASTER_STATUS_RATE_PER_MINUTE = 180;
const MAX_BROADCASTER_RATE_PER_MINUTE = 600;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.trunc(
    Math.max(
      minimum,
      Math.min(maximum, Number.isFinite(value) ? value : minimum),
    ),
  );

/**
 * Composition root for the HTTP transport. Domain-specific route modules stay
 * independent; this function only wires dependencies, limits and middleware.
 */
export const createLightApiRouter = (options: LightApiOptions): Router => {
  const router = express.Router();
  const catalog = new LightCatalog({
    priceSource: options.priceSource,
    publicActivityFetcher: options.publicActivityFetcher,
  });
  const allowedOrigins = new Set(
    (options.corsOrigins ?? []).map((origin) => origin.trim()).filter(Boolean),
  );
  const maxTrees = clamp(options.maxTrees ?? DEFAULT_MAX_TREES, 1, DEFAULT_MAX_TREES);
  const relayEnabled = options.relayEnabled === true;
  const relayMaxBytes = clamp(
    options.relayMaxBytes ?? DEFAULT_RELAY_MAX_BYTES,
    MIN_RELAY_MAX_BYTES,
    MAX_RELAY_MAX_BYTES,
  );
  const relayRate = new SlidingWindowRateLimiter(
    clamp(
      options.relayRatePerMinute ?? DEFAULT_RELAY_RATE_PER_MINUTE,
      1,
      MAX_RELAY_RATE_PER_MINUTE,
    ),
    RELAY_WINDOW_MS,
    4_096,
  );
  const evmRate = new SlidingWindowRateLimiter(
    clamp(
      options.evmRatePerMinute ?? DEFAULT_EVM_RATE_PER_MINUTE,
      1,
      MAX_EVM_RATE_PER_MINUTE,
    ),
    EVM_RATE_WINDOW_MS,
    4_096,
  );
  const anchorRate = new SlidingWindowRateLimiter(
    clamp(
      options.anchorRatePerMinute ?? DEFAULT_ANCHOR_RATE_PER_MINUTE,
      MIN_ANCHOR_RATE_PER_MINUTE,
      MAX_ANCHOR_RATE_PER_MINUTE,
    ),
    ANCHOR_RATE_WINDOW_MS,
    4_096,
  );
  const readRate = new SlidingWindowRateLimiter(
    clamp(
      options.readRatePerMinute ?? DEFAULT_READ_RATE_PER_MINUTE,
      MIN_READ_RATE_PER_MINUTE,
      MAX_READ_RATE_PER_MINUTE,
    ),
    READ_RATE_WINDOW_MS,
    4_096,
  );
  const relayBodyLimit = relayEnabled
    ? Math.min(2 * relayMaxBytes + 8_192, 2_200_000)
    : 64 * 1_024;
  const broadcaster = options.broadcaster
    ? {
        relay: options.broadcaster,
        quoteRate: new SlidingWindowRateLimiter(
          clamp(
            options.broadcasterRatePerMinute ??
              DEFAULT_BROADCASTER_QUOTE_RATE_PER_MINUTE,
            1,
            MAX_BROADCASTER_RATE_PER_MINUTE,
          ),
          BROADCASTER_RATE_WINDOW_MS,
          4_096,
        ),
        transactRate: new SlidingWindowRateLimiter(
          clamp(
            options.broadcasterTransactRatePerMinute ??
              DEFAULT_BROADCASTER_TRANSACT_RATE_PER_MINUTE,
            1,
            MAX_BROADCASTER_RATE_PER_MINUTE,
          ),
          BROADCASTER_RATE_WINDOW_MS,
          4_096,
        ),
        transactStatusRate: new SlidingWindowRateLimiter(
          BROADCASTER_STATUS_RATE_PER_MINUTE,
          BROADCASTER_RATE_WINDOW_MS,
          4_096,
        ),
        jsonBody: express.json({ limit: 1_500_000, strict: true }),
      }
    : undefined;
  const context: LightRouteContext = {
    options,
    catalog,
    allowedTargetsByNetwork: allowedEvmTargets(
      options.extraAllowedEvmTargets,
    ),
    maxTrees,
    evmJsonBody: express.json({ limit: 64 * 1_024, strict: true }),
    relayJsonBody: express.json({ limit: relayBodyLimit, strict: true }),
    scanJsonBody: express.json({ limit: 8 * 1_024, strict: true }),
    relayEnabled,
    relayMaxBytes,
    relayRate,
    ...(broadcaster ? { broadcaster } : {}),
  };

  router.use(createProtocolMiddleware(options, allowedOrigins));
  router.use(
    "/evm",
    rateLimit(
      evmRate,
      "Too many EVM read requests; try again later.",
    ),
  );
  router.use(
    "/anchor",
    rateLimit(anchorRate, "Too many anchor checks; try again later."),
  );
  const readLimit = rateLimit(
    readRate,
    "Too many light index requests; try again later.",
  );
  for (const path of ["/status", "/trees", "/fees", "/prices"]) {
    router.use(path, readLimit);
  }

  registerStatusRoute(router, options);
  registerTreeRoutes(router, options, maxTrees);
  registerMarketRoutes(router, options, catalog);
  registerEvmRoutes(router, context);
  registerRelayRoute(router, context);
  registerBroadcasterRoutes(router, context);
  registerScanRoutes(
    router,
    options.scan,
    context.scanJsonBody,
    options.isNetworkReady,
  );

  router.use(lightNotFoundHandler);
  router.use(lightErrorHandler);
  return router;
};
