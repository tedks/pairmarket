# Local Devstack

Pairmarket's local devstack is a thin consumer of the canonical
`sui-devstack` Sui localnet contract. Pairmarket does not own Docker Compose
topology, container lifecycle, reset behavior, or log streaming here; those
belong in `github.com/tedks/sui-devstack`.

This repo owns only the pairmarket layer:

- creating an isolated local deployer Sui client,
- funding that deployer from the local faucet,
- writing `.devstack/pairmarket-local.env`,
- publishing `contracts/pairmarket` when the localnet runtime is compatible,
- exporting the resulting Move package ID for app and integration tests.

## Upstream Contract

The wrapper expects a `sui-devstack` checkout that provides:

```text
localnet/sui-localnet.sh
localnet/docker-compose.sui-localnet.yml
```

`localnet/sui-localnet.sh` is the stable command surface. Pairmarket calls its
`up`, `down`, `reset`, `status`, `logs`, and `env` commands instead of
vendoring those behaviors.

By default the wrapper searches for a sibling worktree at
`~/Projects/sui-devstack/master`. To use a different checkout or branch, point
at it explicitly:

```bash
SUI_DEVSTACK_HOME=~/Projects/sui-devstack/master \
  nix develop --command pnpm devstack:up
```

The upstream `env` command must emit:

```bash
SUI_RPC_URL=http://127.0.0.1:9000
SUI_FAUCET_URL=http://127.0.0.1:9123/gas
SUI_GRAPHQL_URL=http://127.0.0.1:9125/graphql
```

Additional `SUI_DEVSTACK_*` keys are allowed and stay owned by `sui-devstack`.

## Commands

Run commands through Nix:

```bash
nix develop --command pnpm devstack:up
nix develop --command pnpm devstack:status
nix develop --command pnpm devstack:env
nix develop --command pnpm devstack:down
```

`devstack:up` starts upstream Sui Localnet, creates and funds a pairmarket
deployer, and writes `.devstack/pairmarket-local.env`.

The generated env file contains pairmarket-prefixed app configuration:

```bash
PAIRMARKET_NETWORK=localnet
PAIRMARKET_SUI_RPC_URL=http://127.0.0.1:9000
PAIRMARKET_SUI_FAUCET_URL=http://127.0.0.1:9123/gas
PAIRMARKET_SUI_GRAPHQL_URL=http://127.0.0.1:9125/graphql
PAIRMARKET_SUI_CLIENT_CONFIG=/absolute/path/to/.devstack/sui-client/client.yaml
PAIRMARKET_SUI_DEPLOYER_ADDRESS=...
PAIRMARKET_MOVE_PACKAGE_ID=...
PAIRMARKET_WALRUS_MODE=not-yet-local
PAIRMARKET_SEAL_MODE=not-yet-local
```

Use `devstack:reset` when you want a clean chain, deployer, and package
publish output. Upstream `sui-devstack` owns the Sui Localnet container,
project-scoped postgres volume, state directory, and logs directory cleanup;
pairmarket removes only its deployer and package-publish artifacts.

```bash
nix develop --command pnpm devstack:reset
nix develop --command pnpm devstack:up
```

Override ports with the upstream variables:

```bash
SUI_DEVSTACK_RPC_PORT=9100 SUI_DEVSTACK_FAUCET_PORT=9223 \
  SUI_DEVSTACK_GRAPHQL_PORT=9225 \
  nix develop --command pnpm devstack:up
```

## Package Publish

Pairmarket package publish is intentionally app-specific:

```bash
nix develop --command pnpm devstack:deploy
```

On success, the wrapper writes:

```text
.devstack/package-id.txt
.devstack/Published.localnet.toml
.devstack/publish-output.json
```

and updates `PAIRMARKET_MOVE_PACKAGE_ID` in
`.devstack/pairmarket-local.env`.

## Current Limits

The canonical repo toolchain is Sui `mainnet-v1.73.2`. The currently available
`sui-devstack/sui-localnet:1.67.3-r1` image is useful for wallet/client/RPC
smoke tests, but it is not a Sui 1.73-compatible publish target for the current
pairmarket package. Until `pm-local-devstack-sui-173-runtime` lands, use:

- `nix develop --command pnpm verify` for canonical package build and Move unit
  tests,
- `nix develop --command pnpm devstack:up` for live local RPC/faucet/client
  integration,
- `nix develop --command pnpm devstack:deploy` only against a localnet runtime
  compatible with Sui `mainnet-v1.73.2`.

Walrus and SEAL are not local in this pairmarket wrapper yet. The repo has
typed IDs, privacy envelopes, and ADRs for their boundaries, but no Walrus
envelope writer, SEAL policy module, or service integration to run. Until those
land, local privacy tests should assert ciphertext/envelope construction in
process and use Sui Localnet only for on-chain object and policy references.

Add Walrus/SEAL services through the upstream `sui-devstack` contract once
`pm-privacy-policy-model`, `pm-privacy-key-server-set`, and the envelope
implementation are ready. Do not replace that with a mock that claims to
validate SEAL access control; a mock can only test caller behavior around
expected responses.

## PR Base

This branch replaces PR #6 rather than stacking a cleanup on top of it. PR #6
proved the local Sui flow, but it kept generic localnet orchestration in
pairmarket. The replacement PR should target `master` and supersede PR #6 with
this thin wrapper once the upstream `sui-devstack` consumer contract is
available.
