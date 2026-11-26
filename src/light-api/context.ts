import type { RequestHandler } from "express";
import type { NetworkName } from "@railgun-community/shared-models";
import type { SlidingWindowRateLimiter } from "../rate-limit.js";
import type { BroadcasterRelay } from "../railgun/broadcaster-relay.js";
import type { LightCatalog } from "./catalog.js";
import type { LightApiOptions } from "./protocol.js";

/**
 * Shared dependency surface for route modules. Route modules receive only the
 * capabilities they need, keeping HTTP wiring out of the domain services.
 */
export type LightRouteContext = {
  options: LightApiOptions;
  catalog: LightCatalog;
  allowedTargetsByNetwork: ReadonlyMap<
    NetworkName,
    ReadonlySet<string>
  >;
  maxTrees: number;
  evmJsonBody: RequestHandler;
  relayJsonBody: RequestHandler;
  scanJsonBody: RequestHandler;
  relayEnabled: boolean;
  relayMaxBytes: number;
  relayRate: SlidingWindowRateLimiter;
  broadcaster?: {
    relay: BroadcasterRelay;
    quoteRate: SlidingWindowRateLimiter;
    transactRate: SlidingWindowRateLimiter;
    jsonBody: RequestHandler;
  };
};
