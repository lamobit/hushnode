# Operations

## Running

Requires Node.js 24+ (see `engines` in `package.json`) and pnpm.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

Production mode:

```bash
pnpm build
pnpm start
```

Checks:

```bash
pnpm check
pnpm build
```

`pnpm check` runs source type checking, test type checking, the full test
suite, and the documentation consistency check, in that order.

## Configuration

Configuration comes from environment variables or `.env` in the project root.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `8788` | HTTP port; avoids clashing with a local Hush on `8787` |
| `ALLOW_PLAINTEXT_REMOTE` | `false` | Non-loopback binds require `true`; use only behind a trusted TLS reverse proxy |
| `HUSH_NODE_DATA_DIR` | `./data` | RAILGUN LevelDB and proving-artifact cache |
| `HUSH_NODE_CHAIN_SYNC_INTERVAL_SECONDS` | `60` | Delay between scan passes after a chain sync, limited to 15-2147483 seconds |
| `HUSH_NODE_ETHEREUM_RPC` | Built-in public nodes | Ethereum RPC override; separate URLs with commas or whitespace |
| `HUSH_NODE_ARBITRUM_RPC` | Built-in public nodes | Arbitrum RPC override |
| `HUSH_NODE_NETWORK_PROXY` | Empty | Optional HTTP(S) proxy |
| `LIGHT_API_ENABLED` | `true` | On by default for dedicated nodes; `false` makes all Light routes return 404 |
| `LIGHT_CORS_ORIGINS` | Empty | Exact origins allowed for CORS, separated by commas or whitespace; `*` is not supported |
| `LIGHT_EVM_RATE_PER_MINUTE` | `120` | Shared per-IP requests per minute for the six read-only `/evm/*` endpoints, limited to 10-1200 |
| `LIGHT_READ_RATE_PER_MINUTE` | `300` | Shared per-IP requests per minute for `/status`, `/trees/*`, `/fees`, and `/prices`, limited to 10-6000 |
| `LIGHT_ANCHOR_RATE_PER_MINUTE` | `60` | Per-IP requests per minute for `/anchor`, limited to 10-1200 |
| `LIGHT_TRUST_PROXY_HOPS` | `0` | Trusted `X-Forwarded-For` proxy hops, limited to 0-16; set only behind a trusted proxy |
| `LIGHT_EVM_EXTRA_TARGETS_ETHEREUM` | Empty | Read-only contract addresses added beyond the built-in Ethereum allowlist; at most 128 |
| `LIGHT_EVM_EXTRA_TARGETS_ARBITRUM` | Empty | Read-only contract addresses added beyond the built-in Arbitrum allowlist; at most 128 |
| `LIGHT_RELAY_ENABLED` | `false` | Enables `POST /api/light/v1/relay`, which only forwards signed raw transactions |
| `LIGHT_RELAY_MAX_BYTES` | `131072` | Per-transaction raw byte limit, 1024-1048576 |
| `LIGHT_RELAY_RATE_PER_MINUTE` | `12` | Per-IP relay requests per minute, limited to 1-600 |
| `LIGHT_BROADCASTER_ENABLED` | `false` | Enables `/api/light/v1/broadcaster/*`, which submits through Waku broadcasters; requires `LIGHT_API_ENABLED=true` |
| `LIGHT_BROADCASTER_RATE_PER_MINUTE` | `30` | Per-IP quote requests per minute, limited to 1-600 |
| `LIGHT_BROADCASTER_TRANSACT_RATE_PER_MINUTE` | `10` | Per-IP broadcast submissions per minute, limited to 1-600 |
| `LIGHT_SCAN_ENABLED` | `true` when a token is set | Explicit `false` disables `/scan`; enabling requires `LIGHT_API_ENABLED=true` |
| `LIGHT_SCAN_TOKEN` | Empty | Independent Bearer token for `/scan`; at least 24 characters when enabled; never reuse another token |
| `LIGHT_SCAN_MAX_JOBS` | `1` | Concurrent remote scans, limited to 1-4; extra requests queue (up to 8); values >= 2 reserve one slot for cold scans |
| `LIGHT_SCAN_TTL_SECONDS` | `120` | Seconds to retain completed or failed results, limited to 60-3600 |
| `LIGHT_SCAN_TIMEOUT_SECONDS` | `900` | Per-scan timeout in seconds, limited to 60-3600 |
| `LIGHT_SCAN_RATE_PER_MINUTE` | `6` | Per-IP scan starts per minute, limited to 1-120 |
| `LIGHT_SCAN_MAX_NOTES` | `5000` | Notes returned per scan, limited to 100-20000 |
| `LIGHT_SCAN_CACHE_DIR` | `<data dir>/scan` | Root of the resumable scan cache, bucketed by viewing-key digest |
| `LIGHT_SCAN_CACHE_TTL_SECONDS` | `604800` | Bucket idle expiry in seconds, limited to 0-31536000; 0 means memory only |
| `LIGHT_SCAN_CACHE_MAX_BUCKETS` | `64` | Maximum retained scan buckets, limited to 1-1024 |
| `LIGHT_SCAN_CACHE_MAX_BYTES` | `536870912` | Total byte budget for scan buckets, limited to 32 MiB-8 GiB |
| `HUSH_SCAN_BATCH_SIZE` | `200` | RAILGUN decryption batch size read by the engine patch, limited to 100-4000 |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

