# Runs a command with only the environment variables named in
# MOVE_FETCH_KEEP (space-separated), plus the few a shell maintains itself.
#
# usage: sh fetch_env.sh COMMAND [ARG...]
#
# Variables are removed with the shell's unset builtin, so no value is ever
# passed as an argument (proxy URLs may carry credentials). After cleanup the
# environment is listed again; if anything outside the allowlist remains, the
# command is not run. Used by move_git_dependency for fetch-time git.
#
# Part of a small set of Move rules kept as exact copies in each consuming
# repository; see README.md beside this file. Change the canonical copy only.

IFS='
'
fail() {
  echo "move fetch_env: $*" >&2
  exit 1
}
command -v env >/dev/null 2>&1 || fail "env is required"
command -v sed >/dev/null 2>&1 || fail "sed is required"
[ $# -gt 0 ] || fail "no command given"

keep=" ${MOVE_FETCH_KEEP-} "
unset MOVE_FETCH_KEEP

for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
  case "$keep" in
    *" $name "*) ;;
    *) unset "$name" 2>/dev/null ;;
  esac
done
# bash exports functions as BASH_FUNC_<name>%%; unset removes them.
for fn in $(env | sed -n 's/^BASH_FUNC_\([^=]*\)%%=.*/\1/p'); do
  unset -f "$fn" 2>/dev/null
done

# Shells export these themselves; they cannot redirect git.
allowed="$keep PWD OLDPWD SHLVL _ "
for name in $(env | sed -n 's/^\([^=]*\)=.*/\1/p'); do
  case "$allowed" in
    *" $name "*) ;;
    *) fail "could not clear $name; refusing to run with it set" ;;
  esac
done

exec "$@"
