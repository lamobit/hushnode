# Security and limits

## Trust boundary

- One process, one data directory; isolation is application-level, not strong
  tenant or process isolation.
- The service is a read-only public on-chain index by default. It does not
  prove, build transactions, or accept spending private keys, mnemonics, or
  signatures (except `/relay`, which only forwards caller-signed raw
  transactions).
- The service listens on loopback by default; remote plaintext binds must be
  explicitly enabled and placed behind a trusted TLS proxy.
- Data directories are created or repaired to `0700`; paths that point at files
  or symlinks refuse startup. Artifact reads and writes are allowed only inside
  the artifact root, validating real directories segment by segment and
  rejecting symlinks; files are written as `0600` with exclusive temp files.
  LevelDB permissions depend on the deployment umask; set it to `0077`.

## Key material

- The normal tree, commitment, note ciphertext, nullifier, and proof endpoints
  access only public on-chain data and store no user keys.
- `/scan` accepts a shareable viewing key (`vpriv` + `spub`). It can only
  decrypt and view that account's private transfers, balances, and notes; it
  cannot sign or spend. Scan wallets use an independent store and are not
  registered in the global engine; they only reuse public UTXO tree reads and
  never write wallet state to the public LevelDB.
- Private sessions are isolated by key digest, network, and version; at most 4
  exist, each with a 32 MiB serialized-data cap. They close after 10 minutes
  idle or 30 minutes of lifetime, with an idle check every 30 seconds. When
  full, the least-recently-used idle session is evicted; a session that is
  scanning is never deleted by another task.
- Closing a disk session only releases handles and keeps its bucket. The
  default quota (7 days unused, at most 64 buckets / 512 MiB) cleans up old
  buckets. An entire bucket is deleted only when it is corrupt, over quota, or
  explicitly cleared.
- Disk buckets contain SDK-decrypted notes, memos, and balances, plus
  `treeScannedHeights`; the SDK encrypts only wallet records, not these
  application values. Directories are `0700` and file permissions depend on the
  umask; set `UMask=0077`, use full-disk encryption, and restrict access to
  backups, swap, and core dumps.
- Cleanup removes wallet listeners and overwrites mutable viewing private-key
  byte buffers. JS strings, GC, and ordinary file deletion provide no physical
  erasure guarantee; deleting a bucket is not a secure erase.
- Completed results are retained for 120 seconds by default, with a cap of 32
  jobs / 32 MiB of serialized note data. Clients should DELETE results after
  saving them. Sessions and results expire separately; deleting a result
  neither retains nor advances the cursor.
- Scan completion validates at most 4096 trees, with database reads capped at
  16 concurrent operations. An abnormal tree pointer or tree length fails the
  scan instead of preallocating a large array from an untrusted index value.
- Decrypted data written by older versions does not disappear on upgrade.
  Before launch, switch the data directory as described in the operations
  guide; old LevelDB files, logs, and backups must be treated as sensitive, and
  logical deletion is not physical erasure.
- The `/scan` token is stored only as a SHA-256 digest and compared in constant
  time; never reuse the Hush wallet API key or credentials from another
  service.
- Logs must not record shareable viewing keys, scan tokens, plaintext notes, raw
  transactions, or request bodies. Error responses contain only
  `{ error, code }`.

## Data plane boundary

- `notes` passes through commitment ciphertext / preImage that is already
  public in on-chain events, for client-side trial decryption; it is not a
  server-side decryption result.
- `anchor` is a read-only `eth_call`: it reads the local root, the current
  on-chain root, and `rootHistory(tree, root)`, without writing or signing.
  Results are cached for about 15 seconds and failures are not cached; it has
  an independent per-IP limit, and concurrent misses for the same query
  coalesce into one on-chain read.
- `/evm/*` is not an open JSON-RPC proxy. It exposes account, gas, and receipt
  queries plus `eth_call` / `eth_estimateGas` simulation against allowlisted
  contracts; the only exception is native transfer estimation with empty
  calldata and a value, which may target any recipient. Clients cannot choose
  arbitrary methods, block tags, or contracts.
- The allowlist consists of the network's RAILGUN contract addresses plus
  HushNode token addresses; other targets return `403 TARGET_NOT_ALLOWED`
  (except native transfer estimation).