Numeric settings must fall within the ranges above. Invalid or out-of-range
values fail startup instead of being silently clamped.

A custom RPC replaces that network's built-in node list entirely. The Ethereum
RPC is also used to read the RAILGUN remote configuration and PPOI node list.
The service prefers IPv4 by default. `HUSH_NODE_NETWORK_PROXY` applies to RPC,
the QuickSync/TXID GraphQL index, PPOI, artifact downloads, and other outbound
requests; `HTTPS_PROXY`, `HTTP_PROXY`, and `ALL_PROXY` are also honored.

`LIGHT_EVM_EXTRA_TARGETS_*` lets a self-hosted deployment add explicitly
supported ERC-20 or other read-only contracts. Separate addresses with commas
or whitespace; startup validates the address format, deduplicates, and
lowercases them. A malformed value makes the process refuse to start. This only
extends the target allowlist for `/evm/call` and `/evm/estimate-gas`; it does
not unlock methods, block tags, or broadcasting. Native transfers with empty
calldata and a value do not depend on this allowlist.

Public RPCs are usually suitable only for incremental sync. A full historical
scan needs an archive or paid RPC when QuickSync is unavailable or the tree is
being built from scratch; configure at least one reliable node per chain in
production.

## Data directory

```text
data/
  railgun/db/            # Public RAILGUN Merkle trees and TXID/UTXO cursors
  railgun/artifacts/     # Zero-knowledge proving-artifact cache
  scan/                  # Optional: per-key-hash resumable scan cache for /scan
```

The service creates or repairs these directories to `0700`; existing
directories with wider permissions are `chmod`-ed, and paths that point at
files or symlinks refuse startup. The artifact cache rejects symlinks under its
root and writes files as `0600`; LevelDB file permissions follow the process
umask, so set `UMask=0077` in the deployment unit and audit periodically. Never
start multiple processes against the same data directory; LevelDB holds a
process lock.

HushNode and the Hush wallet must use different data directories. HushNode's
public LevelDB contains no user mnemonics or spending private keys. Decrypted
`/scan` notes go to a separate `scan/` disk cache by default (including
`treeScannedHeights`), or memory only with `LIGHT_SCAN_CACHE_TTL_SECONDS=0`.
Older versions wrote this data into the public database; handle that before
upgrading as described in the next section.

## Scan privacy isolation upgrade

This upgrade does not delete existing data automatically, and it cannot
guarantee erasure of historical decrypted content from old LevelDB logs or SST
files. Recommended procedure:

1. During a maintenance window, stop the old instance and confirm it no longer
   holds the data directory.
2. Point the new version at a brand-new empty `HUSH_NODE_DATA_DIR`; do not copy
   the old database.
3. Start the new version and let the public index resync. Clients keep their
   birthday block; restore remote scanning after sync completes.
4. Treat the old directory and old backups as private wallet data: revoke
   ordinary backup access and destroy them according to your media and
   encryption policy. A LevelDB delete or ordinary file deletion is not a
   secure erase.

At most 4 scan sessions run at once, each store holds at most 32 MiB of
serialized data, and sessions close after 10 minutes idle or 30 minutes of
lifetime. With the disk cache enabled, closing releases handles only; buckets
stay for resuming, expire after 7 days unused by default, and are capped at 64
buckets / 512 MiB with least-recently-used eviction and cleanup at startup and
runtime. SDK objects, decryption batches, and the JS runtime add memory
overhead; these limits are not a process RSS cap. Completed results have a
separate 32-job / 32 MiB total cap and expire after 120 seconds by default.
Insufficient capacity fails explicitly and never returns a truncated ledger;
clients should DELETE results after saving them.

Scanning responds to cancellation cooperatively at batch boundaries only; a
call stuck in SDK I/O cannot be force-killed. Stuck operations still occupy a
concurrency slot, which prevents unbounded background accumulation. If scan
sessions cannot be finalized during shutdown, the process logs the cleanup
failure and exits non-zero rather than reporting incomplete private storage
cleanup as success. A future separate scan subprocess could provide forced
termination; the current version does not.

## Scan capacity

Single-process scan throughput is limited by the main thread: decryption runs
in JS/WASM and one cold scan job uses about one core. The batch patch
(1600 -> 200) reduced `/trees` p95 during scans from about 484 ms to about
59 ms, at the cost of cold scans going from about 82 s to about 96 s (measured
on an M1 Pro with an 806 MB index). Concurrency still does not scale linearly:
two jobs share the main thread, total throughput improves only about 24%, and
each job is about 1.6x slower. Therefore:

