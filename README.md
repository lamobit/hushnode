# HushNode

HushNode is a public, read-only RAILGUN Light API node split out of the Hush
wallet service. It maintains its own Ethereum/Arbitrum UTXO/TXID index and
serves trees, commitments, note ciphertext, nullifiers, Merkle proofs, public
chain reads, and optional view-only note scanning to mobile clients.

> By default the service never handles private keys, mnemonics, or spending
> keys. The optional `/scan` endpoint accepts a shareable viewing key and must
> be enabled only on a self-hosted or explicitly trusted node.

## Capabilities

- `/api/light/v1` needs no Hush wallet API key; when disabled, every route
  returns `404 LIGHT_API_DISABLED`.
- RAILGUN V2/V3 trees, roots, commitments, note ciphertext, nullifiers, and
  16-level proofs.
- `/health` separates process liveness from index readiness; `/readyz` serves
  as the readiness probe.
- Restricted read-only EVM data plane: accounts, gas, receipts, public
  activity, and call / gas estimation against allowlisted contracts.
- Optional signed raw transaction relay, disabled by default.
- Optional broadcaster relay (`/broadcaster/quote`, `/transact` over Waku),
  disabled by default; the node never holds a hot wallet.
- Optional token-gated remote note scanning: one concurrent job by default,
  with a bounded queue (up to 8) instead of immediate rejection.
- A separate process and RAILGUN LevelDB; it never shares a data directory with
  the Hush wallet.

## Quick start

Requires Node.js 24+ and pnpm.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

Listens on <http://127.0.0.1:8788> by default:

```bash
curl 'http://127.0.0.1:8788/'
curl 'http://127.0.0.1:8788/health'
curl -fsS 'http://127.0.0.1:8788/readyz'
curl 'http://127.0.0.1:8788/api/light/v1/status?network=arbitrum&txidVersion=V2_PoseidonMerkle'
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

## Documentation

| Topic | Entry point |
| --- | --- |
| Documentation map and sources of truth | [docs/README.md](docs/README.md) |
| HTTP routes, parameters, and error codes | [docs/light-api.md](docs/light-api.md) |
| Configuration, deployment, data directories, troubleshooting | [docs/operations.md](docs/operations.md) |
| Trust boundaries, privacy, and network exposure | [docs/security.md](docs/security.md) |

Public RPCs are usually suitable only for incremental sync. Configure a
reliable private or paid RPC when QuickSync is unavailable or when building the
tree from scratch. Public deployments must terminate TLS, rate limit, and keep
access logs at an outer proxy.
