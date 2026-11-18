"""Bazel rules that build and test one Sui Move package offline.

Part of a small set of Move rules kept as exact copies in each consuming
repository; see README.md beside this file. Change the canonical copy only.

`move_package` compiles the package with `sui move build` and outputs a tree
of bytecode: `<package name>/bytecode_modules/*.mv`, plus the compiled
dependencies under `bytecode_modules/dependencies/`.

`move_test` runs the package's Move unit tests with `sui move test` and fails
when the CLI fails or when it reports zero tests.

Both stage `srcs` at their workspace-relative paths in a private directory,
so Move.toml `local` dependencies resolve exactly as in the source tree, and
both supply git dependencies only from `deps` (move_git_dependency tarballs).
Git transports are disabled at run time: a missing dependency or a stale
Move.lock fails instead of fetching.

`sui_pin_test` checks that a sui_release repeats the pins of another source
(such as flake.nix). `move_rules_copy_test` checks a copy of these rules
against its MANIFEST.sha256.
"""

def _tool_attrs(cfg):
    # move_package runs the tools in a build action (exec configuration);
    # move_test runs them at test time on the target platform.
    return {
        "git": attr.label(
            allow_single_file = True,
            executable = True,
            cfg = cfg,
            mandatory = True,
            doc = "The git the Sui CLI drives, normally `@<move_host_git repo>//:git`.",
        ),
        "sui": attr.label(
            allow_single_file = True,
            executable = True,
            cfg = cfg,
            mandatory = True,
            doc = "The sui CLI, normally `@<sui_release repo>//:sui`.",
        ),
        "_runner": attr.label(
            default = Label(":runner.sh"),
            allow_single_file = True,
            executable = True,
            cfg = cfg,
        ),
    }

_COMMON_ATTRS = {
    "build_env": attr.string(
        default = "mainnet",
        doc = "Move environment passed as --build-env.",
    ),
    "deps": attr.label_list(
        allow_files = [".tar"],
        doc = "move_git_dependency archives (`@repo//:cache.tar`) for every git dependency in Move.lock.",
    ),
    "package": attr.string(
        doc = "Workspace-relative directory holding Move.toml. Defaults to this BUILD file's package.",
    ),
    "srcs": attr.label_list(
        allow_files = True,
        mandatory = True,
        doc = "Move.toml, Move.lock, sources, tests and any `local` dependency packages.",
    ),
}

def _package_dir(ctx):
    package = ctx.attr.package or ctx.label.package
    if not package or package.startswith("/") or ".." in package.split("/"):
        fail("package must be a workspace-relative directory, got '%s'" % package)
    return package

def _staging_lines(ctx, package, runfiles_relative):
    required = {package + "/Move.lock": False, package + "/Move.toml": False}
    lines = []
    for f in ctx.files.srcs:
        if f.owner.workspace_name:
            fail("srcs must come from this repository, got %s" % f.owner)
        if "\t" in f.short_path or "\n" in f.short_path:
            fail("unsupported character in path %s" % f.short_path)
        if f.short_path in required:
            required[f.short_path] = True
        source = f.short_path if runfiles_relative else f.path
        lines.append(source + "\t" + f.short_path)
    for path, present in required.items():
        if not present:
            fail("srcs must include %s: the committed lock is the dependency pin" % path)
    return "\n".join(lines) + "\n"

def _move_package_impl(ctx):
    package = _package_dir(ctx)
    manifest = ctx.actions.declare_file(ctx.label.name + ".stage")
    ctx.actions.write(manifest, _staging_lines(ctx, package, runfiles_relative = False))
    out = ctx.actions.declare_directory(ctx.label.name)

    args = ctx.actions.args()
    args.add("build")
    args.add(ctx.executable.sui)
    args.add(ctx.executable.git)
    args.add(package)
    args.add(ctx.attr.build_env)
    args.add(manifest)
    args.add(out.path)
    args.add_all(ctx.files.deps)

    ctx.actions.run(
        executable = ctx.executable._runner,
        arguments = [args],
        inputs = depset(ctx.files.srcs + ctx.files.deps + [manifest]),
        tools = [ctx.executable.sui, ctx.executable.git],
        outputs = [out],
        mnemonic = "MoveBuild",
        progress_message = "Building Move package %s" % package,
        execution_requirements = {"block-network": ""},
        use_default_shell_env = True,
    )
    return [DefaultInfo(files = depset([out]))]

move_package = rule(
    implementation = _move_package_impl,
    attrs = dict(_COMMON_ATTRS, **_tool_attrs("exec")),
    doc = "Compiles one Sui Move package with `sui move build`.",
)

def _shell_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"

