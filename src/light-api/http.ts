import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { ScanApiError } from "../light-scan.js";
import type { SlidingWindowRateLimiter } from "../rate-limit.js";
import { createLogger } from "../logger.js";
import { createRequestAbortScope } from "../request-abort.js";
import {
  LIGHT_PROTOCOL_VERSION,
  LightApiError,
  type LightApiOptions,
} from "./protocol.js";

const log = createLogger("light-api");

export const asyncRoute =
  (
    handler: (
      request: Request,
      response: Response,
      signal: AbortSignal,
    ) => Promise<void>,
  ): RequestHandler =>
  (request: Request, response: Response, next: NextFunction): void => {
    const abort = createRequestAbortScope(request, response);
    void Promise.resolve()
      .then(() => handler(request, response, abort.signal))
      .catch((error: unknown) => {
        if (!abort.signal.aborted && !response.destroyed) next(error);
      });
  };

export const clientBucketKey = (request: Request): string =>
  request.ip || request.socket.remoteAddress || "unknown";

export const consumeRate = (
  request: Request,
  limiter: SlidingWindowRateLimiter,
  message: string,
): void => {
  if (!limiter.allow(clientBucketKey(request))) {
    throw new LightApiError(429, "RATE_LIMITED", message);
  }
};

export const rateLimit = (
  limiter: SlidingWindowRateLimiter,
  message: string,
): RequestHandler => (request, _response, next) => {
  try {
    consumeRate(request, limiter, message);
    next();
  } catch (error) {
    next(error);
  }
};

export const createProtocolMiddleware = (
  options: LightApiOptions,
  allowedOrigins: ReadonlySet<string>,
): RequestHandler => (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Hush-Light-Protocol", String(LIGHT_PROTOCOL_VERSION));
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, DELETE, OPTIONS",
    );
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    response.setHeader("Access-Control-Max-Age", "600");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (!options.enabled) {
    response.status(404).json({
      error: "The light index API is disabled.",
      code: "LIGHT_API_DISABLED",
    });
    return;
  }
  next();
};

export const lightNotFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({
    error: "Light index route not found.",
    code: "NOT_FOUND",
  });
};

const isHttpClientError = (
  error: unknown,
): error is { status: number; type?: string } =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  "type" in error &&
  typeof error.status === "number" &&
  Number.isInteger(error.status) &&
  error.status >= 400 &&
  error.status < 500 &&
  typeof error.type === "string";

export const lightErrorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof LightApiError) {
    response.status(error.status).json({
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof ScanApiError) {
    response.status(error.status).json({
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (isHttpClientError(error)) {
    response.status(error.status).json({
      error:
        error.type === "entity.too.large"
          ? "Request body is too large."
          : error.status === 415
            ? "Request content type or encoding is not supported."
            : "Request body must be valid JSON.",
      code: "INVALID_REQUEST",
    });
    return;
  }
  log.error("unexpected light API error", error);
  response.status(500).json({
    error: "Unexpected light index error.",
    code: "LIGHT_INDEX_ERROR",
  });
};
