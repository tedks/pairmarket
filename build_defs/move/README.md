# Offline Sui Move rules for Bazel

Small Bazel rules that compile a Sui Move package and run its Move unit tests
without network access, with the same Sui CLI release a project already pins.

This directory is kept as an exact copy wherever it is used. `MANIFEST.sha256`
lists the SHA-256 of every other file here, and the `:copy_test` target checks
the files against it, so a local edit to a copy fails that repository's tests.
Change the canonical copy, regenerate the manifest, then copy the whole
directory (including the manifest) into each consumer.

```bash
ls | grep -vx MANIFEST.sha256 | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256
```

## Use

In `MODULE.bazel` (Bazel 7.6 or 8; `platforms` must be a direct dependency):

```starlark
bazel_dep(name = "platforms", version = "1.0.0")

sui_release = use_repo_rule("//path/to/move:repositories.bzl", "sui_release")
move_git_dependency = use_repo_rule("//path/to/move:repositories.bzl", "move_git_dependency")
move_host_git = use_repo_rule("//path/to/move:repositories.bzl", "move_host_git")

move_host_git(name = "move_host_git")

sui_release(
    name = "sui_cli",
    archives = {"linux-x86_64": ["<release .tgz URL>", "sha256-<SRI>"]},
    version = "1.80.1",
)

# One per git source (remote + rev) in Move.lock, with the subdirectories used.
move_git_dependency(
    name = "move_sui_<rev>",
    commit = "<full rev from Move.lock>",
    paths = ["crates/sui-framework/packages/move-stdlib", "crates/sui-framework/packages/sui-framework"],
    remote = "https://github.com/MystenLabs/sui.git",
)
```

In the package's `BUILD.bazel`:

```starlark
load("//path/to/move:defs.bzl", "move_package", "move_test", "sui_pin_test")

move_package(  # outputs <name>/bytecode_modules/*.mv (+ dependencies/)
    name = "pkg",
    srcs = ["Move.toml", "Move.lock"] + glob(["sources/**", "tests/**"]),
    git = "@move_host_git//:git",
    sui = "@sui_cli//:sui",
    deps = ["@move_sui_<rev>//:cache.tar"],
)

move_test(name = "move_test", ...same attributes...)

sui_pin_test(  # the release pins must also appear in, e.g., flake.nix
    name = "sui_pin_test",
    files = ["//:flake.nix"],
    pins = "@sui_cli//:pins.txt",
)
```

`srcs` must contain every file the package reads, including `local`
dependency packages; they are staged at their workspace paths.

## Behavior and limits

- Actions copy `srcs` into a private directory, set a fresh `MOVE_HOME` from
  the `deps` archives and a keyless client configuration, point the CLI's RPC
  endpoints at a closed loopback port, and refuse every git transport. A
  missing dependency fails; nothing is fetched by git.
- Those measures stop git and chain RPC from reaching the network. Blocking
  every other connection relies on Bazel's sandbox: the targets request
  `block-network`, which the Linux sandbox enforces. With
  `--spawn_strategy=local` (or another unsandboxed strategy) that tag does
  nothing, and "offline" means only the guarantees above.
- `srcs` must include `Move.lock`, and a lock that is stale for the pinned CLI
  fails, even when the CLI could re-resolve it from cached sources: the
  committed lock is the pin. In test mode staleness is detected from the CLI's
  "Updating dependencies" notice, which the parent tests pin for the CLI they
  run; consumers on another CLI version should confirm it once.
- `move_test` fails when the CLI fails or reports zero tests.
- The build output contains bytecode only; the CLI's `BuildInfo.yaml`, debug
  info and source maps embed an absolute scratch path and are omitted.
- `sui_pin_test` is a presence check: each pinned value must appear somewhere
  in the listed files. A stale copy of a value left elsewhere in those files
  would still satisfy it.
- `cache.tar` holds a git checkout. Its content is fixed by the commit, but
  its bytes (git index stat data, pack layout) can differ between fetches, so
  action cache entries are not shared across hosts or refetches.
- Actions use Bazel's default shell environment for `PATH` (bash, coreutils,
  tar). Set `--incompatible_strict_action_env` to keep host `PATH` changes out
  of action keys.
- Host requirements: Linux, bash, coreutils, tar, and git (for fetching
  dependencies and because the CLI drives git for its cache).
- `sui_release` fetches the archive for the host platform only. A host with no
  listed archive downloads no Sui binary, and the targets that need it are
  skipped as incompatible. On a platform the rules do not support (anything
  but Linux x86_64 or aarch64) the dependency and git repositories are
  incompatible stubs too and nothing is fetched; on a supported platform
  whose release has no listed archive, the small git dependency fetches still
  run when those targets are loaded. A supported host missing git or tar
  fails instead of skipping, so a misconfigured machine cannot hide the
  tests. `move_test` takes its tools in the target configuration, so it is
  also skipped when `--platforms` names an unsupported target. Remote
  execution on another platform is not supported.
- Dependency fetches run git with every inherited `GIT_*` variable removed,
  without system or global configuration, with a private HOME, an empty
  template and no hooks. Other variables (proxy and CA-bundle settings) are
  inherited, never copied into arguments. Changing them does not refetch a
  git dependency; `move_host_git` deliberately re-runs when PATH changes, to
  pick up a different git.
- `:copy_test` cannot see a nested directory that has its own BUILD file
  (Bazel globs stop at packages); keep the copy flat. The parent-side copy
  check, which reads git trees, reports such an addition.
