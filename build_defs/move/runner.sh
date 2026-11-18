#!/usr/bin/env bash
# Runs the Sui Move CLI on a staged copy of one package, offline.
#
# usage: runner.sh build|test SUI GIT PACKAGE BUILD_ENV MANIFEST OUT [DEP_TAR...]
#
#   SUI        path to the sui executable
#   GIT        path to the git executable the Sui CLI drives for dependencies
#   PACKAGE    workspace-relative package directory (holds Move.toml)
#   BUILD_ENV  Move environment passed as --build-env (e.g. mainnet)
#   MANIFEST   lines "<readable path>\t<workspace-relative path>"; every listed
#              file is copied to its workspace-relative path under a private
#              staging root, so `local = "../x"` dependencies keep their layout
#   OUT        build: directory receiving <name>/bytecode_modules/...; test: "-"
#   DEP_TAR    tarballs, each holding one pinned git checkout laid out as the
#              Sui CLI's dependency cache entry (MOVE_HOME/git/<entry>)
#
# Assumptions (checked where cheap): Linux with bash, coreutils and tar on
# PATH. Nothing here contacts the network: git transports are disabled, so a
# dependency missing from the staged cache, or a Move.lock that needs
# re-resolution, fails instead of fetching. The staged copy keeps the Sui CLI
# from ever writing into the source tree.
#
# Part of a small set of Move rules kept as exact copies in each consuming
# repository; see README.md beside this file. Change the canonical copy only.
set -euo pipefail

die() {
  printf 'move runner: %s\n' "$*" >&2
  exit 1
}

[[ $# -ge 7 ]] || die "usage: runner.sh build|test SUI GIT PACKAGE BUILD_ENV MANIFEST OUT [DEP_TAR...]"
mode=$1 sui=$2 git=$3 package=$4 build_env=$5 manifest=$6 out=$7
shift 7

case "$mode" in build | test) ;; *) die "unknown mode '$mode'" ;; esac
case "$package" in
  "" | /* | ../* | */../* | */.. | ..) die "package must be a workspace-relative path, got '$package'" ;;
esac
[[ -x "$sui" ]] || die "sui executable not found: $sui"
[[ -f "$manifest" ]] || die "manifest not found: $manifest"
[[ -x "$git" ]] || die "git executable not found: $git"
command -v tar >/dev/null || die "tar is required on PATH"

abspath() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }
sui=$(abspath "$sui")
git=$(abspath "$git")
if [[ "$mode" == build ]]; then
  [[ "$out" != "-" && -n "$out" ]] || die "build mode needs an output directory"
  out=$(abspath "$out")
fi

scratch_parent=${TEST_TMPDIR:-${TMPDIR:-/tmp}}
work=$(mktemp -d "$scratch_parent/move-runner.XXXXXX")
# $work was created above by mktemp in this process; nothing else lives there.
trap 'rm -rf -- "$work"' EXIT

src_root=$work/src
move_home=$work/move
config_dir=$work/home/.sui/sui_config
mkdir -p "$src_root" "$move_home/git" "$config_dir" "$work/bin"
# The Sui CLI runs plain `git`; put exactly the declared one first on PATH.
ln -s -- "$git" "$work/bin/git"
PATH=$work/bin:$PATH

staged=0
while IFS=$'\t' read -r from to || [[ -n "${from:-}" ]]; do
  [[ -n "$from" ]] || continue
  case "$to" in
    "" | /* | ../* | */../* | */.. | ..) die "refusing to stage outside the package root: '$to'" ;;
  esac
  [[ -f "$from" ]] || die "staged input missing: $from"
  mkdir -p "$src_root/$(dirname -- "$to")"
  cp -L -- "$from" "$src_root/$to"
  staged=$((staged + 1))
done <"$manifest"
[[ -f "$src_root/$package/Move.toml" ]] || die "no Move.toml staged at $package/"
# The committed lock is the dependency pin; without it the CLI would resolve.
[[ -f "$src_root/$package/Move.lock" ]] || die "no Move.lock staged at $package/"

for dep in "$@"; do
  [[ -f "$dep" ]] || die "dependency archive missing: $dep"
  tar -xf "$dep" -C "$move_home/git"
done

