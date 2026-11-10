# Bazel entry point

The Bazel workspace provides a hermetic check of the shared TypeScript core.
It does not start the web app, API, wallet service, Sui localnet, or any live
service. `nix develop` supplies Bazel 8, Node.js 24, and the existing Phase 0
tools; Bazel resolves TypeScript and JavaScript dependencies from the committed
pnpm lockfile.

From the repository root, run:

    nix develop --command bazel test //:verify_core

This runs three checks: `//packages/core:core_typecheck_test` and the two
runtime tests whose source files live under `packages/core/test`. The
typecheck target includes the
core source files plus the compile-time invariant fixtures. Its BUILD rule is a
`ts_project(no_emit = True)`; rules_ts exposes the compiler action through the
`typecheck` output group and generates `core_typecheck_test` to depend on that
group. This is deliberate: building the default output of a transpiler-backed
`ts_project` can skip typechecking, and a test that only builds that default
output would not catch type errors.

The source lists in `packages/core/BUILD.bazel` are explicit. When a core
source or type fixture is added, update the target's source list in the same
change. The runtime tests load the actual TypeScript modules from runfiles via
the pinned `tsx` loader; they check identifier normalization and that
`Plaintext` values do not expose their wrapped value through ordinary object
serialization.

The `//packages/core` package defaults to private visibility. Its tested
source filegroup and targets grant only the visibility needed by the root
verification suite. The test directory remains in the same Bazel package so
the compile-time fixtures and runtime tests share the core source closure. This
keeps the onboarding from claiming a stable public Bazel API for services or
the web app before their dependency boundaries are migrated.