- `/evm/*` does not accept private keys, mnemonics, spending/viewing keys,
  signatures, or raw transactions, and does not build, modify, or broadcast
  transactions. Logs record only the network and failure event, never
  addresses, calldata, or results.
- `/relay` only accepts already-signed raw transaction bytes; it does not
  parse, re-encode, fill nonces, or change gas. It has no account semantics,
  idempotency, balance checks, or replay protection; broadcast success does not
  mean final inclusion on chain.
- `/broadcaster/*` only accepts proven RAILGUN calldata, nullifiers, and quote
  ids. The target contract is fixed to the network's RAILGUN proxy, and fees
  and the recipient come from the server quote, so clients cannot replace them.
  Broadcasters still independently validate the proof, fee, and PPOI; the node
  never touches private keys.

## Privacy trade-offs

- A client connecting directly to a public RPC exposes its IP; through
  HushNode, the upstream RPC sees the node's egress IP. This benefit assumes
  the node itself is trusted.
- `/relay` exposes the request IP, time, network, and full signed transaction
  to the node; the RPC also sees the transaction and the node's egress IP.
- `/scan` exposes the shareable viewing key and all private transfers and note
  contents for that account to the node. Use only a self-hosted or explicitly
  trusted node; the default remains local decryption and scanning on the phone.
- `/broadcaster/*` exposes calldata, nullifiers, the source IP, and the
  on-chain transaction to the node; the node forwards them to Waku
  broadcasters and the RPC, which both see the transaction and the node's
  egress IP.
- `/evm/activity` causes the node to send the public address to Blockscout;
  Blockscout sees the node's egress IP, not the phone's IP. This endpoint
  returns only public on-chain records and never touches private keys or notes.
  Responses explicitly set `complete=false` and `warnings` so a failed or
  truncated history is not mistaken for a complete ledger. Upstream pagination
  is limited to 16 parameters, and key/value and final URL lengths are capped;
  malformed pagination is marked invalid instead of claiming a complete
  history.

## Network exposure

- The default is `127.0.0.1` only. Prefer SSH tunnels for remote access.
- The reverse proxy must provide TLS, access control, request body limits, and
  origin restrictions; set `ALLOW_PLAINTEXT_REMOTE=true` only behind a trusted
  proxy.
- Built-in rate limits cover the unauthenticated read-only index endpoints,
  `/relay`, `/anchor`, and `/scan` starts; the outer proxy should still enforce
  stricter origin-level limits and access control.
- The built-in limiter has a hard cap on client buckets, sweeps expired buckets
  amortized, and evicts the least-recently-used bucket when full. This prevents
  unbounded in-process state growth but does not replace outer rate limiting
  based on a trusted source.
- Behind a reverse proxy, trust `X-Forwarded-For` only when
  `LIGHT_TRUST_PROXY_HOPS` matches the actual number of proxy layers. With the
  default of 0, do not treat that header as client identity; a value that is
  too large lets clients spoof their rate-limit source.
- CORS is off by default; `LIGHT_CORS_ORIGINS` accepts exact origins only and
  does not support wildcards.

## Upstream dependencies and known limits

- RPCs, QuickSync, PPOI, RAILGUN remote configuration, and LevelDB data can all
  be wrong or stale; clients must verify with `anchor`, local proofs, receipts,
  and their own chain head.
- RAILGUN remote configuration limits providers per network and accepts only
  HTTP(S)/WS(S) URLs; there are at most 8 remote providers, at most 12 total per
  network, and at most 12 health probes with concurrency 4. Configuration JSON
  is capped at 256 KiB, and PPOI, peer, fee signer, and blacklist entries each
  have their own count and length limits; oversized or malformed fields are
  dropped, and a failed read falls back to built-in nodes and fee signers.
- Blockscout and price-service requests do not follow redirects automatically,
  preventing an upstream redirect to an internal address.
- A Blockscout page response is capped at 8 MiB and a price response at 1 MiB;
  exceeding the cap fails immediately rather than reading the full anomalous
  response into memory.
- A non-1559 fallback without `maxFeePerGas` / `maxPriorityFeePerGas` returns
  `null` instead of inventing a priority fee.
- Event parsing changes, RAILGUN SDK upgrades, or chain reorganizations may
  require rescanning local trees; the service never silently rebuilds the
  nullifier LevelDB.
- The code has not been third-party audited and is suitable only for controlled
  environments and small, disposable index data.