def _move_test_impl(ctx):
    package = _package_dir(ctx)
    manifest = ctx.actions.declare_file(ctx.label.name + ".stage")
    ctx.actions.write(manifest, _staging_lines(ctx, package, runfiles_relative = True))

    command = [
        ctx.executable._runner.short_path,
        "test",
        ctx.executable.sui.short_path,
        ctx.executable.git.short_path,
        package,
        ctx.attr.build_env,
        manifest.short_path,
        "-",
    ] + [f.short_path for f in ctx.files.deps]
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        launcher,
        "#!/usr/bin/env bash\n" +
        "# Runs from the test's runfiles root (the main repository directory).\n" +
        "exec " + " ".join([_shell_quote(c) for c in command]) + "\n",
        is_executable = True,
    )

    runfiles = ctx.runfiles(
        files = ctx.files.srcs + ctx.files.deps + [manifest, ctx.executable.sui, ctx.executable.git, ctx.executable._runner],
    )
    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

_move_test = rule(
    implementation = _move_test_impl,
    attrs = dict(_COMMON_ATTRS, **_tool_attrs("target")),
    test = True,
    doc = "Runs one Sui Move package's unit tests with `sui move test`.",
)

def move_test(name, tags = [], **kwargs):
    """Runs one Sui Move package's unit tests with `sui move test`.

    Always tagged `block-network`, so the Linux sandbox denies the test any
    network access (move_package requests the same for its action).
    """
    _move_test(
        name = name,
        tags = tags + ([] if "block-network" in tags else ["block-network"]),
        **kwargs
    )

def _sui_pin_test_impl(ctx):
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        script,
        """#!/usr/bin/env bash
# Fails unless every pinned value (CLI version and archive hashes) appears
# verbatim, with no digit or dot directly before it and no digit after it (so
# 1.80.1 never matches 1.80.10 or 21.80.1), in at least one of the files that
# also pin the Sui CLI, e.g. a Nix flake. This is a presence check (see
# README.md).
set -euo pipefail
pins=%s
files=(%s)
[[ -s "$pins" ]] || { echo "no pins in $pins" >&2; exit 1; }
missing=0
while IFS= read -r pin; do
  [[ -n "$pin" ]] || continue
  pattern="(^|[^0-9.])$(printf '%%s' "$pin" | sed 's#[][\\.*^$+?(){}|]#\\\\&#g')([^0-9]|\\$)"
  if ! grep -qE -- "$pattern" "${files[@]}"; then
    echo "pin '$pin' not found in: ${files[*]}" >&2
    missing=1
  fi
done <"$pins"
[[ $missing -eq 0 ]] && echo "all Sui pins match: $(tr '\\n' ' ' <"$pins")"
exit "$missing"
""" % (_shell_quote(ctx.file.pins.short_path), " ".join([_shell_quote(f.short_path) for f in ctx.files.files])),
        is_executable = True,
    )
    return [DefaultInfo(
        executable = script,
        runfiles = ctx.runfiles(files = [ctx.file.pins] + ctx.files.files),
    )]

sui_pin_test = rule(
    implementation = _sui_pin_test_impl,
    test = True,
    attrs = {
        "files": attr.label_list(allow_files = True, mandatory = True, doc = "Files that must repeat every pin."),
        "pins": attr.label(allow_single_file = True, mandatory = True, doc = "`@<sui_release repo>//:pins.txt`."),
    },
    doc = "Checks that a sui_release's pins match another pin source, such as flake.nix.",
)

def _move_rules_copy_test_impl(ctx):
    manifest = ctx.file.manifest
    prefix = manifest.short_path[:-len(manifest.basename)]
    for f in ctx.files.files:
        if not f.short_path.startswith(prefix):
            fail("%s is not under %s" % (f.short_path, prefix))
    names = sorted([f.short_path[len(prefix):] for f in ctx.files.files])
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        script,
        """#!/usr/bin/env bash
# Fails when any file beside the manifest differs from it, or when the
# manifest and the directory do not list the same files.
set -euo pipefail
cd %s
expected=$(printf '%%s\\n' %s)
listed=$(awk '{print $2}' MANIFEST.sha256 | LC_ALL=C sort)
if [[ "$expected" != "$listed" ]]; then
  echo "MANIFEST.sha256 lists different files than the directory holds" >&2
  diff <(echo "$listed") <(echo "$expected") >&2 || true
  exit 1
fi
sha256sum --check --strict MANIFEST.sha256
# The runner is executed directly; a copy that lost its mode would only fail
# at build time.
[[ -x runner.sh ]] || { echo "runner.sh is not executable" >&2; exit 1; }
""" % (_shell_quote(manifest.dirname[len(manifest.root.path):].lstrip("/") or "."), " ".join([_shell_quote(n) for n in names])),
        is_executable = True,
    )
    return [DefaultInfo(
        executable = script,
        runfiles = ctx.runfiles(files = [manifest] + ctx.files.files),
    )]

move_rules_copy_test = rule(
    implementation = _move_rules_copy_test_impl,
    test = True,
    attrs = {
        "files": attr.label_list(allow_files = True, mandatory = True),
        "manifest": attr.label(allow_single_file = True, mandatory = True),
    },
    doc = "Checks that a copy of these rules matches its MANIFEST.sha256.",
)
