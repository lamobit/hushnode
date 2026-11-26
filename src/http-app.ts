import { createRequire } from "node:module";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createLogger } from "./logger.js";
import {
  degradedReadiness,
  notStartedReadiness,
  type IndexReadiness,
} from "./index-readiness.js";
import {
  LIGHT_PROTOCOL_VERSION,
  createLightApiRouter,
  type LightApiOptions,
} from "./light-api.js";
import { NETWORKS } from "./networks.js";

const log = createLogger("server");
const require = createRequire(import.meta.url);
const packageInfo = require("../package.json") as {
  version?: string;
  description?: string;
};
const SERVICE_VERSION = packageInfo.version ?? "0.0.0";
const SERVICE_DESCRIPTION =
  packageInfo.description ?? "Public read-only RAILGUN light index API";

export type HttpAppDependencies = {
  light: LightApiOptions;
  trustProxyHops?: number;
};

export type HttpApp = {
  app: Express;
};

const securityHeaders = (
  _request: Request,
  response: Response,
  next: NextFunction,
) => {
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cache-Control", "no-store");
  next();
};

export const createHttpApp = ({
  light,
  trustProxyHops = 0,
}: HttpAppDependencies): HttpApp => {
  const app = express();
  app.disable("x-powered-by");
  const proxyHops = Math.max(0, Math.min(16, Math.trunc(trustProxyHops)));
  if (proxyHops > 0) {
    app.set("trust proxy", proxyHops);
  }
  app.use(securityHeaders);

  const readinessSnapshot = (): {
    ready: boolean;
    networks: Record<string, IndexReadiness>;
  } => {
    if (!light.enabled) return { ready: true, networks: {} };
    const source = light.source;
    const running = (() => {
      try {
        return Boolean(source?.isRunning());
      } catch {
        return false;
      }
    })();
    const networks: Record<string, IndexReadiness> = {};
    for (const network of NETWORKS) {
      let readiness: IndexReadiness;
      try {
        readiness = source?.readiness(network.id) ?? notStartedReadiness();
      } catch {
        readiness = degradedReadiness();
      }
      networks[network.id] = readiness;
    }
    return {
      ready:
        running &&
        Object.values(networks).every((readiness) => readiness.ready),
      networks,
    };
  };

  app.get("/", (_request, response) => {
    response.json({
      ok: true,
      service: "hush-node",
      version: SERVICE_VERSION,
      description: SERVICE_DESCRIPTION,
      health: "/health",
      readyz: "/readyz",
      lightApi: {
        enabled: light.enabled,
        protocol: LIGHT_PROTOCOL_VERSION,
        prefix: light.enabled ? "/api/light/v1" : null,
        status: light.enabled
          ? "/api/light/v1/status?network=ethereum&txidVersion=V2_PoseidonMerkle"
          : null,
      },
      networks: ["ethereum", "arbitrum"],
      time: Date.now(),
    });
  });

  app.get("/health", (_request, response) => {
    const readiness = readinessSnapshot();
    response.json({
      ok: true,
      service: "hush-node",
      ready: readiness.ready,
      lightApi: {
        enabled: light.enabled,
        ready: readiness.ready,
      },
      time: Date.now(),
    });
  });

  app.get("/readyz", (_request, response) => {
    const readiness = readinessSnapshot();
    response.status(readiness.ready ? 200 : 503).json({
      ok: readiness.ready,
      ready: readiness.ready,
      lightApiEnabled: light.enabled,
      networks: readiness.networks,
      time: Date.now(),
    });
  });

  app.use("/api/light/v1", createLightApiRouter(light));

  app.use((_request, response) => {
    response.status(404).json({
      error: "Route not found.",
      code: "NOT_FOUND",
    });
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      log.error("unhandled request error", error);
      response.status(500).json({
        error: "Unexpected server error.",
        code: "INTERNAL_ERROR",
      });
    },
  );

  return { app };
};
