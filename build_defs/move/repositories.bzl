"""Repository rules for offline Sui Move builds.

Part of a small set of Move rules kept as exact copies in each consuming
repository; see README.md beside this file. Change the canonical copy only.

`sui_release` fetches one official Sui CLI release archive by integrity and
keeps only the `sui` executable. `move_git_dependency` fetches one pinned
commit of a Move git dependency into the layout the Sui CLI uses for its
dependency cache, packed as a single tarball for the build actions.
`move_host_git` exposes the host's git: the Sui CLI drives git even when
every dependency is already in its cache.

The official release is an unpatched glibc binary that names the FHS loader
(/lib64/ld-linux-x86-64.so.2). When MOVE_SUI_LOADER and MOVE_SUI_LIBRARY_PATH
are set (a Nix dev shell exports a pinned glibc loader and the glibc and
libstdc++ library directories), the fetch-time probe and every build and test
run the release through that loader, so no FHS loader is needed; otherwise
the release runs directly.

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

def _incompatible_build(name, why, prefix = "", outs = None):
    # Analysis skips targets that depend on this one instead of failing, so a
    # host without a supported artifact never fetches or runs a wrong binary.
    return prefix + """# %s
genrule(
    name = "%s",
    outs = ["%s"],
    cmd = "false",
    executable = True,
    target_compatible_with = ["@platforms//:incompatible"],
    visibility = ["//visibility:public"],
)
""" % (why, name, outs or (name + ".unavailable"))

def _sui_runtime(rctx):
    """Returns [loader, library_path] from the environment, or [] when unset."""
    loader = rctx.getenv("MOVE_SUI_LOADER", "")
    library_path = rctx.getenv("MOVE_SUI_LIBRARY_PATH", "")
    if not loader and not library_path:
        return []
    if not loader or not library_path:
        fail("set both MOVE_SUI_LOADER and MOVE_SUI_LIBRARY_PATH, or neither")
    for value in [loader] + library_path.split(":"):
        if not value.startswith("/") or [c for c in ["'", "\"", "\\", "\n", "$", "`"] if c in value]:
            fail("MOVE_SUI_LOADER and MOVE_SUI_LIBRARY_PATH must be absolute paths without quotes, '$' or '`', got '%s'" % value)
        if not rctx.path(value).exists:
            fail("%s (from MOVE_SUI_LOADER or MOVE_SUI_LIBRARY_PATH) does not exist" % value)
    return [loader, library_path]

def _sui_release_impl(rctx):
    host = _host_platform(rctx)
    for key, value in rctx.attr.archives.items():
        if key not in _PLATFORM_CONSTRAINTS:
            fail("unsupported archives key '%s'; known: %s" % (key, sorted(_PLATFORM_CONSTRAINTS)))
        if len(value) != 2 or not value[1].startswith("sha256-"):
            fail("archives['%s'] must be [url, sha256-SRI]" % key)

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
    _run(rctx, ["mv", "sui", "sui-release"], "mv sui")

    runtime = _sui_runtime(rctx)
    if runtime:
        probe_args = [runtime[0], "--library-path", runtime[1], "./sui-release", "--version"]
    else:
        probe_args = ["./sui-release", "--version"]
    probe = rctx.execute(probe_args, quiet = True)
    if probe.return_code != 0:
        if runtime:
            hint = "It was run through MOVE_SUI_LOADER=%s with MOVE_SUI_LIBRARY_PATH=%s." % tuple(runtime)
        else:
            hint = ("A likely cause: it is an unpatched glibc binary that needs the FHS " +
                    "loader and libstdc++. Without them (e.g. NixOS), set " +
                    "MOVE_SUI_LOADER and MOVE_SUI_LIBRARY_PATH, as the Nix dev shell does.")
        fail("the official Sui %s release for %s did not run (%d): %s%s\n%s" %
             (rctx.attr.version, host, probe.return_code, probe.stdout, probe.stderr, hint))
    reported = probe.stdout.strip()
    expected = "sui " + rctx.attr.version + "-"
    if not reported.startswith(expected):
        fail("release reports '%s', expected '%s...'" % (reported, expected))

    rctx.file("BUILD.bazel", _PINS_EXPORT + """load(%r, "sui_executable")

# Sui %s for %s, from %s
sui_executable(
    name = "sui",
    binary = "sui-release",
    loader = %r,
    library_path = %r,
    target_compatible_with = %s,
    visibility = ["//visibility:public"],
)
""" % (
        str(Label(":defs.bzl")),
        rctx.attr.version,
        host,
        url,
        runtime[0] if runtime else "",
        runtime[1] if runtime else "",
        repr(_PLATFORM_CONSTRAINTS[host]),
    ))

sui_release = repository_rule(
    implementation = _sui_release_impl,
    doc = """One official Sui CLI release per supported host platform.

