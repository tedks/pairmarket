# Offline Sui Move rules for Bazel

Small Bazel rules that compile a Sui Move package and run its Move unit tests
without network access, with the same Sui CLI release a project already pins.

This directory is kept as an exact copy wherever it is used. `MANIFEST.sha256`
lists the SHA-256 of every other file here, and the `:copy_test` target checks
the files against it, so a local edit to a copy fails that repository's tests.
Change the canonical copy, regenerate the manifest, then copy the whole
directory (including the manifest) into each consumer.

```bash
sha256sum BUILD.bazel README.md defs.bzl repositories.bzl runner.sh > MANIFEST.sha256
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
  the `deps` archives and a keyless client configuration, and refuse every
  git transport. A missing dependency fails; nothing is fetched.
- A `Move.lock` that is stale for the pinned CLI fails, even when the CLI
  could re-resolve it from cached sources: the committed lock is the pin.
- `move_test` fails when the CLI fails or reports zero tests.
- The build output contains bytecode only; the CLI's `BuildInfo.yaml`, debug
  info and source maps embed an absolute scratch path and are omitted.
- Host requirements: Linux, bash, coreutils, tar, and git (for fetching
  dependencies and because the CLI drives git for its cache).
- `sui_release` fetches the archive for the host platform only. A host with no
  listed archive downloads nothing, and the targets that need it are skipped
  as incompatible. Remote execution on another platform is not supported.
