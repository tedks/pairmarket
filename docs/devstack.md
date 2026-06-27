# Local Devstack

Pairmarket's local devstack is a Sui Localnet plus an isolated deployer
configuration. By default it starts the local network with exact-tag Docker
images from the canonical `sui-devstack` project at
`~/Projects/sui-devstack/master` (`github.com/tedks/sui-devstack`), then uses
the Sui CLI pinned by `flake.nix` for host-side client commands. It does not
read or write the user's default `~/.sui` config.

## Commands

Run commands through Nix:

```bash
nix develop --command pnpm devstack:up
nix develop --command pnpm devstack:status
nix develop --command pnpm devstack:env
nix develop --command pnpm devstack:down
```

`devstack:up` starts Sui Localnet, creates an isolated local deployer, funds it
from the local faucet, and writes `.devstack/pairmarket-local.env`.

The default endpoints are:

| Endpoint | URL |
| --- | --- |
| Sui JSON-RPC | `http://127.0.0.1:9000` |
| Sui faucet | `http://127.0.0.1:9123/gas` |

The generated env file contains:

```bash
PAIRMARKET_NETWORK=localnet
PAIRMARKET_SUI_RPC_URL=http://127.0.0.1:9000
PAIRMARKET_SUI_FAUCET_URL=http://127.0.0.1:9123/gas
PAIRMARKET_SUI_CLIENT_CONFIG=.devstack/sui-client/client.yaml
PAIRMARKET_SUI_DEPLOYER_ADDRESS=...
PAIRMARKET_MOVE_PACKAGE_ID=...
PAIRMARKET_WALRUS_MODE=not-yet-local
PAIRMARKET_SEAL_MODE=not-yet-local
```

Use `devstack:reset` when you want a clean chain and a fresh package publish:

```bash
nix develop --command pnpm devstack:reset
nix develop --command pnpm devstack:up
```

Override ports when another localnet is already running:

```bash
SUI_RPC_PORT=9100 SUI_FAUCET_PORT=9223 nix develop --command pnpm devstack:up
```

The default backend is Docker because `sui start` currently raises `SIGILL` on
this host even though `sui move build/test` works. To force the native CLI
backend on a host where `sui start` works:

```bash
PAIRMARKET_DEVSTACK_BACKEND=native nix develop --command pnpm devstack:up
```

## What This Tests

This stack exercises the real Move package against a real local Sui validator
and faucet once the package can be published on the localnet runtime. It is the
right place for:

- package publish smoke tests,
- transaction-builder integration tests,
- wallet signing-policy dry runs against local objects,
- lifecycle tests that need object IDs from a live chain rather than the Move
  unit-test VM.

## Current Limits

The current Docker localnet image is Sui `1.67.3`, while the canonical repo
toolchain is Sui `mainnet-v1.73.2`. A minimal package publishes to the Docker
localnet, but the current pairmarket package fails VM verification there. The
native `sui start` path for the pinned `1.73.2` CLI raises `SIGILL` on this
host. Until a compatible localnet binary/image is available, use:

- `nix develop --command pnpm verify` for canonical package build and Move unit
  tests,
- `nix develop --command pnpm devstack:up` for a live local Sui RPC/faucet and
  wallet/client integration not tied to the pairmarket package ID,
- `nix develop --command pnpm devstack:deploy` only on a compatible localnet.

Walrus and SEAL are not local in this stack yet. The repo currently has typed
IDs, privacy envelopes, and ADRs for their boundaries, but no Walrus envelope
writer, SEAL policy module, or service integration to run. Until those land,
local privacy tests should assert ciphertext/envelope construction in process
and use Sui Localnet for the on-chain object/policy references only.

The canonical `sui-devstack` repo already provides `sui-devstack/seal` and
`sui-devstack/walrus` images. Pairmarket should add those services here once
there is pairmarket code to configure policies, write envelopes, and assert
access-control behavior against them. Starting them earlier would mostly test
that the generic containers boot, not that pairmarket privacy works.

Add the Walrus/SEAL layer once `pm-privacy-policy-model`,
`pm-privacy-key-server-set`, and the envelope implementation are ready. Do not
replace that with a mock that claims to validate SEAL access control; a mock can
only test caller behavior around expected responses.