# A keyless client configuration: the CLI otherwise offers to create one and
# generates a fresh keypair. RPC endpoints point at a closed local port so any
# unexpected chain query fails fast instead of reaching a public node.
printf '[]\n' >"$config_dir/sui.keystore"
cat >"$config_dir/client.yaml" <<EOF
---
keystore:
  File: $config_dir/sui.keystore
envs:
  - alias: mainnet
    rpc: "http://127.0.0.1:9"
    ws: ~
    basic_auth: ~
    chain_id: 35834a8a
  - alias: testnet
    rpc: "http://127.0.0.1:9"
    ws: ~
    basic_auth: ~
    chain_id: 4c78adac
active_env: mainnet
active_address: ~
EOF

lock=$src_root/$package/Move.lock
lock_before=$work/Move.lock.before
cp -- "$lock" "$lock_before"

run_sui() {
  # The environment is rebuilt from scratch: only PATH survives, git ignores
  # system and user configuration, and every git transport is refused.
  env -i \
    PATH="$PATH" \
    HOME="$work/home" \
    MOVE_HOME="$move_home" \
    NO_COLOR=1 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=protocol.allow \
    GIT_CONFIG_VALUE_0=never \
    "$sui" move --client.config "$config_dir/client.yaml" "$@" </dev/null
}

check_lock() {
  # $1: a lock file the CLI produced. A difference means Move.lock is stale
  # for this toolchain; the committed lock is the pin, so refuse to proceed.
  if [[ -f "$1" ]] && ! cmp -s "$lock_before" "$1"; then
    diff -u "$lock_before" "$1" >&2 || true
    die "Move.lock for $package is stale under this Sui CLI; regenerate and commit it"
  fi
}

cd "$src_root"
log=$work/sui.log
status=0
if [[ "$mode" == build ]]; then
  run_sui build -p "$package" --build-env "$build_env" --install-dir "$work/install" >"$log" 2>&1 || status=$?
else
  run_sui test -p "$package" --build-env "$build_env" --install-dir "$work/install" >"$log" 2>&1 || status=$?
fi
cat -- "$log"
[[ $status -eq 0 ]] || die "sui move $mode failed with status $status"

# When every source is cached the CLI re-resolves a stale lock in memory and
# says so; a build also writes the result beside the installed artifacts.
if grep -q '^\[NOTE\] Updating dependencies' "$log"; then
  die "Move.lock for $package is stale under this Sui CLI (it re-resolved dependencies); regenerate and commit it"
fi
[[ -f "$lock" ]] || die "sui removed $package/Move.lock"
check_lock "$lock"
check_lock "$work/install/Move.lock"

if [[ "$mode" == build ]]; then
  [[ -d "$work/install/build" ]] || die "sui move build produced no build/ directory"
  modules=$(find "$work/install/build" -path '*/bytecode_modules/*.mv' -not -path '*/dependencies/*' | wc -l)
  [[ $modules -gt 0 ]] || die "sui move build produced no package bytecode modules"
  # Publish only bytecode: BuildInfo.yaml, debug_info and source maps embed
  # this run's absolute scratch path, so they would differ on every run.
  [[ -d "$out" ]] || mkdir -p -- "$out"
  (
    cd "$work/install/build"
    for dir in */bytecode_modules; do
      [[ -d "$dir" ]] || continue
      mkdir -p -- "$out/$(dirname -- "$dir")"
      cp -RL -- "$dir" "$out/$dir"
    done
  )
  if grep -rlF -- "$work" "$out" >/dev/null 2>&1; then
    die "build output embeds the scratch path; refusing a nondeterministic artifact"
  fi
  printf 'move runner: built %s (%d package modules, %d staged files)\n' "$package" "$modules" "$staged"
else
  summary=$(grep -E '^Test result: OK\. Total tests: [0-9]+; passed: [0-9]+; failed: 0$' "$log" | tail -n 1 || true)
  [[ -n "$summary" ]] || die "no passing test summary in sui output"
  total=${summary#*Total tests: }
  total=${total%%;*}
  [[ $total -gt 0 ]] || die "sui move test ran zero tests for $package"
  printf 'move runner: %s passed %d Move unit tests\n' "$package" "$total"
fi
