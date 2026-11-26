import type { Router } from "express";
import type { NetworkName } from "@railgun-community/shared-models";
import { raceWithAbort, throwIfAborted } from "../../abort.js";
import { createLogger } from "../../logger.js";
import type { LightRouteContext } from "../context.js";
import { asyncRoute } from "../http.js";
import { requireSource } from "../index-source.js";
import {
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
  LightApiError,
  blockNumberString,
  nonceString,
  optionalUintString,
  parseEvmAddress,
  parseEvmBody,
  parseEvmCallResult,
  parseEvmData,
  parseEvmHash,
  parseEvmValue,
  parseLimitParam,
  parseNetwork,
  publicNetwork,
  requireAllowedEvmTarget,
  uintString,
  type LightTransactionReceipt,
} from "../protocol.js";

const log = createLogger("light-api");

const evmRpcUnavailable = (network: NetworkName): LightApiError => {
  log.warn(`${network} EVM RPC read failed`);
  return new LightApiError(
    503,
    "EVM_RPC_UNAVAILABLE",
    "The EVM RPC read is temporarily unavailable.",
  );
};

const readEvm = async <T>(
  network: NetworkName,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  try {
    return await raceWithAbort(operation(), signal);
  } catch {
    throwIfAborted(signal);
    throw evmRpcUnavailable(network);
  }
};

export const registerEvmRoutes = (
  router: Router,
  context: LightRouteContext,
): void => {
  const { options, allowedTargetsByNetwork } = context;

  router.get(
    "/evm/account",
    asyncRoute(async (request, response, signal) => {
      const network = parseNetwork(request.query.network);
      const address = parseEvmAddress(request.query.address, "address");
      const source = requireSource(options, network);
      const account = await readEvm(network, async () => {
        const provider = source.provider(network);
        const [nonce, balance, block] = await Promise.all([
          provider.getTransactionCount(address, "pending"),
          provider.getBalance(address, "latest"),
          provider.getBlockNumber(),
        ]);
        blockNumberString(block);
        return {
          nonce: nonceString(nonce),
          balance: uintString(balance),
          block,
        };
      }, signal);
      response.json({
        network: publicNetwork(network),
        address,
        ...account,
      });
    }),
  );

  router.get(
    "/evm/gas",
    asyncRoute(async (request, response, signal) => {
      const network = parseNetwork(request.query.network);
      const source = requireSource(options, network);
      const gas = await readEvm(network, async () => {
        const provider = source.provider(network);
        const [feeData, block] = await Promise.all([
          provider.feeData(),
          provider.getBlockNumber(),
        ]);
        return {
          block: blockNumberString(block),
          baseFeePerGas: optionalUintString(feeData.baseFeePerGas),
          maxPriorityFeePerGas:
            optionalUintString(feeData.maxPriorityFeePerGas),
          maxFeePerGas: optionalUintString(feeData.maxFeePerGas),
        };
      }, signal);
      response.json({
        network: publicNetwork(network),
        ...gas,
      });
    }),
  );

  router.post(
    "/evm/call",
    context.evmJsonBody,
    asyncRoute(async (request, response, signal) => {
      const record = parseEvmBody(request.body);
      const network = parseNetwork(record.network);
      const to = parseEvmAddress(record.to, "to");
      const data = parseEvmData(record.data);
      requireAllowedEvmTarget(allowedTargetsByNetwork, network, to);
      const source = requireSource(options, network);
      const result = await readEvm(network, async () => {
        return parseEvmCallResult(
          await source.provider(network).call({ to, data }),
        );
      }, signal);
      response.json({ result });
    }),
  );

  router.post(
    "/evm/estimate-gas",
    context.evmJsonBody,
    asyncRoute(async (request, response, signal) => {
      const record = parseEvmBody(request.body);
      const network = parseNetwork(record.network);
      const from = parseEvmAddress(record.from, "from");
      const to = parseEvmAddress(record.to, "to");
      const data = parseEvmData(record.data);
      const value = parseEvmValue(record.value);
      const nativeTransfer = data === "0x" && value > 0n;
      if (!nativeTransfer) {
        requireAllowedEvmTarget(allowedTargetsByNetwork, network, to);
      }
      const source = requireSource(options, network);
      const gas = await readEvm(
        network,
        async () => {
          const estimate = await source.provider(network).estimateGas({
            from,
            to,
            data,
            value,
          });
          return uintString(estimate);
        },
        signal,
      );
      response.json({ gas });
    }),
  );

  router.get(
    "/evm/receipt",
    asyncRoute(async (request, response, signal) => {
      const network = parseNetwork(request.query.network);
      const hash = parseEvmHash(request.query.hash);
      const source = requireSource(options, network);
      const receipt: LightTransactionReceipt | null = await readEvm(
        network,
        async () => source.provider(network).getTransactionReceipt(hash),
        signal,
      );
      if (!receipt) {
        response.json({ found: false, status: "pending" });
        return;
      }
      const result = await readEvm(network, async () => {
        if (
          receipt.status !== null &&
          receipt.status !== 0 &&
          receipt.status !== 1
        ) {
          throw new Error("RPC returned an invalid receipt status.");
        }
        return {
          found: true as const,
          status:
            receipt.status === null
              ? "pending" as const
              : receipt.status === 1
                ? "success" as const
                : "reverted" as const,
          blockNumber: blockNumberString(receipt.blockNumber),
          gasUsed: uintString(receipt.gasUsed),
          effectiveGasPrice: uintString(receipt.effectiveGasPrice),
        };
      }, signal);
      response.json(result);
    }),
  );

  router.get(
    "/evm/activity",
    asyncRoute(async (request, response, signal) => {
      const network = parseNetwork(request.query.network);
      const address = parseEvmAddress(request.query.address, "address");
      const limit = parseLimitParam(
        request.query.limit,
        DEFAULT_ACTIVITY_LIMIT,
        MAX_ACTIVITY_LIMIT,
      );
      const activity = await context.catalog.activity(
        network,
        address,
        signal,
      );
      response.json({
        network: publicNetwork(network),
        address,
        items: activity.items.slice(0, limit),
        complete: activity.complete,
        warnings: activity.warnings,
      });
    }),
  );
};
