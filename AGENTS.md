# Agent Instructions: pairmarket

Prediction markets on relationship outcomes — friends invite each other to
private markets on whether two people would last N dates (or some other
operationalization), settled on Sui. Walrus stores private content, SEAL
gates access, and Twitter sign-in mints a custodial wallet so the
relationship-curious can play without learning what a seed phrase is.

The current goal: produce a Google-tier design doc, then build it.
**Read [.planning/BRIEF.md](.planning/BRIEF.md) before doing anything else.**

## Scope of this file

Global workflow rules live in `~/.claude/CLAUDE.md` (installed from the
dotfiles repo) and apply to every project: landing the plane (session
completion and mandatory push), branch + draft-PR discipline, granular
commits, stacked PRs, the bare-repo/worktree layout, and Nix/Bazel
environment detection. **Do not restate them here.** This file covers only
what is specific to pairmarket.

`AGENTS.md` is the canonical instruction file. Keep `CLAUDE.md` (and
`GEMINI.md`, `COPILOT.md` if present) as symlinks to it unless a specific
agent genuinely needs divergent instructions.

## Project structure

Currently a skeleton. The first design doc decides the real layout
(typically: `contracts/` for Sui Move, an app surface for the typed
frontend/backend, `docs/` for design docs, `.planning/` for ExecPlans).

## Environment

The repo has a Nix flake for Phase 0 tooling. Run project tooling through it:

```bash
nix develop --command <cmd>
```

Phase 0 currently supports `x86_64-linux` only. The flake packages the Sui
`mainnet-v1.73.2` Ubuntu x86_64 release used by CI; add platform-specific Sui
tarballs before relying on `nix develop` on macOS or aarch64 machines.

The flake supplies Node.js 24 and invokes pnpm through Corepack so the
`packageManager` pin (`pnpm@11.9.0`) is honored. The first pnpm invocation may
download that pinned pnpm release into the Corepack cache.

## Build and test

Install workspace dependencies:

```bash
nix develop --command pnpm install --frozen-lockfile
```

Run all Phase 0 gates:

```bash
nix develop --command pnpm verify
```

Individual gates:

```bash
nix develop --command pnpm fmt:check
nix develop --command pnpm typecheck
nix develop --command pnpm docs:lint
nix develop --command pnpm move:build
nix develop --command pnpm move:test
```

The Move gates use Sui `--build-env mainnet`, matching the Phase 0 mainnet
toolchain pin in `docs/design.md`.

## Issue tracking (ditz, not beads)

This repo uses [ditz](https://github.com/tedks/ditz) for distributed issue
tracking — not beads. Ditz keeps issue files in-tree under `bugs/` (or a
configurable path), so issues travel with branches and merge like code.
The user's fork lives at `~/Projects/ditz/master`; invoke via the local
worktree until a published binary is available.

Bootstrap once:

```bash
cd ~/Projects/pairmarket/master
nix --extra-experimental-features 'nix-command flakes' \
    run ~/Projects/ditz/master#ditz -- init
```

Then `ditz add`, `ditz todo`, `ditz show <id>`, `ditz close <id>`, etc.

## Planning

ExecPlans for non-trivial work follow the format in
[.planning/PLANS.md](.planning/PLANS.md).

## Repo specifics

- **Privacy is load-bearing.** Markets are *private* by invitation. SEAL
  access control and Walrus blob ACLs are not optional polish — they are
  the product. Type-system invariants enforced at compile time are
  strongly preferred to runtime checks for anything touching access.
- **Custodial wallet via Twitter sign-in.** The signing key is held by
  the backend on the user's behalf; design for the eventual migration
  path to user-held keys (zkLogin or equivalent) from day one.
- **Stack choice is open.** TypeScript with brand-typed primitives or
  an ML-family language (OCaml, Rescript, Reason) where types can carry
  invariants — pick in the design doc with explicit tradeoffs, not by
  default.

## Devstack lifecycle and cleanup

`scripts/devstack.sh` (via `pnpm devstack:*`) has three teardown verbs that
differ in what survives; see [docs/devstack.md](docs/devstack.md#teardown).

- `down` keeps everything. `up` resumes the same chain and published
  package. Use it between sessions on the same task.
- `reset` starts over on a fresh chain: chain state, logs, publish output
  and generated env files go; the deployer key and generated ports stay.
- `purge` removes the configured state root (default `.devstack/`) and
  `apps/web/.env.local`. Nothing in them survives.

A downed devstack still holds gigabytes of RocksDB chain state, and nothing
reclaims it for you: tower0 ran out of disk on 2026-09-03 on devstacks that
had been downed and forgotten. So:

- **Purge when you are done.** When the task you were spawned for no longer
  needs the devstack, run `pnpm devstack:purge` before landing the plane.
  Default to `purge`, not `down`.
- **Leave a stack behind only on purpose.** Do it when the operator asked
  for it or the next session clearly needs the same chain, and say so in
  the hand-off: worktree path, compose project, and that it is waiting to
  be purged.
- **Purge before removing a worktree.** Removing the directory does not
  stop the containers or free the chain state they wrote.
- Each checkout gets its own compose project by default
  (`pairmarket-devstack` in `master`, `pairmarket-devstack-<name>-<hash>`
  elsewhere, recorded in `.devstack/compose-project` by `up`), so
  teardown in one worktree does not touch another's stack.
  `pnpm devstack:status` prints the name; put it in the hand-off when you
  leave a stack behind. Do not set `SUI_DEVSTACK_COMPOSE_PROJECT` to a
  shared name unless you mean to share the stack.

<!-- ditz:onboard -->
## Issue tracking with ditz

This project uses `ditz` (not beads). Issues are plain-text YAML on the
`ditz-metadata` git branch; the `ditz` CLI reads and writes them.

The loop:
- `ditz ready` - what to work on now (unblocked, ranked by how much each unblocks)
- `ditz start <id>` - mark in progress
- `ditz close <id> --reason "..."` - close with why (or `--wontfix` / `--reorg`)
- `ditz reopen <id>` - revive a closed issue

Create / inspect:
- `ditz add "title" -t bugfix|feature|task -c <component> --desc "..."`
- `ditz show <id>` - `ditz list --status unstarted|in_progress|paused|closed` - `ditz search <q>`
- `--json` on any command for machine output; `--ids-only` for just ids
- ids: copy them from output; a unique prefix works (like git hashes);
  `--id <name>` sets a deterministic id (re-creating with it is idempotent)

Structure (there are no priority / epic / parent fields - urgency is derived,
hierarchy is expressed in the graph):
- grouping: `-c <component>` + `ditz list --component <c>`
- sequencing: `ditz blocks <a> <b>` (a blocks b); an "epic" is just an issue
  blocked by its members - it stays out of `ready` until they close
- `ditz deps <id>` shows the dependency tree; `ditz deps --check` validates it

Sync: `ditz sync` fetches/merges/pushes the metadata branch. See FORMAT.md for
the file format and git model.

<!-- /ditz:onboard -->
