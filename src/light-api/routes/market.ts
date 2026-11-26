import type { Router } from "express";
import { FIAT_CURRENCIES, isFiatCurrency } from "../../prices.js";
import { asyncRoute } from "../http.js";
import {
  normalizeTreeLength,
  normalizeTreeRoot,
  readLightIndex,
  requireReadySource,
  requireSource,
  requireTreeFromSource,
} from "../index-source.js";
import {
  LightApiError,
  ZERO_ROOT,
  parseNetwork,
  parseRootParam,
  parseTxidVersion,
  parseIntParam,
  publicNetwork,
  type LightApiOptions,
} from "../protocol.js";
import type { LightCatalog } from "../catalog.js";

export const registerMarketRoutes = (
  router: Router,
  options: LightApiOptions,
  catalog: LightCatalog,
): void => {
  router.get(
    "/fees",
    asyncRoute(async (request, response, signal) => {
      const network = parseNetwork(request.query.network);
      const source = requireSource(options, network);
      const quote = await catalog.fees(source, network, signal);
      response.json({ ...quote, network: publicNetwork(network) });
    }),
  );

  router.get(
    "/prices",
    asyncRoute(async (request, response, signal) => {
      const network = parseNetwork(request.query.network);
      const currency = request.query.currency;
      if (!isFiatCurrency(currency)) {
        throw new LightApiError(
          400,
          "INVALID_REQUEST",
          `currency must be one of ${FIAT_CURRENCIES.join(", ")}.`,
        );
      }
      requireSource(options, network);
      const snapshot = await catalog.prices(network, currency, signal);
      response.json({
        ok: true,
        network: publicNetwork(network),
        currency,
        prices: snapshot.prices,
        updatedAt: snapshot.updatedAt,
      });
    }),
  );

  router.get(
    "/anchor",
    asyncRoute(async (request, response, signal) => {
      const network = parseNetwork(request.query.network);
      const txidVersion = parseTxidVersion(request.query.txidVersion);
      const treeNumber = parseIntParam(request.query.tree, "tree");
      const requestedRoot = parseRootParam(request.query.root);
      const source = requireReadySource(options, network);
      const tree = await requireTreeFromSource(
        source,
        network,
        txidVersion,
        treeNumber,
      );
      const leaves = normalizeTreeLength(
        await readLightIndex(() => tree.getTreeLength(treeNumber)),
      );
      const localRoot = leaves > 0
        ? normalizeTreeRoot(
            await readLightIndex(() => tree.getRoot(treeNumber)),
          )
        : ZERO_ROOT;
      const anchor = await catalog.anchor(
        source,
        network,
        txidVersion,
        treeNumber,
        leaves,
        localRoot,
        requestedRoot ?? localRoot,
        signal,
      );
      response.json({ ...anchor, network: publicNetwork(network) });
    }),
  );
};
