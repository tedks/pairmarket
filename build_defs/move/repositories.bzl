"""Repository rules for offline Sui Move builds.

Part of a small set of Move rules kept as exact copies in each consuming
repository; see README.md beside this file. Change the canonical copy only.

`sui_release` fetches one official Sui CLI release archive by integrity and
keeps only the `sui` executable. `move_git_dependency` fetches one pinned
commit of a Move git dependency into the layout the Sui CLI uses for its
dependency cache, packed as a single tarball for the build actions.
`move_host_git` exposes the host's git: the Sui CLI drives git even when
every dependency is already in its cache.

Only Bazel's repository fetch uses the network. Host requirements during
fetch: `tar` (releases and dependencies) and `git` (dependencies, host git).
"""

_HEX = "0123456789abcdef"

def _sanitize(url):
    # The Sui CLI names cache entries after the remote URL with every
    # character other than ASCII letters, digits, '-' and '_' replaced by '_'.
    out = []
    for ch in url.elems():
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        else:
            out.append("_")
    return "".join(out)

def _run(rctx, args, what, env = None, working_directory = ""):
    result = rctx.execute(
        args,
        environment = env or {},
        working_directory = working_directory,
        quiet = True,
    )
    if result.return_code != 0:
        fail("%s failed (%d):\n%s%s" % (what, result.return_code, result.stdout, result.stderr))
    return result.stdout

# Host platforms the rules know how to name, keyed as in `sui_release.archives`.
_PLATFORM_CONSTRAINTS = {
    "linux-aarch64": ["@platforms//os:linux", "@platforms//cpu:aarch64"],
    "linux-x86_64": ["@platforms//os:linux", "@platforms//cpu:x86_64"],
}

_PINS_EXPORT = """exports_files(["pins.txt"], visibility = ["//visibility:public"])

"""

def _host_platform(rctx):
    os = rctx.os.name.lower()
    arch = {"amd64": "x86_64", "arm64": "aarch64"}.get(rctx.os.arch, rctx.os.arch)
    if os.startswith("linux"):
        return "linux-" + arch
    if os.startswith("mac"):
        return "darwin-" + arch
    return os + "-" + arch

def _incompatible_build(name, why, prefix = ""):
    # Analysis skips targets that depend on this one instead of failing, so a
    # host without a supported artifact never fetches or runs a wrong binary.
    return prefix + """# %s
genrule(
    name = "%s",
    outs = ["%s.unavailable"],
    cmd = "false",
    executable = True,
    target_compatible_with = ["@platforms//:incompatible"],
    visibility = ["//visibility:public"],
)
""" % (why, name, name)

def _sui_release_impl(rctx):
    host = _host_platform(rctx)
    for key in rctx.attr.archives:
        if key not in _PLATFORM_CONSTRAINTS:
            fail("unsupported archives key '%s'; known: %s" % (key, sorted(_PLATFORM_CONSTRAINTS)))

    # Every pinned value, one per line, for sui_pin_test on any host.
    pins = [rctx.attr.version] + [rctx.attr.archives[k][-1] for k in sorted(rctx.attr.archives)]
    rctx.file("pins.txt", "\n".join(pins) + "\n")
    archive = rctx.attr.archives.get(host)
    if not archive:
        rctx.file("BUILD.bazel", _incompatible_build(
            "sui",
            "No Sui %s archive is pinned for host %s." % (rctx.attr.version, host),
            prefix = _PINS_EXPORT,
        ))
        return
    if len(archive) != 2 or not archive[1].startswith("sha256-"):
        fail("archives['%s'] must be [url, sha256-SRI]" % host)
    url, integrity = archive

    tar = rctx.which("tar")
    if not tar:
        fail("sui_release needs tar on the host PATH")
    rctx.download(url = [url], output = "sui-release.tgz", integrity = integrity)

    # The archives also carry debug binaries several GiB in size; extract only
    # the CLI. Releases have shipped it both as "./sui" and "sui".
    extracted = False
    for member in ["./sui", "sui"]:
        result = rctx.execute([tar, "-xzf", "sui-release.tgz", member], quiet = True)
        if result.return_code == 0:
            extracted = True
            break
    rctx.delete("sui-release.tgz")
    if not extracted:
        fail("no sui executable in %s" % url)
    rctx.execute(["mv", "sui", "sui-release"])

    reported = _run(rctx, ["./sui-release", "--version"], "sui --version").strip()
    expected = "sui " + rctx.attr.version + "-"
    if not reported.startswith(expected):
        fail("release reports '%s', expected '%s...'" % (reported, expected))

    rctx.file("BUILD.bazel", _PINS_EXPORT + """# Sui %s for %s, from %s
genrule(
    name = "sui",
    srcs = ["sui-release"],
    outs = ["bin/sui"],
    cmd = "cp $< $@",
    executable = True,
    target_compatible_with = %s,
    visibility = ["//visibility:public"],
)
""" % (rctx.attr.version, host, url, repr(_PLATFORM_CONSTRAINTS[host])))

