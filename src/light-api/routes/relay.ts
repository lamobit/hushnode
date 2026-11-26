import type { RequestHandler, Router } from "express";
import { throwIfAborted } from "../../abort.js";
import { createLogger } from "../../logger.js";
import { classifyRelayError } from "../../relay-error.js";
import type { LightRouteContext } from "../context.js";
import { asyncRoute, rateLimit } from "../http.js";
import { requireSource } from "../index-source.js";
import {
  LightApiError,
  RELAY_HASH_PATTERN,
  parseEvmBody,
  parseNetwork,
  parseRelayTransaction,
  publicNetwork,
} from "../protocol.js";

const log = createLogger("light-api");

const requireRelayEnabled = (enabled: boolean): RequestHandler => (
  _request,
  _response,
  next,
) => {
  if (!enabled) {
    next(
      new LightApiError(
        403,
        "RELAY_DISABLED",
        "Transaction relay is disabled on this indexer.",
      ),
    );
    return;
  }
  next();
};

export const registerRelayRoute = (
  router: Router,
  context: LightRouteContext,
): void => {
  router.post(
    "/relay",
    requireRelayEnabled(context.relayEnabled),
    rateLimit(
      context.relayRate,
      "Too many relay requests; try again later.",
    ),
    context.relayJsonBody,
    asyncRoute(async (request, response, signal) => {
      const record = parseEvmBody(request.body);
      const network = parseNetwork(record.network);
      const source = requireSource(context.options, network);
      const rawTransaction = parseRelayTransaction(
        record.rawTransaction,
        context.relayMaxBytes,
      );
      throwIfAborted(signal);
      try {
        const hash = await source
          .provider(network)
          .sendRawTransaction(rawTransaction);
        if (typeof hash !== "string" || !RELAY_HASH_PATTERN.test(hash)) {
          throw new Error("Relay returned an invalid transaction hash.");
        }
        response.json({
          network: publicNetwork(network),
          hash,
          receivedAt: Date.now(),
        });
      } catch (error) {
        log.warn(`${network} transaction relay failed`);
        const failure = classifyRelayError(error);
        throw new LightApiError(failure.status, failure.code, failure.message);
      }
    }),
  );
};