- The default is `LIGHT_SCAN_MAX_JOBS=1`; set 2 if you can accept `/trees` p95
  around 1 s during cold scans. Do not use 4: throughput approaches the
  platform limit and both individual jobs and public endpoints slow down
  noticeably.
- A cold scan takes about 80 s; a cache hit for the same wallet takes about 2 s;
  when the chain head has not advanced, the previous result is reused
  directly. Improving cache hits (`LIGHT_SCAN_CACHE_TTL_SECONDS`,
  `LIGHT_SCAN_CACHE_MAX_BUCKETS`) is usually more effective than raising
  concurrency.
- To scale horizontally, each process must use its own data directory (LevelDB
  holds a process lock) and sit behind a queue or load balancer; never share one
  `HUSH_NODE_DATA_DIR` across processes.

## Startup and sync

- On startup the service reads the RAILGUN remote configuration, starts the
  engine, begins listening on HTTP, and then starts UTXO/TXID scanning for both
  chains.
- Each chain scans serially internally; chains can run concurrently. Failures
  retry with exponential backoff without blocking other chains.
- `/status` fields `ready`, `state`, `retryAttempt`, and `lastCompletedAt`
  reflect real initial-sync state; `engine.running` and `engine.scanning`
  reflect current engine and scan activity.
- `/trees`, notes, nullifiers, proof, and `/anchor` are available only after
  that network completes its initial sync; otherwise they return
  `503 LIGHT_INDEX_SYNCING`. `/fees`, `/prices`, and `/evm/*` do not require a
  fully ready tree, but still require the network to be loaded.
- On shutdown the service stops accepting new requests, drains in-flight
  requests, then stops scan jobs and the engine.

## Docker

```bash
docker build -t hush-node .
docker run --rm \
  -p 127.0.0.1:8788:8788 \
  -v "$PWD/data:/data" \
  --env-file .env \
  hush-node
```

The image sets `HOST=0.0.0.0`, `PORT=8788`, `HUSH_NODE_DATA_DIR=/data`, and
`ALLOW_PLAINTEXT_REMOTE=true` by default. This is safe only when isolated by the
container network or a trusted TLS proxy. Do not expose the port directly to
the public internet.

## Health checks

`GET /health` always returns `200` and only indicates that the HTTP process can
respond; the `ready` field in its body indicates whether the index has
completed initial sync for every configured network. `GET /readyz` is the
readiness probe: it returns `200` only when all networks are ready, otherwise
`503` with per-network status.

```bash
curl http://127.0.0.1:8788/health
curl -fsS http://127.0.0.1:8788/readyz
```

To check a specific network, call
`/api/light/v1/status?network=...&txidVersion=...`; an engine that has not
started returns `503 LIGHT_INDEX_UNAVAILABLE`, an unloaded network returns
`503 LIGHT_NETWORK_NOT_LOADED`, and incomplete sync returns
`503 LIGHT_INDEX_SYNCING`.

## Public deployment

- Terminate TLS at the outer proxy and set request body limits, access logs,
  and additional rate limits.
- Allow only the origins you need; `LIGHT_CORS_ORIGINS` does not support `*`.
- `/relay` is disabled by default; before enabling it, confirm the upstream
  RPC's broadcast policy and abuse costs.
- `/scan` requires its own token by default; never put `LIGHT_SCAN_TOKEN` in
  browser code.
- Behind a reverse proxy, `request.ip` is usually the proxy address. Only a
  trusted proxy can supply the real client IP; without
  `LIGHT_TRUST_PROXY_HOPS`, all clients may share one rate-limit bucket. The
  value must match the actual number of proxy layers; too large a value lets
  clients spoof `X-Forwarded-For`.

## Troubleshooting

- `LIGHT_INDEX_UNAVAILABLE`: the engine has not started, usually because
  remote configuration or RPC startup failed.
- `LIGHT_NETWORK_NOT_LOADED`: the requested network has not completed provider
  health checks.
- `LIGHT_INDEX_SYNCING`: the network's initial UTXO/TXID sync is incomplete;
  check `/status` or `/readyz` and do not treat it as an HTTP process failure.
- `NULLIFIER_INDEX_UNAVAILABLE`: the nullifier LevelDB is unreadable; the
  service does not rebuild it automatically.
- `EVM_RPC_UNAVAILABLE` / `ANCHOR_UNAVAILABLE` / `FEE_QUOTE_UNAVAILABLE`:
  upstream error text is suppressed; check RPC health and the egress proxy.
- The first scan is very slow: confirm QuickSync is reachable; if not, switch
  to a reliable archive RPC.
- `429 SCAN_BUSY`: the queue is full (8 waiting) or the job table reached 32;
  clear completed results first, then consider raising
  `LIGHT_SCAN_MAX_JOBS`. Merely having a scan running no longer returns 429.