The host's archive is fetched by integrity; on a host with no listed archive
nothing is downloaded and `:sui` is incompatible, so dependent targets are
skipped. Actions run where Bazel runs them locally; remote execution on a
different platform is not supported. MOVE_SUI_LOADER and
MOVE_SUI_LIBRARY_PATH, when set, select the loader that runs the release
(see the module docstring); changing them refetches.""",
    attrs = {
        "archives": attr.string_list_dict(
            mandatory = True,
            doc = "Host platform (linux-x86_64, linux-aarch64) to [url, sha256 SRI].",
        ),
        "version": attr.string(mandatory = True, doc = "Expected `sui --version` prefix, e.g. 1.80.1."),
    },
)

# Certificate settings only add trust anchors for HTTPS verification; they
# cannot redirect the fetch or disable verification, so they are inherited.
_GIT_KEEP = ["GIT_SSL_CAINFO", "GIT_SSL_CAPATH"]

def _move_git_dependency_impl(rctx):
    commit = rctx.attr.commit
    if len(commit) != 40 or [c for c in commit.elems() if c not in _HEX]:
        fail("commit must be a full lowercase 40-hex git object name, got '%s'" % commit)
    if rctx.attr.remote.startswith("-") or not rctx.attr.remote:
        fail("remote must be a URL, got '%s'" % rctx.attr.remote)
    if not rctx.attr.paths:
        fail("paths must name the package directories used from %s" % rctx.attr.remote)
    for path in rctx.attr.paths:
        if path.startswith("/") or ".." in path.split("/") or not path:
            fail("paths must be relative repository paths, got '%s'" % path)

    host = _host_platform(rctx)
    git = rctx.which("git")
    tar = rctx.which("tar")
    env_tool = rctx.which("env")
    if host not in _PLATFORM_CONSTRAINTS:
        # Unsupported platform: skip the Move targets instead of failing
        # every build that loads this repository.
        rctx.file("BUILD.bazel", _incompatible_build(
            "cache.tar",
            "Move dependencies are fetched only on supported Linux hosts (host %s)." % host,
            outs = "unavailable/cache.tar",
        ))
        return
    if not git or not tar or not env_tool:
        # A supported host missing a tool is misconfigured: fail loudly rather
        # than let the Move tests be skipped.
        fail("move_git_dependency needs git, tar and env on the host PATH")

    entry = _sanitize(rctx.attr.remote) + "_" + commit
    stage = "stage"
    root = stage + "/" + entry

    # git ignores system and global configuration, never prompts, uses a
    # private HOME and never runs hooks. Every GIT_* variable Bazel passes to
    # repository rules (directories, config, templates, exec path, ssh
    # command, ...) except the trust-anchor pair in _GIT_KEEP is removed
    # with env -u, which puts only names in argv. Non-GIT_* variables (proxy
    # settings, SSL_CERT_FILE, ...) are inherited unchanged, so their values
    # (proxy URLs may carry credentials) never appear in the process list. rctx.os.environ is read without making the
    # variables fetch inputs, so changing them does not refetch.
    env = {
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "HOME": str(rctx.path("home")),
    }
    drop = sorted([
        name
        for name in rctx.os.environ
        if name.startswith("GIT_") and name not in env and name not in _GIT_KEEP
    ])
    git = [str(env_tool)] + ["-u" + name for name in drop] + [str(git), "-c", "core.hooksPath=/dev/null"]

    gitc = git + ["-C", root]
    # An empty template keeps hooks (and anything else) out of the new repo.
    _run(rctx, git + ["init", "--quiet", "--template=", root], "git init", env = env)
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

    # Drop fetch-time records that differ on every fetch and that the CLI never
    # reads. The remaining .git (index stat data, pack layout) can still differ
    # between fetches, so the archive digest is not reproducible across
    # refetches or hosts; only its content is pinned, by the commit.
    for volatile in ["FETCH_HEAD", "logs", "ORIG_HEAD"]:
        rctx.delete(root + "/.git/" + volatile)

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
    host = _host_platform(rctx)
    if host not in _PLATFORM_CONSTRAINTS:
        rctx.file("BUILD.bazel", _incompatible_build("git", "Unsupported host %s." % host))
        return
    git = rctx.which("git")
    if not git:
        # A supported host without git is misconfigured; skipping would hide
        # every Move test.
        fail("move_host_git needs git on the host PATH")
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
