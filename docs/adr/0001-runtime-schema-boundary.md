# ADR 0001: Defer Runtime Schema Library, Keep Parser Boundary Stable

Status: accepted for the initial `packages/core` branch

Date: 2026-06-27

## Context

`docs/design.md` requires strict TypeScript with branded primitives. Brands
must be minted only at trust boundaries after validation. The design leaves the
runtime schema library open between zod, io-ts, and valibot in
`pm-types-runtime-schema-choice`.

This branch does not have the final workspace scaffold, package manager, test
runner, or browser bundle constraints. Choosing a schema dependency before
those constraints are pinned would force the scaffold branch to either inherit
that dependency or unwind it.

## Decision

Do not select a runtime schema library in this branch.

Define dependency-free parser functions for the first primitive values and
export a minimal `Schema<T>` adapter shape from `packages/core/src/validation.ts`.
Consumers call `parse*` or `tryParse*` functions today. A future zod, io-ts, or
valibot adapter can satisfy `Schema<T>` without changing the branded primitive
call sites. `tryParse*` catches only `ParseError`; unexpected exceptions are
programmer bugs and should not be counted as user input rejection.

## Consequences

The first package API is usable for IDs, custody handles, encrypted blob types,
capabilities, and transaction intents without adding external dependencies.

The unresolved library choice remains explicitly tracked by
`pm-types-runtime-schema-choice`. That issue should be closed only after the
scaffold can compare brand inference, HTTP-friendly error shapes, tree-shaking,
and build compatibility.
