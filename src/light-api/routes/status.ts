import type { Router } from "express";
import { throwIfAborted } from "../../abort.js";
import { degradedReadiness, type IndexReadiness } from "../../index-readiness.js";
import { networkFor } from "../../networks.js";
import { FIAT_CURRENCIES } from "../../prices.js";
import { asyncRoute } from "../http.js";
import { latestTreeInfo, requireConfiguredSource } from "../index-source.js";
import {
  LIGHT_PROTOCOL_VERSION,
  parseNetwork,
  parseTxidVersion,
  publicNetwork,
  type LightApiOptions,
  type LightIndexSource,
} from "../protocol.js";

const safeReadiness = (
  source: LightIndexSource,
  network: ReturnType<typeof parseNetwork>,
): IndexReadiness => {
  try {
    return source.readiness(network);
  } catch {
    return degradedReadiness();
  }
};

const safeBoolean = (read: () => boolean, fallback = false): boolean => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

export const registerStatusRoute = (
  router: Router,
  options: LightApiOptions,
): void => {
  router.get(
    "/status",
    asyncRoute(async (request, response, signal) => {
      throwIfAborted(signal);
      const network = parseNetwork(request.query.network);
      const txidVersion = parseTxidVersion(request.query.txidVersion);
      const source = requireConfiguredSource(options);
      const readiness = safeReadiness(source, network);
      const networkLoaded = safeBoolean(() => source.isNetworkLoaded(network));
      const running = safeBoolean(() => source.isRunning());
      let info: { latest: number; leaves: number; root: string } | null = null;
      let block: number | null = null;
      if (networkLoaded) {
        try {
          info = await latestTreeInfo(source.tree(network, txidVersion));
        } catch {
          info = null;
        }
        try {
          block =
            (await source.lastSyncedBlock(network, txidVersion)) ?? null;
        } catch {
          block = null;
        }
        throwIfAborted(signal);
      }
      const activity = networkLoaded
        ? (() => {
            try {
              return source.scanActivity(network);
            } catch {
              return { utxo: false, txid: false };
            }
          })()
        : { utxo: false, txid: false };
      const ready = readiness.ready && networkLoaded && running;
      const state =
        !ready && readiness.state === "ready"
          ? "degraded"
          : readiness.state;
      throwIfAborted(signal);
      response.json({
        ok: true,
        service: "hush-light-indexer",
        protocol: LIGHT_PROTOCOL_VERSION,
        network: publicNetwork(network),
        chainId: networkFor(network).chainId,
        txidVersion,
        block,
        ready,
        state,
        retryAttempt: readiness.retryAttempt,
        lastCompletedAt: readiness.lastCompletedAt,
        engine: {
          running,
          networkLoaded,
          scanning: activity.utxo || activity.txid,
        },
        tree: info,
        currencies: [...FIAT_CURRENCIES],
        updatedAt: Date.now(),
      });
    }),
  );
};
