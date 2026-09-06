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
- exporting the resulting Move package and shared Config IDs for app and
  integration tests.

## Upstream Contract

The wrapper expects a `sui-devstack` checkout that provides:

```text
localnet/sui-localnet.sh
localnet/docker-compose.sui-localnet.yml
```

`localnet/sui-localnet.sh` is the stable command surface. Pairmarket calls its
`up`, `down`, `reset`, `purge`, `status`, `logs`, and `env` commands instead
of vendoring those behaviors.

By default the wrapper looks only for the `master` checkout of sui-devstack:
the sibling project next to this bare repo (`../../sui-devstack/master`
relative to this checkout, so `~/Projects/pairmarket/<worktree>` finds
`~/Projects/sui-devstack/master`) first, then `~/Projects/sui-devstack/master`. Branch worktrees are
never picked up implicitly; a stale one once ran an old wrapper on tower0 for
months. To use a different checkout or branch, point at it explicitly:

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
Pairmarket chooses free host ports when no explicit port override is present,
then stores them in `.devstack/ports.env` so `deploy`, `status`, and web env
generation keep talking to the same localnet. Generated ports come from
`20000-29999` by default to stay out of the common Sui defaults and the usual
Linux ephemeral port range.

## Commands

Run commands through Nix:

```bash
nix develop --command pnpm devstack:up
nix develop --command pnpm devstack:status
nix develop --command pnpm devstack:env
nix develop --command pnpm devstack:down
```

`devstack:up` starts upstream Sui Localnet, creates and funds a pairmarket
deployer, and writes `.devstack/pairmarket-local.env` plus
`apps/web/.env.local`.

The generated env file contains pairmarket-prefixed app configuration:

```bash
PAIRMARKET_NETWORK=localnet
PAIRMARKET_SUI_RPC_URL=http://127.0.0.1:<generated-rpc-port>
PAIRMARKET_SUI_FAUCET_URL=http://127.0.0.1:<generated-faucet-port>/gas
PAIRMARKET_SUI_GRAPHQL_URL=http://127.0.0.1:<generated-graphql-port>/graphql
PAIRMARKET_SUI_CLIENT_CONFIG=/absolute/path/to/.devstack/sui-client/client.yaml
PAIRMARKET_SUI_DEPLOYER_ADDRESS=...
PAIRMARKET_MOVE_PACKAGE_ID=...
PAIRMARKET_MOVE_CONFIG_ID=...
PAIRMARKET_MOVE_ADMIN_CAP_ID=...
PAIRMARKET_WALRUS_MODE=not-yet-local
PAIRMARKET_SEAL_MODE=not-yet-local
```

The generated web env points browser RPC/faucet traffic at Vite proxy paths so
remote browsers can use an app served from another host:

```bash
VITE_PAIRMARKET_NETWORK=localnet
VITE_PAIRMARKET_SUI_RPC_URL=/sui-rpc
VITE_PAIRMARKET_SUI_FAUCET_URL=/sui-faucet
VITE_PAIRMARKET_DEVSTACK_RPC_TARGET=http://127.0.0.1:<generated-rpc-port>
VITE_PAIRMARKET_DEVSTACK_FAUCET_TARGET=http://127.0.0.1:<generated-faucet-port>/gas
VITE_PAIRMARKET_MOVE_PACKAGE_ID=...
VITE_PAIRMARKET_MOVE_CONFIG_ID=...
VITE_PAIRMARKET_ENABLE_BURNER=0
```

## Teardown

Three commands take the devstack down. They differ in what survives:

| Command          | Sui containers | Current chain state + logs | Published IDs, env files | Deployer key, ports | `.devstack/` itself (incl. stale layouts) |
|------------------|----------------|----------------------------|--------------------------|---------------------|-------------------------------------------|
| `devstack:down`  | stopped        | kept                       | kept                     | kept                | kept                                      |
| `devstack:reset` | removed        | removed                    | removed                  | kept                | kept                                      |
| `devstack:purge` | removed        | removed                    | removed                  | removed             | removed                                   |

`reset` only knows the current layout (`.devstack/sui-localnet/{state,logs}`);
anything left under an older layout survives it. `purge` removes the whole
configured state root (default `.devstack/`).

`devstack:down` is for coming back to the same chain: `devstack:up` resumes
it and the published package is still there. It frees nothing on disk.

`devstack:reset` is for starting over on a fresh chain. Upstream
`sui-devstack` removes the Sui Localnet containers, the project-scoped
postgres volume, and the state and logs directories; pairmarket then removes
the package/config/admin-cap IDs, `Published.localnet.toml`, the publish
output and workdir, and both generated env files, because they all name
objects on a chain that no longer exists. The deployer key under
`.devstack/sui-client/` and the generated ports in `.devstack/ports.env` are
kept: the next `devstack:up` funds the same address from the fresh faucet and
binds the same ports, and `devstack:deploy` publishes a new package.

```bash
nix develop --command pnpm devstack:reset
nix develop --command pnpm devstack:up
nix develop --command pnpm devstack:deploy
```

`devstack:purge` is for being done with this worktree's devstack. It hands
the configured state root (default `.devstack/`) to upstream `purge`, which
removes it with the same root-owned-safe helper it uses for the chain state
(a plain `rm` first, then a throwaway alpine container for anything the Sui
container left owned by root), including stale state under older layouts
that `reset` does not know about. Then it removes `apps/web/.env.local`.
Nothing in either survives. A state root at a different
`PAIRMARKET_DEVSTACK_DIR` from an earlier session is a separate tree; purge
it with that variable set.

```bash
nix develop --command pnpm devstack:purge
```

