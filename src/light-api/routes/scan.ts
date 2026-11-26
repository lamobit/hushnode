import type { RequestHandler, Router } from "express";
import type { NetworkName } from "@railgun-community/shared-models";
import { throwIfAborted } from "../../abort.js";
import type { RemoteScanService } from "../../light-scan.js";
import { createLogger } from "../../logger.js";
import { railgunDeploymentBlock } from "../../networks.js";
import { asyncRoute, clientBucketKey } from "../http.js";
import {
  LightApiError,
  parseEvmBody,
  parseNetwork,
  parseTxidVersion,
} from "../protocol.js";

const log = createLogger("light-api");

const requireScan = (
  scan: RemoteScanService | undefined,
): RemoteScanService => {
  if (!scan) {
    throw new LightApiError(
      403,
      "SCAN_DISABLED",
      "Remote note scan is disabled on this indexer.",
    );
  }
  return scan;
};

const authorizeScan = (
  scan: RemoteScanService | undefined,
  enforceStartRate = false,
): RequestHandler => (request, _response, next) => {
  try {
    const service = requireScan(scan);
    service.authorize(request.headers.authorization);
    if (enforceStartRate) {
      service.enforceStartRate(clientBucketKey(request));
    }
    next();
  } catch (error) {
    next(error);
  }
};

const parseFromBlock = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new LightApiError(
      400,
      "INVALID_REQUEST",
      "fromBlock must be a non-negative integer.",
    );
  }
  return raw;
};

export const registerScanRoutes = (
  router: Router,
  scan: RemoteScanService | undefined,
  bodyParser: RequestHandler,
  isNetworkReady?: (network: NetworkName) => boolean,
): void => {
  router.post(
    "/scan",
    authorizeScan(scan, true),
    bodyParser,
    asyncRoute(async (request, response, signal) => {
      throwIfAborted(signal);
      const service = requireScan(scan);
      const record = parseEvmBody(request.body);
      const network = parseNetwork(record.network);
      const txidVersion = parseTxidVersion(record.txidVersion);
      if (typeof record.shareableViewingKey !== "string") {
        throw new LightApiError(
          400,
          "INVALID_REQUEST",
          "shareableViewingKey must be a hex string.",
        );
      }
      const fromBlock = parseFromBlock(record.fromBlock);
      if (
        record.includeSpent !== undefined &&
        typeof record.includeSpent !== "boolean"
      ) {
        throw new LightApiError(
          400,
          "INVALID_REQUEST",
          "includeSpent must be a boolean.",
        );
      }
      throwIfAborted(signal);
      if (isNetworkReady && !isNetworkReady(network)) {
        throw new LightApiError(
          503,
          "LIGHT_INDEX_SYNCING",
          "The indexer is still syncing this network; retry after it is ready.",
        );
      }
      const jobId = service.start({
        network,
        txidVersion,
        shareableViewingKey: record.shareableViewingKey,
        fromBlock,
        includeSpent: record.includeSpent !== false,
      });
      signal.addEventListener(
        "abort",
        () => service.cancelIfPresent(jobId),
        { once: true },
      );
      log.info(
        `remote scan queued for ${network} from block ${fromBlock ?? railgunDeploymentBlock(network)} (job ${jobId.slice(0, 8)})`,
      );
      response.status(202).json({ jobId });
    }),
  );

  router.get(
    "/scan/:jobId",
    authorizeScan(scan),
    asyncRoute(async (request, response) => {
      const service = requireScan(scan);
      response.json(service.status(request.params.jobId ?? ""));
    }),
  );

  router.delete(
    "/scan/:jobId",
    authorizeScan(scan),
    asyncRoute(async (request, response) => {
      const service = requireScan(scan);
      response.json(service.cancel(request.params.jobId ?? ""));
    }),
  );
};
