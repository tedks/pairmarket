# @pairmarket/core

Shared TypeScript primitives for pairmarket app, backend, wallet, Walrus, SEAL,
and Sui integration code.

This package intentionally starts as source-only. The repository scaffold will
wire it into the workspace, dependency manager, and CI. Until then, do not add
root package-manager files from this branch.

## Layout

- `src/brand.ts` defines the nominal `Brand<T, Name>` helper.
- `src/validation.ts` defines dependency-free parser result and error helpers.
- `src/ids.ts` defines the first branded ID parsers.
- `src/privacy.ts` defines encrypted/plaintext phantom types and policy-bound
  blob handles.
- `src/capabilities.ts`, `src/custody.ts`, and `src/tx.ts` define branded
  app-layer handles used by later services.
- `test/ids.types.ts` is a compile-only type smoke test intended to be checked
  with `tsc --noEmit` after the scaffold provides TypeScript.

`parse*` functions throw `ParseError`. `tryParse*` functions return
`ParseResult<T>` for caller-controlled boundary parsing. `ParseError` stores a
redacted input summary, not the raw rejected input.

Capability brands in this package are type-level handles. They prevent honest
app code from mixing authorization facts, but runtime authority still lives in
Move objects, wallet-service policy checks, and SEAL policy evaluation.

## Runtime Schema Decision

No runtime schema library is selected in this package yet. The current source
uses small parser functions for the first primitive types and exposes
`Schema<T>` as a minimal adapter shape. That keeps callers stable while the
scaffold branch decides the package manager, bundle constraints, and test
runner.

The choice tracked by `pm-types-runtime-schema-choice` should compare zod,
io-ts, and valibot against:

- whether inferred output types preserve brands without unsafe caller casts,
- structured error shape for HTTP responses and audit logs,
- tree-shaking and browser bundle cost,
- compatibility with strict TypeScript and the final build pipeline.

Until that decision lands, new brands must be minted only inside `parse*` or
`verify*` functions in this package.