sui_release = repository_rule(
    implementation = _sui_release_impl,
    doc = """One official Sui CLI release per supported host platform.

The host's archive is fetched by integrity; on a host with no listed archive
nothing is downloaded and `:sui` is incompatible, so dependent targets are
skipped. Actions run where Bazel runs them locally; remote execution on a
different platform is not supported.""",
    attrs = {
        "archives": attr.string_list_dict(
            mandatory = True,
            doc = "Host platform (linux-x86_64, linux-aarch64) to [url, sha256 SRI].",
        ),
        "version": attr.string(mandatory = True, doc = "Expected `sui --version` prefix, e.g. 1.80.1."),
    },
)

def _move_git_dependency_impl(rctx):
    commit = rctx.attr.commit
    if len(commit) != 40 or [c for c in commit.elems() if c not in _HEX]:
        fail("commit must be a full lowercase 40-hex git object name, got '%s'" % commit)
    if not rctx.attr.paths:
        fail("paths must name the package directories used from %s" % rctx.attr.remote)
    for path in rctx.attr.paths:
        if path.startswith("/") or ".." in path.split("/") or not path:
            fail("paths must be relative repository paths, got '%s'" % path)

    git = rctx.which("git")
    tar = rctx.which("tar")
    if not git or not tar:
        fail("move_git_dependency needs git and tar on the host PATH")

    entry = _sanitize(rctx.attr.remote) + "_" + commit
    stage = "stage"
    root = stage + "/" + entry

    # Ignore host and user git configuration (URL rewrites, credentials).
    env = {
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }

    gitc = [git, "-C", root]
    _run(rctx, [git, "init", "--quiet", root], "git init", env = env)
    _run(rctx, gitc + ["remote", "add", "origin", rctx.attr.remote], "git remote add", env = env)
    _run(rctx, gitc + ["config", "remote.origin.promisor", "true"], "git config", env = env)
    _run(rctx, gitc + ["config", "remote.origin.partialclonefilter", "blob:none"], "git config", env = env)
    _run(rctx, gitc + ["fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", commit], "git fetch", env = env)
    _run(rctx, gitc + ["sparse-checkout", "set", "--"] + rctx.attr.paths, "git sparse-checkout", env = env)
    _run(rctx, gitc + ["-c", "advice.detachedHead=false", "checkout", "--quiet", commit], "git checkout", env = env)

    head = _run(rctx, gitc + ["rev-parse", "HEAD"], "git rev-parse", env = env).strip()
    if head != commit:
        fail("checked out %s, expected %s" % (head, commit))
    for path in rctx.attr.paths:
        if not rctx.path(root + "/" + path + "/Move.toml").exists:
            fail("%s@%s has no Move.toml under %s" % (rctx.attr.remote, commit, path))

    _run(
        rctx,
        [
            tar,
            "--sort=name",
            "--mtime=@0",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "-cf",
            "cache.tar",
            "-C",
            stage,
            entry,
        ],
        "tar",
    )
    rctx.delete(stage)
    rctx.file("BUILD.bazel", """exports_files(["cache.tar"], visibility = ["//visibility:public"])
""")

move_git_dependency = repository_rule(
    implementation = _move_git_dependency_impl,
    doc = "One pinned commit of a Move git dependency, in Sui CLI cache layout.",
    attrs = {
        "commit": attr.string(mandatory = True, doc = "Full commit named by Move.lock."),
        "paths": attr.string_list(mandatory = True, doc = "Package subdirectories used at this commit."),
        "remote": attr.string(mandatory = True, doc = "Remote URL exactly as written in Move.lock."),
    },
)

def _move_host_git_impl(rctx):
    # Reading PATH through rctx.getenv re-runs this rule when PATH changes.
    rctx.getenv("PATH")
    git = rctx.which("git")
    if not git:
        rctx.file("BUILD.bazel", _incompatible_build("git", "No git on the host PATH."))
        return
    _run(rctx, [git, "--version"], "git --version")
    git = str(git)
    if "'" in git or "\n" in git:
        fail("unsupported character in git path %s" % git)
    rctx.file("git.sh", "#!/bin/sh\nexec '%s' \"$@\"\n" % git, executable = True)
    rctx.file("BUILD.bazel", """# Host git: %s
exports_files(["git.sh"])

genrule(
    name = "git",
    srcs = ["git.sh"],
    outs = ["bin/git"],
    cmd = "cp $< $@",
    executable = True,
    visibility = ["//visibility:public"],
)
""" % git)

move_host_git = repository_rule(
    implementation = _move_host_git_impl,
    doc = "The host's git, which the Sui CLI drives for its dependency cache.",
)
