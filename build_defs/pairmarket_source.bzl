"""Create a bounded Bazel source view with rules_js lifecycle compatibility."""

_CORE_SOURCE_FILES = [
    "packages/core/src/brand.ts",
    "packages/core/src/capabilities.ts",
    "packages/core/src/custody.ts",
    "packages/core/src/ids.ts",
    "packages/core/src/index.ts",
    "packages/core/src/network.ts",
    "packages/core/src/privacy.ts",
    "packages/core/src/tx.ts",
    "packages/core/src/validation.ts",
]

_CORE_TEST_FILES = [
    "packages/core/test/core-invariants.types.ts",
    "packages/core/test/ids.runtime.mjs",
    "packages/core/test/ids.types.ts",
    "packages/core/test/plaintext.runtime.mjs",
]

_EDITOR_JUNK = [".DS_Store", "Thumbs.db", "desktop.ini"]

def _collect_tree(ctx, directory, relative, extensions):
    frontier = [(directory, relative, 0)]
    files = []
    entries = 0
    for depth in range(9):
        if not frontier:
            break
        next_frontier = []
        for parent, prefix, parent_depth in frontier:
            for entry in parent.readdir():
                name = entry.basename
                if name in _EDITOR_JUNK or name.startswith("."):
                    continue
                path = prefix + "/" + name
                if str(entry.realpath) != str(entry):
                    fail("Pairmarket core source contains symlinked entry: %s" % path)
                entries += 1
                if entries > 128:
                    fail("Pairmarket core source inventory exceeds adapter bound")
                if entry.is_dir:
                    if parent_depth == 8:
                        fail("Pairmarket core source nesting exceeds adapter bound")
                    next_frontier.append((entry, path, parent_depth + 1))
                elif entry.exists and name.endswith(extensions):
                    files.append(path)
                    ctx.symlink(entry, path)
        frontier = next_frontier
    if not files:
        fail("Pairmarket core source directory is empty: %s" % relative)
    return sorted(files)

def _pairmarket_source_impl(ctx):
    marker = ctx.path(ctx.attr.marker)
    source = marker.dirname
    if str(source.realpath) != str(source):
        fail("Pairmarket Bazel workspace root must not be reached through a symlink")

    required = [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.base.json",
        "packages/core/package.json",
        "packages/core/src",
        "packages/core/test",
    ]
    for relative in required:
        original = source.get_child(relative)
        if not original.exists:
            fail("Pairmarket Bazel source requires %s" % relative)
        if relative == "packages/core/src":
            ctx.watch_tree(original)
            actual = _collect_tree(ctx, original, relative, (".ts",))
            if actual != _CORE_SOURCE_FILES:
                fail("Pairmarket core source inventory changed; update explicit BUILD list: %s" % actual)
        elif relative == "packages/core/test":
            ctx.watch_tree(original)
            actual = _collect_tree(ctx, original, relative, (".ts", ".mjs"))
            if actual != _CORE_TEST_FILES:
                fail("Pairmarket core test inventory changed; update explicit BUILD list: %s" % actual)
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
    ctx.symlink(ctx.path(ctx.attr.core_tsconfig), "packages/core/tsconfig.json")
    ctx.symlink(ctx.path(ctx.attr.typecheck_script), "packages/core/test/typecheck_test.sh")

pairmarket_source = repository_rule(
    implementation = _pairmarket_source_impl,
    attrs = {
        "core_build": attr.label(default = Label("//build_defs/overlays:pairmarket-core.BUILD.bazel")),
        "core_tsconfig": attr.label(default = Label("//build_defs/overlays:tsconfig.bazel.json")),
        "marker": attr.label(default = Label("//:MODULE.bazel")),
        "root_build": attr.label(default = Label("//build_defs/overlays:pairmarket.BUILD.bazel")),
        "typecheck_script": attr.label(default = Label("//build_defs/overlays:typecheck_test.sh")),
    },
    local = True,
)
