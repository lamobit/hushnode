# Documentation map

HushNode is a standalone public Light API node. Read only the document that
matches your task to avoid loading unrelated material.

## Read by task

| Task | Document |
| --- | --- |
| Local startup, build, and tests | [README](../README.md), [operations](operations.md) |
| Call or change the Light HTTP API | [light-api](light-api.md) |
| Configuration, deployment, data directories, troubleshooting | [operations](operations.md) |
| Trust boundaries, privacy, network exposure | [security](security.md) |

## Single sources of truth

| Fact | Source |
| --- | --- |
| Routes, parameter validation, CORS, rate limits | `src/light-api.ts`, `src/light-api/**/*.ts` |
| Remote note scanning, job lifecycle, key parsing | `src/light-scan.ts`, `src/railgun/scan-result.ts`, `src/railgun/scan-wallets.ts`, `src/railgun/scan-store.ts`, `src/railgun/scan-cache.ts` |
| Engine startup, RPC health checks, network loading | `src/railgun/engine.ts`, `src/networks.ts` |
| Chain scanning, retries, readiness | `src/chain-sync-service.ts` |
| Config defaults, bind address, data directory | `src/config.ts`, `src/network.ts`, `src/logger.ts` |
| Bounded upstream JSON reads | `src/json-response.ts` |
| Request cancellation, shared operations, disconnect cleanup | `src/abort.ts`, `src/request-abort.ts`, `src/single-flight.ts` |

## Maintenance rules

- Routes, parameters, or error codes changed: update [light-api](light-api.md).
- Configuration, data directories, or deployment changed: update
  [operations](operations.md).
- Keys, privacy, or network boundaries changed: update [security](security.md).
- Run `pnpm check` before committing; every env var referenced in docs must
  exist in the source.
