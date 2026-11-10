"""Create a Bazel-only Pairmarket source view with a rules_js lifecycle key."""

def _link_tree(ctx, directory, relative, extensions):
    frontier = [(directory, relative)]
    files = 0
    entries = 0
    for depth in range(9):
        next_frontier = []
        for parent, prefix in frontier:
            names = sorted([entry.basename for entry in parent.readdir()])
            if not names:
                fail("Pairmarket core source directory is empty: %s" % prefix)
            for name in names:
                entry = parent.get_child(name)
                path = prefix + "/" + name
                if name.startswith(".") or str(entry.realpath) != str(entry):
                    fail("Pairmarket core source contains hidden or symlinked entry: %s" % path)
                entries += 1
                if entries > 128:
                    fail("Pairmarket core source inventory exceeds adapter bound")
                if entry.is_dir:
                    if depth == 8:
                        fail("Pairmarket core source nesting exceeds adapter bound")
                    next_frontier.append((entry, path))
                elif entry.exists and name.endswith(extensions):
                    ctx.symlink(entry, path)
                    files += 1
                else:
                    fail("Pairmarket core source contains unsupported entry: %s" % path)
        frontier = next_frontier
    if files == 0:
        fail("Pairmarket core source has no files: %s" % relative)

def _pairmarket_source_impl(ctx):
    source = ctx.path(ctx.attr.marker).dirname
    required = [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "packages/core/package.json",
        "packages/core/tsconfig.json",
        "packages/core/src",
        "packages/core/test",
    ]
    for relative in required:
        original = source.get_child(relative)
        if not original.exists:
            fail("Pairmarket Bazel source requires %s" % relative)
        if relative in ["packages/core/src", "packages/core/test"]:
            ctx.watch_tree(original)
            extensions = (".ts",) if relative.endswith("/src") else (".ts", ".mjs")
            _link_tree(ctx, original, relative, extensions)
        elif relative != "pnpm-workspace.yaml":
            ctx.symlink(original, relative)

    workspace = ctx.read(source.get_child("pnpm-workspace.yaml"))
    if (not workspace.startswith("packages:\n") or
        "\nallowBuilds:\n" not in workspace or
        "onlyBuiltDependencies" in workspace or
        not workspace.endswith("\n")):
        fail("Pairmarket pnpm workspace layout changed; review lifecycle compatibility")
    ctx.file("pnpm-workspace.yaml", workspace + "\nonlyBuiltDependencies: []\n")

    ctx.file("BUILD.bazel", ctx.read(ctx.attr.root_build))
    ctx.file("packages/core/BUILD.bazel", ctx.read(ctx.attr.core_build))

pairmarket_source = repository_rule(
    implementation = _pairmarket_source_impl,
    attrs = {
        "core_build": attr.label(default = Label("//build_defs/overlays:pairmarket-core.BUILD.bazel")),
        "marker": attr.label(default = Label("//:MODULE.bazel")),
        "root_build": attr.label(default = Label("//build_defs/overlays:pairmarket.BUILD.bazel")),
    },
    local = True,
)