A downed devstack still holds gigabytes of RocksDB chain state under
`.devstack/sui-localnet/state`, and nothing reclaims it for you. Purge when
you are done; the devstack section of `AGENTS.md` says when.

`devstack:purge` needs a sui-devstack checkout whose `sui-localnet.sh` has
the `purge` command (master with sui-devstack PR #4). An older checkout fails
with a pointer and removes nothing.

Because `reset` and `purge` delete things, and `purge` hands a whole tree
to upstream (which may finish the job as root), every deletion target is
pinned before any destructive upstream command runs (the harmless
`--help` probe of the upstream script comes first): `PAIRMARKET_DEVSTACK_DIR`,
`PAIRMARKET_WEB_ENV_FILE`, and any `SUI_DEVSTACK_STATE_DIR` /
`SUI_DEVSTACK_LOGS_DIR` you exported are each resolved to an absolute
canonical path (a relative value is taken against your current directory,
and a path that does not exist yet is fine), their final component must not
be a symlink, an existing state or upstream directory must be a directory
and an existing web env file a regular file, and the result must lie
strictly inside this checkout. Location is not enough: the state root must
be, or lie under, a directory named `.devstack*`; an exported
`SUI_DEVSTACK_STATE_DIR` / `SUI_DEVSTACK_LOGS_DIR` must lie strictly inside
the state root and outside `sui-client/`; and the web env file may not name
anything `reset` keeps (the keystore directory, `ports.env`,
`compose-project`). A value containing a newline is refused outright. The
canonical path is what gets deleted and what upstream receives, whichever
directory you ran the command from (`reset` and `purge` both run upstream
from the checkout root). Anything else is refused with nothing removed;
clean up external state yourself. One exception is gentle rather than a
refusal: a symlinked `apps/web/.env.local` is not followed, so neither the
link nor its target is removed on its account (either may still go if it
sits inside a directory being removed, such as the state root); a note is
printed, and teardown proceeds. `reset`, `purge`, `up`, `down`,
`status`, `deploy` and `env` take no arguments and exit 2 if given any, so
`purge --help` cannot purge.

The compose project name defaults to `pairmarket-devstack` in the `master`
(or `main`) worktree and `pairmarket-devstack-<name>-<hash>` elsewhere:
the worktree directory name with the `pairmarket-` prefix dropped, plus the
first six hex digits of a SHA-256 of the canonical checkout path, so two
worktrees, or two clones with the same directory name, never share a project
or a `pgdata` volume, and one checkout's `down`/`reset`/`purge` cannot tear
down another's. `devstack:up` records the name it used in
`.devstack/compose-project`; every other command reads it back, so a moved
worktree or a later change to this rule cannot orphan a running stack.
`SUI_DEVSTACK_COMPOSE_PROJECT` overrides both, and `devstack:status` prints
the name in use. Stacks started before this rule live under
`pairmarket-devstack` and are reachable from `master` or with the override.

Override ports with the upstream variables:

```bash
SUI_DEVSTACK_RPC_PORT=9100 SUI_DEVSTACK_FAUCET_PORT=9223 \
  SUI_DEVSTACK_GRAPHQL_PORT=9225 \
  nix develop --command pnpm devstack:up
```

Override the generated-port range with pairmarket wrapper variables:

```bash
PAIRMARKET_DEVSTACK_PORT_RANGE_START=20000 \
PAIRMARKET_DEVSTACK_PORT_RANGE_END=29999 \
  nix develop --command pnpm devstack:up
```

The chosen or overridden ports are persisted here:

```text
.devstack/ports.env
```

`devstack:up` preflights the selected host ports before asking Docker Compose
to bind them. If a port is already occupied by another local stack, the command
fails with the selected RPC/faucet/GraphQL ports instead of starting a half
configured stack. `devstack:reset` keeps the persisted ports (unless you
override them in the environment, which `up`, and any other command run
while `.devstack/` exists, writes back to `ports.env`; `purge` touches no
ports); delete `.devstack/ports.env` (or run `devstack:purge`) to choose a
fresh set. Only `devstack:up` creates `.devstack/`; after a purge, `status`
and `down` leave it gone. `devstack:up` records the compose project only
after upstream has started the stack, so a failed preflight or a failed
upstream start cannot re-point the record away from a stack still running
under the previous name (a half-started stack under an override is still
reachable with that override set).

## Package Publish

Pairmarket package publish is intentionally app-specific:

```bash
nix develop --command pnpm devstack:deploy
```

On success, the wrapper writes:

```text
.devstack/package-id.txt
.devstack/config-id.txt
.devstack/admin-cap-id.txt
.devstack/Published.localnet.toml
.devstack/publish-output.json
```

and updates the Move IDs in `.devstack/pairmarket-local.env` and
`apps/web/.env.local`.

## Current Limits

The canonical repo toolchain is Sui `mainnet-v1.73.2`. Pairmarket publish
requires an upstream `sui-devstack` image built from the same Sui tag, such as
`sui-devstack/sui-localnet:1.73.2-r1`. If your upstream checkout still points at
`1.67.3-r1`, `devstack:deploy` is expected to fail package verification.

Use:

- `nix develop --command pnpm verify` for canonical package build and Move unit
  tests,
- `nix develop --command pnpm devstack:up` for live local RPC/faucet/client
  integration,
- `nix develop --command pnpm devstack:deploy` against a Sui
  `mainnet-v1.73.2` localnet runtime before exercising the web app.
- `nix develop --command pnpm test:localnet` after deploy for the generated-key
  wallet integration test that creates, consents, invites, wagers, attests,
  finalizes, and claims real localnet objects.

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
