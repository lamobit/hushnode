# Light index API

`/api/light/v1` is enabled by default on dedicated nodes; set
`LIGHT_API_ENABLED=false` to disable every route. It requires no API key and exposes only the
RAILGUN public on-chain index plus a restricted read-only EVM data plane. The phone keeps the
mnemonic and spending/viewing keys, decrypts notes locally, proves, and signs; the server never
touches user keys, decrypts notes, or builds transactions. `notes` passes through commitment
ciphertext / preImage already public on chain, for client-side trial decryption.

The optional `/scan` is the only exception: after the client submits a shareable viewing key
(viewing private key + spending public key), HushNode creates a temporary view-only wallet, scans
on its behalf, and returns only that address's notes. It requires a separate `LIGHT_SCAN_TOKEN`;
spending keys, mnemonics, and signatures stay on the phone.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/status?network=&txidVersion=` | Engine and sync readiness, chain height, latest tree and root |
| `GET` | `/trees?network=&txidVersion=` | Leaf counts and roots for the most recent 128 trees |
| `GET` | `/trees/:tree/notes?start=&limit=&network=&txidVersion=` | Full commitment objects in a range; at most 256 per request |
| `GET` | `/trees/:tree/nullifiers?after=&limit=&network=&txidVersion=` | On-chain nullifiers; cursor pagination, at most 2000 per request |
| `GET` | `/trees/:tree/proof/:leaf?network=&txidVersion=` | 16-level Poseidon Merkle proof |
| `GET` | `/fees?network=` | Shield / unshield / NFT fees of the RAILGUN proxy contract |
| `GET` | `/prices?network=&currency=` | Fiat prices for allowlisted tokens |
| `GET` | `/anchor?network=&txidVersion=&tree=&root=` | Verify a tree root is anchored via the contract `rootHistory` |
| `GET` | `/evm/account?network=&address=` | Pending nonce, latest balance, and current block for a public address |
| `GET` | `/evm/gas?network=` | Base fee, max priority fee, and max fee for the current block |
| `POST` | `/evm/call` | Read-only `eth_call` against allowlisted contracts |
| `POST` | `/evm/estimate-gas` | Estimate gas; native transfers may target any address, contract calls only allowlisted |
| `GET` | `/evm/receipt?network=&hash=` | Transaction receipt and confirmation status |
| `GET` | `/evm/activity?network=&address=&limit=` | Native / ERC-20 history for a public address |
| `POST` | `/relay` | Forward a signed raw transaction; off by default, requires `LIGHT_RELAY_ENABLED=true` |
| `POST` | `/broadcaster/quote` | Get a broadcaster quote; requires `LIGHT_BROADCASTER_ENABLED=true` |
| `POST` | `/broadcaster/transact` | Submit a proven transaction through a broadcaster; idempotent per quote id |
| `GET` | `/broadcaster/transact/:id` | Poll an asynchronous broadcaster submission |
| `POST` | `/scan` | Start a remote note scan with a shareable viewing key; on by default once its token is set |
| `GET` | `/scan/:jobId` | Read remote scan progress; returns notes for the address when done |
| `DELETE` | `/scan/:jobId` | Cancel and clean up a remote scan job |

- `network` is `ethereum` or `arbitrum`; `txidVersion` is `V2_PoseidonMerkle` or
  `V3_PoseidonMerkle`. Responses always use lowercase `ethereum` / `arbitrum`; requests are
  case-insensitive, but clients should compare lowercase.
- `status` always returns HTTP `200` (when the light API is enabled and the engine is configured),
  but `ready` is true only after the engine runs, the network loads, and that network completes its
  initial sync. `state` is `starting` / `syncing` / `ready` / `degraded`; `block` and `tree` may be
  `null` before initial sync, and clients must handle that. `retryAttempt` and `lastCompletedAt`
  show sync progress; `engine.scanning` only reports whether a scan runs now; `currencies` lists the
  `/prices` currencies (nodes that omit it are treated as usd/cny/eur/jpy).
- `notes` defaults to `limit=128`, max `256`. The response is `{ tree, start, leaves, notes, next }`;
  each note is a full public commitment plus its absolute leaf index `index`. The server only reads
  a range: it does not filter, decrypt, or infer the recipient.
- `nullifiers` defaults to `limit=512`, max `2000`. `after` is the previous page's last nullifier;
  the response is `{ tree, nullifiers, next }`. `next` is the last nullifier only when more may
  exist, else `null`. Clients decide spent status from locally computed nullifiers.
- `proof` returns a 16-level Poseidon Merkle witness; `leaf`, `elements`, `indices`, and `root` are
  lowercase 32-byte hex without `0x`. A malformed index or depth other than 16 returns
  `503 LIGHT_INDEX_UNAVAILABLE`; an incomplete witness is never passed through.
- `fees` reads `shieldFee()`, `unshieldFee()`, and `nftFee()` from the RAILGUN proxy and returns the
  raw contract integers (basis points) as strings, with no float conversion. Results are cached in
  memory for 60 seconds; an RPC failure returns `503 FEE_QUOTE_UNAVAILABLE`.
- `anchor` reads the local root and calls the contract to confirm it appears in
  `rootHistory(tree, root)`; it does not change the local index or verify proofs for the client.
  Omitting `root` checks the local root; otherwise it checks the 32-byte query root (`0x`
  optional). Success returns `{ network, txidVersion, tree, leaves, localRoot, root, anchored,
  chainRoot, block, checkedAt }`, cached about 15 seconds; failures are not cached. A missing tree
  returns `404 TREE_NOT_FOUND`, bad parameters `400 INVALID_REQUEST`, and RPC or ABI decode
  failures `503 ANCHOR_UNAVAILABLE`; the error body omits the RPC URL and upstream text.
- V2 `anchor` uses `merkleRoot()` on `NETWORK_CONFIG[network].proxyContract`; V3 uses
  `accumulatorRoot()` on `NETWORK_CONFIG[network].poseidonMerkleAccumulatorV3Contract`. Both use
  `rootHistory(uint256,bytes32)`. If the dependencies or network have no V3 contract address, V3
  `anchor` returns `503 ANCHOR_UNAVAILABLE` rather than guessing.
- `anchor` has an independent per-IP sliding-window quota (60/min by default,
  `LIGHT_ANCHOR_RATE_PER_MINUTE` limited to 10-1200); over it returns `429 RATE_LIMITED`.
  Concurrent misses for the same network, tree, version, and root coalesce into one on-chain query;
  successful results are cached about 15 seconds and failures are not cached.
- `prices` returns fiat unit prices for the token allowlist; `currency` follows `currencies` from
  `/status` (usd/cny/eur/jpy/gbp/hkd/sgd/krw/cad/aud/chf). Prices are keyed by lowercase contract
  address, with native ETH at `0x0000000000000000000000000000000000000000`; they are cached per
  network and currency for about 45 seconds, and an upstream anomaly returns
  `503 PRICE_UNAVAILABLE`. Valuations are estimates only.
- `evm/account` accepts only `0x` plus 40 hex characters and returns a lowercase address. `nonce` is
  the decimal string from `eth_getTransactionCount(address, "pending")`; `balance` is the latest
  decimal wei string; `block` is the current block number. Only loaded `ethereum` / `arbitrum` work.
- `evm/gas` returns the current block's `baseFeePerGas`, `maxPriorityFeePerGas`, and `maxFeePerGas`
  as decimal strings; `block` is also decimal. Fees come directly from ethers `getFeeData()` / the
  latest block, with no hidden priority fee. A non-1559 fallback that leaves a value unset returns
  `null` instead of fabricating a constant such as 1 gwei.
- Non-negative integers that `evm/account`, `evm/gas`, `evm/estimate-gas`, and `evm/receipt` read
  from the RPC must fit in `uint256`; out-of-range or negative values are upstream failures `503`.
- `evm/call` performs only a latest `eth_call` with body `{ network, to, data }` and returns
  `{ result }`. The upstream result must be even-length `0x` hex, at most 64 KiB; malformed or
  oversized values return `503 EVM_RPC_UNAVAILABLE`. `evm/estimate-gas` takes
  `{ network, from, to, data, value? }`, where `value` is decimal or `0x` hex in `0..2^256-1`, and
  returns `{ gas }` as a decimal string.
- `to` for `evm/call` and contract `evm/estimate-gas` must belong to the network allowlist: the
  RAILGUN `proxyContract`, `relayAdaptContract`, `poseidonMerkleAccumulatorV3Contract`,
  `poseidonMerkleVerifierV3Contract`, `tokenVaultV3Contract` (when non-empty), plus every token and
  wrapped-token address. `LIGHT_EVM_EXTRA_TARGETS_ETHEREUM` / `..._ARBITRUM` add addresses at
  startup, each only to its matching network; comparison is case-insensitive and other targets
  return `403 TARGET_NOT_ALLOWED`. The exception is a native transfer: with `data=0x` and
  `value > 0`, `evm/estimate-gas` allows any `to`; calldata or zero-value estimates still follow
  the allowlist. This is not a general JSON-RPC proxy: no arbitrary method, block tag, or other
  contract. Arbitrum includes native USDC and bridged USDC.e by default so clients do not fail when
  choosing between the two stablecoins.
- `data` must be `0x`-prefixed even-length hex, at most 16 KiB; an invalid address, network, or
  `value` returns `400 INVALID_REQUEST`. EVM read RPC failures uniformly return
  `503 EVM_RPC_UNAVAILABLE`, and the error body omits the RPC URL and upstream text.
- `evm/receipt` accepts only `0x` plus 64 hex characters. Not found returns only
  `{ found: false, status: "pending" }`; found returns `found: true`, `blockNumber`, `gasUsed`, and
  `effectiveGasPrice`. `status` is `success` (1), `reverted` (0), or `pending` (null); numeric
  fields are decimal strings.
- `evm/activity` reads public-address transactions and ERC-20 transfers from that network's
  Blockscout v2: at most 3 pages, 12 seconds per request, 15 seconds total, merged result cached
  in-process for 15 seconds. Incomplete results are cached only about 5 seconds to avoid amplifying
  a bad upstream. It keeps at most 300 records per upstream history category and caches at most 300
  merged records; the total activity cache budget is 8 MiB, and a result over the per-item budget
  is still returned but not cached. `limit` defaults to 100, max 300, newest first. The response is
  `{ network, address, items, complete, warnings }`; each item has `hash`, millisecond
  `timestamp`, `blockNumber`, `fee` (decimal wei string or `null`), `status` (`completed` /
  `failed`), `from`, `to`, and `legs`. Each leg has `direction` (`in` / `out`), `tokenAddress`
  (`null` for native), `symbol`, `decimals`, and a decimal `value`. Only transactions with a value
  change are returned; failed native transactions stay `failed`, and ERC-20 transfers from failed
  transactions are ignored. `complete=false` means at least one upstream page failed, was
  truncated, or one of transactions / token transfers was unavailable; `warnings` lists the
  categories (`TRANSACTION_HISTORY_UNAVAILABLE`, `TOKEN_TRANSFER_HISTORY_UNAVAILABLE`,
  `TRANSACTION_HISTORY_TRUNCATED`, `TOKEN_TRANSFER_HISTORY_TRUNCATED`,
  `TRANSACTION_HISTORY_INVALID`, `TOKEN_TRANSFER_HISTORY_INVALID`). A structurally invalid upstream
  response is never reported as a complete empty history. Clients must not treat incomplete history
  as a complete ledger. Unknown tokens do not trust the Blockscout symbol and show as
  `symbol · 0x1234…abcd` or `ERC-20 0x1234…abcd`. An unavailable upstream returns
  `503 ACTIVITY_UNAVAILABLE`.
- The six `/evm/*` read endpoints share a per-IP sliding-window quota, 120/min by default
  (`LIGHT_EVM_RATE_PER_MINUTE` limited to 10-1200); over it returns `429 RATE_LIMITED`. `/relay`
  uses a separate quota. Quotas are in-process and reset on restart.
- `/status`, `/trees/*`, `/fees`, and `/prices` share another per-IP window quota, 300/min by
  default (`LIGHT_READ_RATE_PER_MINUTE` limited to 10-6000); over it returns `429 RATE_LIMITED`.
  `/anchor` and `/relay` keep their own quotas.
- `relay` accepts only `{ network, rawTransaction }`: `network` must be loaded, and
  `rawTransaction` must be even-length `0x` hex whose first byte is `0x01/0x02/0x03/0x04` or
  `>=0xc0`, with length `1..LIGHT_RELAY_MAX_BYTES`. The server does not parse or change gas; it
  only hands the bytes to the RPC and returns `{ network, hash, receivedAt }`. Deterministic
  rejections return `422 INSUFFICIENT_FUNDS`, `409 NONCE_CONFLICT`,
  `409 REPLACEMENT_UNDERPRICED`, `409 TRANSACTION_ALREADY_KNOWN`, or `422 INVALID_TRANSACTION`; an
  unconfirmed failure returns `503 RELAY_UNAVAILABLE`.
- `relay` is off by default (`403 RELAY_DISABLED`) and limited to 12 requests per IP per minute;
  its body uses a separate JSON parser and is not subject to the general 64 KB cap.
- Clients must verify `anchor`'s `chainRoot` and `anchored` plus their local proof: an RPC can
  return wrong or stale chain state. The trust model is "trusted indexer/RPC plus local keys,
  proofs, and signatures".

## Remote note scan

`/scan` lets a trusted HushNode perform the first view-only scan for the phone, avoiding a full
commitment-tree download. With `LIGHT_API_ENABLED=true` it is enabled by default as soon as a
separate `LIGHT_SCAN_TOKEN` (at least 24 characters) is set; use `LIGHT_SCAN_ENABLED=false` to
disable it. This token is for `/scan` only; never reuse an RPC provider key or other credentials.

```http
POST /api/light/v1/scan
Authorization: Bearer <LIGHT_SCAN_TOKEN>
Content-Type: application/json

{
  "network": "arbitrum",
  "txidVersion": "V2_PoseidonMerkle",
  "shareableViewingKey": "<msgpack hex: { vpriv, spub }>",
  "fromBlock": 12345678,
  "includeSpent": true
}
```

- `shareableViewingKey` is the standard RAILGUN SDK format: a msgpack map containing only `vpriv`
  (32-byte viewing private key) and `spub` (packed BabyJub spending public key). HushNode validates
  the structure strictly and rejects extra fields; a mnemonic or spending private key is never
  accepted. It accepts str/bin and wider length prefixes, normalizes to the SDK str8 form, and also
  accepts early clients that concatenated two 32-byte keys (optionally with `0x82`) or the old
  format that declared 64 bytes but wrote a 32-byte binary key, with a warning. New clients should
  send standard msgpack.
- `fromBlock` defaults to the RAILGUN proxy deployment block (Ethereum `14737691`, Arbitrum
  `56109834`); it must be a non-negative safe integer, and values below the deployment block are
  raised to it. Importing an old wallet can use a later birthday block to reduce the range.
- `includeSpent` defaults to `true`; results then include spent notes marked `spent: true`, which
  clients use to update their local ledger.
- Only `V2_PoseidonMerkle` is supported; V3 returns `400 UNSUPPORTED_TXID_VERSION` because the
  client V3 spending flow is not complete.

A successful start returns `202 { "jobId": "…" }`. `GET /scan/:jobId` returns:

```json
{
  "jobId": "…",
  "network": "arbitrum",
  "txidVersion": "V2_PoseidonMerkle",
  "status": "queued | running | done | error | cancelled",
  "stage": "queued | syncing | scanning",
  "progress": 0.42,
  "found": 12,
  "notes": [],
  "truncated": false,
  "nextFromBlock": 12345700,
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000
}
```

- `notes` is returned only when `status=done`. Each note has `tree`, `leaf`, `hash`, `blockNumber`,
  `txid`, `kind`, `commitmentType`, `tokenHash`, `value` (decimal string), `random`,
  `senderRandom`, `memo`, `nullifier`, and `spent`. The server skips NFTs, legacy commitments, and
  unsupported token types.
- Results are capped at 5000 by default (`LIGHT_SCAN_MAX_NOTES`, 100-20000). Over the cap the job
  errors without a partial ledger or cursor advance; raise the limit or use a local scan.
  `truncated` is a compatibility field, always false on success.
- `nextFromBlock` on success is the chain-head block covered by the scan, usable as the next
  `fromBlock` (that block is rescanned once and deduplicated by `tree/leaf`); it is `null` while
  queued, running, failed, cancelled, or over the result cap. Older notes' spent status still needs
  incremental refresh by nullifier.
- `LIGHT_SCAN_MAX_JOBS` (1-4) controls concurrency. When full, jobs enter a FIFO queue
  (`status=queued`, max 8) and only overflow returns `429 SCAN_BUSY`; `maxJobs >= 2` reserves one
  slot for cold scans. Results are kept 120 seconds, at most 32 jobs / 32 MiB.
- An unchanged chain head reuses the previous result; lowering the decryption batch from 1600 to
  200 reduced `/trees` p95 during scans from about 484 ms to about 59 ms.
- When the same wallet (same shareable viewing key, network, format, birthday, and `includeSpent`)
  already has a running job, a duplicate `POST /scan` returns the original `jobId`, so clients can
  keep polling after a restart without consuming a new slot.
- If the network has not completed its initial sync, `POST /scan` returns
  `503 LIGHT_INDEX_SYNCING` immediately without creating a queued job or slot; wait for `/readyz`
  or `/status` to report ready.
- `DELETE /scan/:jobId` cancels a running job; for a completed job it deletes the result and a
  later GET returns 404. Cancellation and timeout take effect at SDK batch boundaries; unfinished
  background work keeps occupying its slot.
- If a client disconnects before receiving `202`, HushNode immediately cancels the new job and
  clears the viewing key, leaving no server-only orphan scan.
- Scan wallets write only to an independent store, not the public engine; the disk bucket stores
  the wallet DB (notes and `treeScannedHeights`) so restarts can resume. At most 4 sessions x
  32 MiB; buckets default to 7 days and 64 buckets / 512 MiB; closing only releases handles, while
  expiry, corruption, or quota deletes the bucket. The cache holds decrypted notes, so use a
  private directory and full-disk encryption; ordinary deletion is not a secure erase.
- Privacy: once enabled, HushNode can see every private transfer, balance, and note for that
  account, but never has the spending private key and cannot sign or spend. Enable it only on a
  self-hosted or explicitly trusted node; local decryption and scanning on the phone stays the
  default.
- Errors: `403 SCAN_DISABLED`, `401 SCAN_UNAUTHORIZED`, `400 INVALID_SHAREABLE_VIEWING_KEY`,
  `429 SCAN_BUSY`, `429 RATE_LIMITED`, `404 SCAN_NOT_FOUND`, `503 LIGHT_INDEX_SYNCING`. Error
  bodies never contain a viewing key, token, or plaintext note.
- CORS sends no cross-origin headers by default; for browser previews, set an exact
  `scheme://host[:port]` list in `LIGHT_CORS_ORIGINS`; wildcards are not supported.
- When disabled the prefix returns `404 LIGHT_API_DISABLED`; an unstarted engine or unloaded
  network returns `503 LIGHT_INDEX_UNAVAILABLE` / `503 LIGHT_NETWORK_NOT_LOADED`.
- Trees, notes, nullifiers, proof, and anchor return `503 LIGHT_INDEX_SYNCING` until initial sync
  completes; `/fees`, `/prices`, and `/evm/*` do not require a fully ready tree.
- An unreadable nullifier LevelDB returns `503 NULLIFIER_INDEX_UNAVAILABLE`; the service never
  rebuilds, migrates, or writes the database.
- Public deployments should add TLS, origin-level rate limiting, and access logs at the outer
  proxy; built-in quotas cover unauthenticated read-only index endpoints, `relay`, `anchor`, and
  `scan` starts, and do not replace outer protection.
- When a client aborts a long request, HushNode stops waiting on upstream RPC, price, or Blockscout
  requests. Coalesced price, activity, and anchor queries cancel only after the last waiting client
  disconnects; while any client waits, the shared query continues.

Error bodies use only `{ error, code }`. `status.protocol` is fixed at `1`; clients negotiate only
by that version.

## Non-custodial boundary

- `anchor` is a read-only `eth_call`: it reads the local root, the current on-chain root, and
  `rootHistory`, without signing, writing, or reading any wallet key.
- `/evm/*` is a restricted read-only data plane: `account`, `gas`, and `receipt` only query public
  chain state; `call` and `estimate-gas` only simulate against allowlisted contracts, never
  broadcast, write, or sign, and never accept private keys, mnemonics, or spending/viewing keys;
  `estimate-gas` relaxes the target only for native transfers with empty calldata and a value.
  HushNode sees the request address and calldata, but logs only network and failure events, never
  addresses, calldata, or raw results.
- `relay` only forwards a caller-signed raw transaction; HushNode touches no private keys,
  mnemonics, or spending/viewing keys and does not build, modify, or replace transactions. A
  successful broadcast does not mean final inclusion. `POST /relay` provides no authentication,
  idempotency, nonce management, balance check, or fee quote.
- `broadcaster/quote` returns `{ id, network, tokenHash, feeRecipient, fee, minGasPrice, expiresAt }`
  for a trusted Waku broadcaster; quotes last 15 minutes and fees are capped at 10% of the amount.
  `broadcaster/transact` takes that quote, calldata, and `nullifiers`; echoing the terms lets a
  restarted instance relay a quote it never stored, after re-checking the live fee schedule. With
  `async: true` it returns `202` and `GET /broadcaster/transact/:id` reports the terminal hash or
  failure, keeping Waku's two-minute wait out of the request. Duplicate starts are idempotent.

## Examples

```http
GET /api/light/v1/trees/42/notes?network=arbitrum&txidVersion=V2_PoseidonMerkle&start=0&limit=128

{
  "tree": 42,
  "start": 0,
  "leaves": 4096,
  "notes": [
    {
      "hash": "…",
      "index": 0,
      "commitmentType": "TransactCommitmentV2",
      "ciphertext": {
        "ciphertext": { "iv": "…", "tag": "…", "data": ["…"] },
        "memo": "…",
        "blindedSenderViewingKey": "…",
        "blindedReceiverViewingKey": "…"
      }
    }
  ],
  "next": 128
}
```

```http
GET /api/light/v1/trees/42/nullifiers?network=arbitrum&txidVersion=V2_PoseidonMerkle&limit=512

{
  "tree": 42,
  "nullifiers": ["…"],
  "next": "…"
}
```

```http
GET /api/light/v1/fees?network=arbitrum

{
  "network": "arbitrum",
  "shieldFee": "25",
  "unshieldFee": "25",
  "nftFee": "100",
  "block": 12345678,
  "updatedAt": 1760000000000
}
```

```http
GET /api/light/v1/anchor?network=arbitrum&txidVersion=V2_PoseidonMerkle&tree=42

{
  "network": "arbitrum",
  "txidVersion": "V2_PoseidonMerkle",
  "tree": 42,
  "leaves": 4096,
  "localRoot": "…",
  "root": "…",
  "anchored": true,
  "chainRoot": "…",
  "block": 12345678,
  "checkedAt": 1760000000000
}
```

```http
GET /api/light/v1/evm/account?network=arbitrum&address=0x1111111111111111111111111111111111111111

{
  "network": "arbitrum",
  "address": "0x1111111111111111111111111111111111111111",
  "nonce": "7",
  "balance": "1000000000000000000",
  "block": 12345678
}
```

```http
GET /api/light/v1/evm/gas?network=arbitrum

{
  "network": "arbitrum",
  "block": "12345678",
  "baseFeePerGas": "100000000",
  "maxPriorityFeePerGas": "1000000",
  "maxFeePerGas": "300000000"
}
```

```http
GET /api/light/v1/evm/receipt?network=arbitrum&hash=0x2222222222222222222222222222222222222222222222222222222222222222

{
  "found": true,
  "status": "success",
  "blockNumber": "12345678",
  "gasUsed": "21000",
  "effectiveGasPrice": "1000000000"
}
```

```http
POST /api/light/v1/relay
Content-Type: application/json

{
  "network": "arbitrum",
  "rawTransaction": "0x02f8…"
}

{
  "network": "arbitrum",
  "hash": "0x…",
  "receivedAt": 1760000000000
}
```
