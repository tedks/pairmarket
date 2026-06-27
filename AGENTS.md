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

No flake yet — the design doc must specify the dev toolchain (Sui CLI
version, Move framework, frontend stack) before any scaffolding is
committed. Once a flake exists, run all tooling through it:

```bash
nix develop --command <cmd>
```

## Build and test

Not yet defined. Each component PR must add its own quality gates and
document the exact commands here once they exist.

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
