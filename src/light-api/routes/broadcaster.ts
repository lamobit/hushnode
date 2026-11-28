import type { RequestHandler, Router } from "express";
import type { LightRouteContext } from "../context.js";
import { asyncRoute, rateLimit } from "../http.js";
import {
  LightApiError,
  parseNetwork,
  parseTxidVersion,
} from "../protocol.js";
import {
  BroadcasterRelayError,
  parseAmount,
  parseCalldata,
  parseNullifiers,
  parsePreTransactionPOIs,
  parseQuoteId,
  parseQuoteTerms,
  parseTokenHash,
  type BroadcasterQuote,
  type BroadcasterTransactInput,
  type BroadcasterTransactStatus,
} from "../../railgun/broadcaster-relay.js";

const asLightError = async <T>(
  operation: () => T | Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BroadcasterRelayError) {
      throw new LightApiError(error.status, error.code, error.message);
    }
    throw error;
  }
};

const serializeQuote = (
  quote: BroadcasterQuote,
): Record<string, unknown> => ({
  id: quote.id,
  network: quote.network.toLowerCase(),
  tokenHash: quote.tokenHash,
  feeRecipient: quote.feeRecipient,
  fee: quote.fee.toString(),
  minGasPrice: quote.minGasPrice.toString(),
  expiresAt: quote.expiresAt,
});

const serializeTransactStatus = (
  status: BroadcasterTransactStatus,
): Record<string, unknown> => status;

const asRecord = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "Request body must be a JSON object.",
    );
  }
  return body as Record<string, unknown>;
};

const parseTransactInput = (
  body: Record<string, unknown>,
): BroadcasterTransactInput => {
  const quote = asRecord(body.quote);
  const terms = parseQuoteTerms(quote);
  return {
    network: parseNetwork(body.network),
    txidVersion: parseTxidVersion(body.txidVersion),
    calldata: parseCalldata(body.calldata),
    quoteId: parseQuoteId(quote.id),
    ...(terms ? { quote: terms } : {}),
    nullifiers: parseNullifiers(body.nullifiers),
    ...(body.overallBatchMinGasPrice !== undefined
      ? {
          overallBatchMinGasPrice: parseAmount(
            body.overallBatchMinGasPrice,
          ),
        }
      : {}),
    ...(body.preTransactionPOIs !== undefined
      ? {
          preTransactionPOIsPerTxidLeafPerList: parsePreTransactionPOIs(
            body.preTransactionPOIs,
          ),
        }
      : {}),
  };
};

export const registerBroadcasterRoutes = (
  router: Router,
  context: LightRouteContext,
): void => {
  const broadcaster = context.broadcaster;
  if (!broadcaster) {
    const disabled: RequestHandler = (_request, _response, next) => {
      next(
        new LightApiError(
          403,
          "BROADCASTER_DISABLED",
          "Broadcaster relay is disabled on this indexer.",
        ),
      );
    };
    router.post("/broadcaster/quote", disabled);
    router.post("/broadcaster/transact", disabled);
    router.get("/broadcaster/transact/:id", disabled);
    return;
  }

  router.post(
    "/broadcaster/quote",
    rateLimit(
      broadcaster.quoteRate,
      "Too many broadcaster quote requests; try again later.",
    ),
    broadcaster.jsonBody,
    asyncRoute(async (request, response) => {
      const body = asRecord(request.body);
      const quote = await asLightError(() =>
        broadcaster.relay.quote({
          network: parseNetwork(body.network),
          txidVersion: parseTxidVersion(body.txidVersion),
          tokenHash: parseTokenHash(body.tokenHash),
          amount: parseAmount(body.amount),
          unshield: body.unshield === true,
        }),
      );
      response.json(serializeQuote(quote));
    }),
  );

  router.post(
    "/broadcaster/transact",
    rateLimit(
      broadcaster.transactRate,
      "Too many broadcaster submissions; try again later.",
    ),
    broadcaster.jsonBody,
    asyncRoute(async (request, response) => {
      const body = asRecord(request.body);
      const input = await asLightError(() => parseTransactInput(body));
      if (body.async === true) {
        const status = await asLightError(() =>
          broadcaster.relay.startTransact(input),
        );
        response
          .status(status.status === "pending" ? 202 : 200)
          .json(serializeTransactStatus(status));
        return;
      }
      const result = await asLightError(() =>
        broadcaster.relay.transact(input),
      );
      response.json({ hash: result.hash });
    }),
  );

  router.get(
    "/broadcaster/transact/:id",
    rateLimit(
      broadcaster.transactStatusRate,
      "Too many broadcaster status requests; try again later.",
    ),
    asyncRoute(async (request, response) => {
      const status = await asLightError(() =>
        broadcaster.relay.transactStatus(parseQuoteId(request.params.id)),
      );
      response.json(serializeTransactStatus(status));
    }),
  );
};
