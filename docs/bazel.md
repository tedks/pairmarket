# Bazel entry point

The Bazel workspace provides a bounded check of the shared TypeScript core.
It does not start the web app, API, wallet service, Sui localnet, or any live
service. `nix develop .#bazel` supplies Bazel 8.7.0 and buildifier without the
Sui Phase 0 shell or its Corepack startup hook. Bazel pins its own Node.js 24
toolchain and resolves TypeScript and JavaScript dependencies from the committed
pnpm lockfile.
The pinned `rules_nodejs` release includes the Linux Node 24.15.0 archive
mapping used by this slice.

From the repository root, run:

    nix develop .#bazel --command bazel test //:verify_core

This runs three tests directly from the bounded `@pairmarket_src` repository:
`@pairmarket_src//packages/core:core_typecheck_test` and the two runtime
tests whose source files live under `packages/core/test`. Bazel test suites
require test rules rather than aliases. The root package's local aliases can
be built, but `bazel test` does not execute them; use the external test labels
for individual test execution. The
typecheck target includes the core source files plus the compile-time invariant
fixtures. Its BUILD rule is a `ts_project(no_emit = True)` using the repository's
strict NodeNext `tsconfig.base.json`. An explicit `core_typecheck` filegroup
selects the `typecheck` output group, and the shell test has that filegroup as a
data dependency. This is deliberate: building
the default output of a transpiler-backed `ts_project` can skip typechecking,
and a test that only builds that default output would not catch type errors.

`build_defs/pairmarket_source.bzl` creates a bounded Bazel source view with the
root package metadata and the selected core source and test files. It
adds `onlyBuiltDependencies: []` only to the generated workspace view because
rules_js 2.9.2 requires that legacy key to be present in the pnpm 9+ lockfile
metadata. The committed `pnpm-workspace.yaml` remains unchanged; native pnpm
continues to use its `allowBuilds` policy. The repository rule checks the
discovered TypeScript and runtime-test inventory against the explicit lists in
`build_defs/pairmarket_source.bzl` and generates `inventory.bzl` for the
overlay BUILD targets. Update those lists when a core source or test fixture
is added. The strict NodeNext typecheck also declares the core `package.json`
so TypeScript sees its `"type": "module"` setting. The
runtime tests load the selected TypeScript modules via the pinned
`tsx` loader; they check identifier normalization and that `Plaintext` values do
not expose their wrapped value through ordinary object serialization.

The NPM translation checks `verify_node_modules_ignored` against `.bazelignore`.
Every pnpm importer has an explicit ignored `node_modules` path, and
`.gitignore` covers the root install directory and Bazel output symlinks. The
Aspect telemetry module is patched to report no collectors; `.bazelrc` also
sets its opt-out environment flags for any remaining clients.

The `//packages/core` package defaults to private visibility. Its aliases expose
only the selected typecheck and runtime test targets. This keeps the onboarding
from claiming a stable public Bazel API for services or the web app before their
dependency boundaries are migrated.

On a host without Bazel's `linux-sandbox`, `processwrapper-sandbox` can check
the selected sources but cannot enforce network isolation. A pass on that
strategy is diagnostic local evidence, not an offline or remote qualification.
