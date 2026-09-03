#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${PAIRMARKET_DEVSTACK_DIR:-$PROJECT_ROOT/.devstack}"
CLIENT_DIR="$STATE_DIR/sui-client"
CLIENT_CONFIG="$CLIENT_DIR/client.yaml"
ADDRESS_JSON="$CLIENT_DIR/deployer-address.json"
LOCAL_ENV_FILE="$STATE_DIR/pairmarket-local.env"
WEB_ENV_FILE="${PAIRMARKET_WEB_ENV_FILE:-$PROJECT_ROOT/apps/web/.env.local}"
PORT_ENV_FILE="$STATE_DIR/ports.env"
PUBLISH_JSON="$STATE_DIR/publish-output.json"
PUBFILE="$STATE_DIR/Published.localnet.toml"
PACKAGE_ID_FILE="$STATE_DIR/package-id.txt"
CONFIG_ID_FILE="$STATE_DIR/config-id.txt"
ADMIN_CAP_ID_FILE="$STATE_DIR/admin-cap-id.txt"
PUBLISH_WORKDIR="$STATE_DIR/publish-workdir"
PUBLISH_GAS_BUDGET="${PAIRMARKET_PUBLISH_GAS_BUDGET:-1000000000}"
PORT_RANGE_START="${PAIRMARKET_DEVSTACK_PORT_RANGE_START:-20000}"
PORT_RANGE_END="${PAIRMARKET_DEVSTACK_PORT_RANGE_END:-29999}"

SUI_DEVSTACK_HOME="${SUI_DEVSTACK_HOME:-}"
SUI_DEVSTACK_SCRIPT="${SUI_DEVSTACK_SCRIPT:-}"

log() { printf '[pairmarket-devstack] %s\n' "$*"; }
err() { printf '[pairmarket-devstack][ERROR] %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: scripts/devstack.sh <command>

Commands:
  up       Start upstream Sui Localnet and create/fund the local deployer
  deploy   Publish contracts/pairmarket to the running localnet
  status   Show upstream localnet and pairmarket deploy status
  logs     Tail upstream Sui Localnet logs
  env      Print the generated pairmarket environment file
  down     Stop upstream Sui Localnet, preserving state (up resumes the same chain)
  reset    Start over on a fresh chain: remove chain state, logs, publish output
           and generated env files; keep the deployer key and generated ports
  purge    Remove the whole .devstack tree and apps/web/.env.local; nothing survives
           (every deletion target must resolve inside this checkout, no symlinks)

Environment:
  SUI_DEVSTACK_HOME             Path to sui-devstack checkout
  SUI_DEVSTACK_SCRIPT           Override path to localnet/sui-localnet.sh
  SUI_DEVSTACK_COMPOSE_PROJECT  Compose project name (default: pairmarket-devstack in
                                the master worktree, pairmarket-devstack-<worktree>
                                elsewhere)
  PAIRMARKET_DEVSTACK_DIR       Override state dir (default: .devstack)
  PAIRMARKET_WEB_ENV_FILE       Override web env path (default: apps/web/.env.local)
  SUI_DEVSTACK_RPC_PORT         Override local RPC port (otherwise generated)
  SUI_DEVSTACK_FAUCET_PORT      Override local faucet port (otherwise generated)
  SUI_DEVSTACK_GRAPHQL_PORT     Override local GraphQL port (otherwise generated)
  PAIRMARKET_DEVSTACK_PORT_RANGE_START  First generated port (default: 20000)
  PAIRMARKET_DEVSTACK_PORT_RANGE_END    Last generated port (default: 29999)
  SUI_RPC_PORT                  Legacy alias for SUI_DEVSTACK_RPC_PORT
  SUI_FAUCET_PORT               Legacy alias for SUI_DEVSTACK_FAUCET_PORT
  SUI_GRAPHQL_PORT              Legacy alias for SUI_DEVSTACK_GRAPHQL_PORT
  PAIRMARKET_PUBLISH_GAS_BUDGET Override publish gas budget
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    err "Run through Nix, e.g. nix develop --command pnpm devstack:up"
    exit 1
  fi
}

find_sui_devstack_script() {
  if [[ -n "$SUI_DEVSTACK_SCRIPT" ]]; then
    printf '%s\n' "$SUI_DEVSTACK_SCRIPT"
    return 0
  fi

  if [[ -n "$SUI_DEVSTACK_HOME" ]]; then
    printf '%s\n' "$SUI_DEVSTACK_HOME/localnet/sui-localnet.sh"
    return 0
  fi

  local candidate
  for candidate in \
    "$PROJECT_ROOT/../../../sui-devstack/agent/sui-173-localnet/localnet/sui-localnet.sh" \
    "$PROJECT_ROOT/../../../sui-devstack/master/localnet/sui-localnet.sh" \
    "$PROJECT_ROOT/../../../sui-devstack/agent/consumer-contract/localnet/sui-localnet.sh" \
    "$HOME/Projects/sui-devstack/agent/sui-173-localnet/localnet/sui-localnet.sh" \
    "$HOME/Projects/sui-devstack/master/localnet/sui-localnet.sh"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '%s\n' "$PROJECT_ROOT/../../../sui-devstack/master/localnet/sui-localnet.sh"
}

sui_devstack_script() {
  local script
  script="$(find_sui_devstack_script)"
  if [[ ! -x "$script" ]]; then
    err "Missing executable sui-devstack localnet wrapper: $script"
    err "Set SUI_DEVSTACK_HOME to a checkout that provides localnet/sui-localnet.sh."
    exit 1
  fi
  printf '%s\n' "$script"
}

is_valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( "$1" >= 1 && "$1" <= 65535 ))
}

require_valid_port() {
  local name="$1"
  local value="$2"
  if ! is_valid_port "$value"; then
    err "$name must be a TCP port in the range 1-65535; got '$value'"
    exit 1
  fi
}

load_persisted_ports() {
  [[ -f "$PORT_ENV_FILE" ]] || return 0

  local line key value
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -n "$line" && "${line:0:1}" != "#" && "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      SUI_DEVSTACK_RPC_PORT)
        if [[ -z "${SUI_DEVSTACK_RPC_PORT:-}" ]]; then
          SUI_DEVSTACK_RPC_PORT="$value"
        fi
        ;;
      SUI_DEVSTACK_FAUCET_PORT)
        if [[ -z "${SUI_DEVSTACK_FAUCET_PORT:-}" ]]; then
          SUI_DEVSTACK_FAUCET_PORT="$value"
        fi
        ;;
      SUI_DEVSTACK_GRAPHQL_PORT)
        if [[ -z "${SUI_DEVSTACK_GRAPHQL_PORT:-}" ]]; then
          SUI_DEVSTACK_GRAPHQL_PORT="$value"
        fi
        ;;
    esac
  done < "$PORT_ENV_FILE"
}

select_free_ports() {
  require_cmd node
  node - "$PORT_RANGE_START" "$PORT_RANGE_END" "$@" <<'NODE'
const net = require("node:net");

const rangeStart = Number(process.argv[2]);
const rangeEnd = Number(process.argv[3]);
const excludes = new Set(["9000", "9123", "9125", ...process.argv.slice(4)]);
const servers = [];
const ports = [];

if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < 1024 || rangeEnd > 65535 || rangeStart > rangeEnd) {
  throw new Error(`invalid generated port range ${process.argv[2]}-${process.argv[3]}`);
}

function candidate(attempt) {
  const width = rangeEnd - rangeStart + 1;
  return rangeStart + ((Math.floor(Math.random() * width) + attempt) % width);
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

(async () => {
  const maxAttempts = Math.max(100, (rangeEnd - rangeStart + 1) * 2);
  for (let attempts = 0; ports.length < 3 && attempts < maxAttempts; attempts += 1) {
    const port = String(candidate(attempts));
    if (excludes.has(port)) {
      continue;
    }
    try {
      const server = await listen(Number(port));
      excludes.add(port);
      ports.push(port);
      servers.push(server);
    } catch {
      excludes.add(port);
    }
  }

  if (ports.length !== 3) {
    throw new Error("unable to allocate three free local ports");
  }

  process.stdout.write(`${ports.join(" ")}\n`);
  await Promise.all(servers.map(close));
})().catch(async (error) => {
  await Promise.all(servers.map(close));
  console.error(error.message);
  process.exit(1);
});
NODE
}

assert_ports_available() {
  require_cmd node
  node - "$@" <<'NODE'
const net = require("node:net");

const ports = process.argv.slice(2);
const servers = [];

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`port ${port} is not available: ${error.message}`));
    });
    server.listen({ host: "0.0.0.0", port: Number(port), exclusive: true }, () => {
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

(async () => {
  for (const port of ports) {
    servers.push(await listen(port));
  }
  await Promise.all(servers.map(close));
})().catch(async (error) => {
  await Promise.all(servers.map(close));
  console.error(error.message);
  process.exit(1);
});
NODE
}

persist_ports() {
  mkdir -p "$STATE_DIR"
  cat > "$PORT_ENV_FILE" <<EOF
SUI_DEVSTACK_RPC_PORT=$SUI_DEVSTACK_RPC_PORT
SUI_DEVSTACK_FAUCET_PORT=$SUI_DEVSTACK_FAUCET_PORT
SUI_DEVSTACK_GRAPHQL_PORT=$SUI_DEVSTACK_GRAPHQL_PORT
EOF
}

ensure_devstack_ports() {
  if [[ -n "${SUI_RPC_PORT:-}" && -z "${SUI_DEVSTACK_RPC_PORT:-}" ]]; then
    export SUI_DEVSTACK_RPC_PORT="$SUI_RPC_PORT"
  fi
  if [[ -n "${SUI_FAUCET_PORT:-}" && -z "${SUI_DEVSTACK_FAUCET_PORT:-}" ]]; then
    export SUI_DEVSTACK_FAUCET_PORT="$SUI_FAUCET_PORT"
  fi
  if [[ -n "${SUI_GRAPHQL_PORT:-}" && -z "${SUI_DEVSTACK_GRAPHQL_PORT:-}" ]]; then
    export SUI_DEVSTACK_GRAPHQL_PORT="$SUI_GRAPHQL_PORT"
  fi

  load_persisted_ports

  local existing=()
  [[ -n "${SUI_DEVSTACK_RPC_PORT:-}" ]] && existing+=("$SUI_DEVSTACK_RPC_PORT")
  [[ -n "${SUI_DEVSTACK_FAUCET_PORT:-}" ]] && existing+=("$SUI_DEVSTACK_FAUCET_PORT")
  [[ -n "${SUI_DEVSTACK_GRAPHQL_PORT:-}" ]] && existing+=("$SUI_DEVSTACK_GRAPHQL_PORT")

  if [[ -z "${SUI_DEVSTACK_RPC_PORT:-}" || -z "${SUI_DEVSTACK_FAUCET_PORT:-}" || -z "${SUI_DEVSTACK_GRAPHQL_PORT:-}" ]]; then
    local generated
    local generated_text
    if (( ${#existing[@]} > 0 )); then
      generated_text="$(select_free_ports "${existing[@]}")"
    else
      generated_text="$(select_free_ports)"
    fi
    read -r -a generated <<< "$generated_text"
    if [[ -z "${SUI_DEVSTACK_RPC_PORT:-}" ]]; then
      SUI_DEVSTACK_RPC_PORT="${generated[0]}"
    fi
    if [[ -z "${SUI_DEVSTACK_FAUCET_PORT:-}" ]]; then
      SUI_DEVSTACK_FAUCET_PORT="${generated[1]}"
    fi
    if [[ -z "${SUI_DEVSTACK_GRAPHQL_PORT:-}" ]]; then
      SUI_DEVSTACK_GRAPHQL_PORT="${generated[2]}"
    fi
  fi

  require_valid_port SUI_DEVSTACK_RPC_PORT "$SUI_DEVSTACK_RPC_PORT"
  require_valid_port SUI_DEVSTACK_FAUCET_PORT "$SUI_DEVSTACK_FAUCET_PORT"
  require_valid_port SUI_DEVSTACK_GRAPHQL_PORT "$SUI_DEVSTACK_GRAPHQL_PORT"

  export SUI_DEVSTACK_RPC_PORT
  export SUI_DEVSTACK_FAUCET_PORT
  export SUI_DEVSTACK_GRAPHQL_PORT
  persist_ports
}

sui_stack_running() {
  "$(sui_devstack_script)" status 2>/dev/null | grep -q 'state=running'
}

preflight_devstack_ports() {
  if sui_stack_running; then
    return 0
  fi
  if ! assert_ports_available "$SUI_DEVSTACK_RPC_PORT" "$SUI_DEVSTACK_FAUCET_PORT" "$SUI_DEVSTACK_GRAPHQL_PORT"; then
    err "Selected Sui localnet ports are already in use:"
    err "  RPC:     $SUI_DEVSTACK_RPC_PORT"
    err "  Faucet:  $SUI_DEVSTACK_FAUCET_PORT"
    err "  GraphQL: $SUI_DEVSTACK_GRAPHQL_PORT"
    err "Set SUI_DEVSTACK_{RPC,FAUCET,GRAPHQL}_PORT to free ports, or delete $PORT_ENV_FILE so the next 'up' generates a fresh set."
    exit 1
  fi
}

with_sui_devstack_env() {
  export SUI_DEVSTACK_COMPOSE_PROJECT="${SUI_DEVSTACK_COMPOSE_PROJECT:-$(default_compose_project)}"
  export SUI_DEVSTACK_STATE_DIR="${SUI_DEVSTACK_STATE_DIR:-$STATE_DIR/sui-localnet/state}"
  export SUI_DEVSTACK_LOGS_DIR="${SUI_DEVSTACK_LOGS_DIR:-$STATE_DIR/sui-localnet/logs}"

  case "${1:-}" in
    purge)
      # Nothing survives a purge, so do not allocate or persist ports:
      # persist_ports would recreate the state dir we are about to remove,
      # and compose does not need the port values to tear a project down.
      ;;
    up)
      ensure_devstack_ports
      preflight_devstack_ports
      ;;
    *)
      ensure_devstack_ports
      ;;
  esac

  "$(sui_devstack_script)" "$@"
}

load_sui_env() {
  local line key value
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -n "$line" && "${line:0:1}" != "#" ]] || continue
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    fi
    case "$key" in
      SUI_RPC_URL) SUI_RPC_URL="$value" ;;
      SUI_FAUCET_URL) SUI_FAUCET_URL="$value" ;;
      SUI_GRAPHQL_URL) SUI_GRAPHQL_URL="$value" ;;
    esac
  done < <(with_sui_devstack_env env)

  : "${SUI_RPC_URL:?sui-devstack env did not include SUI_RPC_URL}"
  : "${SUI_FAUCET_URL:?sui-devstack env did not include SUI_FAUCET_URL}"
  : "${SUI_GRAPHQL_URL:?sui-devstack env did not include SUI_GRAPHQL_URL}"
}

ensure_dirs() {
  mkdir -p "$STATE_DIR" "$CLIENT_DIR"
}

json_field() {
  local file="$1"
  local expr="$2"

  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const expr = process.argv[2];
    const raw = fs.readFileSync(file, "utf8");
    const start = raw.indexOf("{");
    if (start === -1) process.exit(2);
    const data = JSON.parse(raw.slice(start));
    const value = Function("data", `return (${expr});`)(data);
    if (value === undefined || value === null || value === "") process.exit(3);
    process.stdout.write(String(value));
  ' "$file" "$expr"
}

client() {
  sui client --client.config "$CLIENT_CONFIG" "$@"
}

deployer_address() {
  json_field "$ADDRESS_JSON" 'data.address'
}

configure_client_local_env() {
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const rpc = process.argv[2];
    let text = fs.readFileSync(file, "utf8");
    const localEnv = `  - alias: local\n    rpc: "${rpc}"\n    ws: ~\n    basic_auth: ~`;
    if (text.includes("  - alias: local\n")) {
      text = text.replace(
        /  - alias: local\n    rpc: "[^"]+"\n    ws: ~\n    basic_auth: ~/,
        localEnv,
      );
    } else {
      text = text.replace(/\nactive_env:/, `\n${localEnv}\nactive_env:`);
    }
    fs.writeFileSync(file, text);
  ' "$CLIENT_CONFIG" "$SUI_RPC_URL"
}

ensure_client() {
  require_cmd node
  require_cmd sui
  ensure_dirs
  load_sui_env

  if [[ ! -f "$ADDRESS_JSON" ]]; then
    log "Creating isolated local deployer key"
    rm -f "$CLIENT_DIR/deployer-address.raw"
    # shellcheck disable=SC2016
    client -y new-address ed25519 pairmarket-deployer --json | node -e '
      const fs = require("node:fs");
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        const start = raw.lastIndexOf("{");
        if (start === -1) throw new Error("missing address JSON");
        const parsed = JSON.parse(raw.slice(start));
        fs.writeFileSync(process.argv[1], `${JSON.stringify(parsed, null, 2)}\n`, {
          mode: 0o600,
        });
      });
    ' "$ADDRESS_JSON"
    chmod 600 "$ADDRESS_JSON"
    chmod 600 "$CLIENT_DIR/sui.keystore" 2>/dev/null || true
  fi

  configure_client_local_env
  client switch --env local --address "$(deployer_address)" >/dev/null
}

fund_deployer() {
  local address
  address="$(deployer_address)"
  log "Funding deployer $address from $SUI_FAUCET_URL"

  for _ in $(seq 1 30); do
    if client faucet --address "$address" --url "$SUI_FAUCET_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  err "Unable to fund deployer from faucet"
  return 1
}

prepare_client_env() {
  ensure_client
  fund_deployer
  write_env_file
}

publish_contracts() {
  require_cmd node
  require_cmd sui
  ensure_client
  fund_deployer

  log "Publishing contracts/pairmarket to localnet"
  rm -f "$PUBLISH_JSON"
  rm -rf "$PUBLISH_WORKDIR"
  mkdir -p "$PUBLISH_WORKDIR"
  cp -R "$PROJECT_ROOT/contracts/pairmarket" "$PUBLISH_WORKDIR/pairmarket"
  rm -rf "$PUBLISH_WORKDIR/pairmarket/build" "$PUBLISH_WORKDIR/pairmarket/Move.lock"

  rm -f "$PUBFILE"
  if ! client test-publish "$PUBLISH_WORKDIR/pairmarket" \
    --pubfile-path "$PUBFILE" \
    --build-env local \
    --skip-dependency-verification \
    --gas-budget "$PUBLISH_GAS_BUDGET" \
    --json > "$PUBLISH_JSON" 2>&1; then
    err "Package publish failed; captured output is in $PUBLISH_JSON"
    err "Local package publish needs a localnet runtime compatible with the repo's Sui 1.73 toolchain."
    return 1
  fi

  local package_id
  local config_id
  local admin_cap_id
  package_id="$(json_field "$PUBLISH_JSON" 'data.objectChanges.find((change) => change.type === "published")?.packageId')"
  config_id="$(json_field "$PUBLISH_JSON" 'data.objectChanges.find((change) => change.type === "created" && change.objectType?.endsWith("::market::Config") && change.owner && typeof change.owner === "object" && "Shared" in change.owner)?.objectId')"
  admin_cap_id="$(json_field "$PUBLISH_JSON" 'data.objectChanges.find((change) => change.type === "created" && change.objectType?.endsWith("::market::AdminCap"))?.objectId')"
  printf '%s\n' "$package_id" > "$PACKAGE_ID_FILE"
  printf '%s\n' "$config_id" > "$CONFIG_ID_FILE"
  printf '%s\n' "$admin_cap_id" > "$ADMIN_CAP_ID_FILE"

  write_env_file
  log "Published pairmarket package: $package_id"
  log "Published pairmarket config: $config_id"
}

write_env_file() {
  load_sui_env

  local package_id=""
  local config_id=""
  local admin_cap_id=""
  if [[ -f "$PACKAGE_ID_FILE" ]]; then
    package_id="$(cat "$PACKAGE_ID_FILE")"
  fi
  if [[ -f "$CONFIG_ID_FILE" ]]; then
    config_id="$(cat "$CONFIG_ID_FILE")"
  fi
  if [[ -f "$ADMIN_CAP_ID_FILE" ]]; then
    admin_cap_id="$(cat "$ADMIN_CAP_ID_FILE")"
  fi

  cat > "$LOCAL_ENV_FILE" <<EOF
PAIRMARKET_NETWORK=localnet
PAIRMARKET_SUI_RPC_URL=$SUI_RPC_URL
PAIRMARKET_SUI_FAUCET_URL=$SUI_FAUCET_URL
PAIRMARKET_SUI_GRAPHQL_URL=$SUI_GRAPHQL_URL
PAIRMARKET_SUI_CLIENT_CONFIG=$CLIENT_CONFIG
PAIRMARKET_SUI_DEPLOYER_ADDRESS=$(deployer_address 2>/dev/null || true)
PAIRMARKET_MOVE_PACKAGE_ID=$package_id
PAIRMARKET_MOVE_CONFIG_ID=$config_id
PAIRMARKET_MOVE_ADMIN_CAP_ID=$admin_cap_id
PAIRMARKET_WALRUS_MODE=not-yet-local
PAIRMARKET_SEAL_MODE=not-yet-local
EOF

  cat > "$WEB_ENV_FILE" <<EOF
VITE_PAIRMARKET_NETWORK=localnet
VITE_PAIRMARKET_SUI_RPC_URL=/sui-rpc
VITE_PAIRMARKET_SUI_FAUCET_URL=/sui-faucet
VITE_PAIRMARKET_DEVSTACK_RPC_TARGET=$SUI_RPC_URL
VITE_PAIRMARKET_DEVSTACK_FAUCET_TARGET=$SUI_FAUCET_URL
VITE_PAIRMARKET_MOVE_PACKAGE_ID=$package_id
VITE_PAIRMARKET_MOVE_CONFIG_ID=$config_id
VITE_PAIRMARKET_ENABLE_BURNER=0
EOF
}

show_pairmarket_status() {
  printf 'pairmarket_state_dir=%s\n' "$STATE_DIR"
  printf 'pairmarket_env_file=%s\n' "$LOCAL_ENV_FILE"
  if [[ -f "$ADDRESS_JSON" ]]; then
    printf 'pairmarket_deployer_address=%s\n' "$(deployer_address)"
  else
    printf 'pairmarket_deployer_address=not_created\n'
  fi

  if [[ -f "$PACKAGE_ID_FILE" ]]; then
    printf 'pairmarket_package_id=%s\n' "$(cat "$PACKAGE_ID_FILE")"
  else
    printf 'pairmarket_package_id=not_deployed\n'
  fi
  if [[ -f "$CONFIG_ID_FILE" ]]; then
    printf 'pairmarket_config_id=%s\n' "$(cat "$CONFIG_ID_FILE")"
  else
    printf 'pairmarket_config_id=not_deployed\n'
  fi
  if [[ -f "$WEB_ENV_FILE" ]]; then
    printf 'pairmarket_web_env_file=%s\n' "$WEB_ENV_FILE"
  else
    printf 'pairmarket_web_env_file=not_written\n'
  fi
}

# reset: drop everything bound to the chain upstream just destroyed. The
# package/config/admin-cap IDs, Published.localnet.toml and the publish
# output name objects on that chain and would dangle; the env files embed
# them. Keep the deployer key (sui-client/) and the generated ports: neither
# references a chain object, `up` re-funds the same address from the fresh
# faucet, and stable ports keep other shells' env valid across a reset.
reset_pairmarket_state() {
  log "Removing pairmarket chain-bound state from $STATE_DIR (keeping sui-client/ and ports.env)"
  rm -rf "$PUBLISH_WORKDIR"
  rm -f "$PUBLISH_JSON" "$PUBFILE" "$PACKAGE_ID_FILE" "$CONFIG_ID_FILE" "$ADMIN_CAP_ID_FILE" "$LOCAL_ENV_FILE" "$WEB_ENV_FILE"
}

# --- deletion targets ----------------------------------------------------
#
# reset and purge delete things, and purge hands a whole tree to upstream,
# which may finish the job as root. Every prospective target therefore goes
# through bounded_target before any teardown:
#
# - it is resolved lexically first (GNU realpath -sm: absolute, `.` and
#   trailing slashes dropped, symlinks NOT followed) so that the symlink
#   check looks at the final component itself and cannot be dodged with
#   `link/` or `link/.`;
# - the final component must not be a symlink;
# - then it is canonicalized with missing components allowed (GNU
#   readlink -m), so a path that does not exist yet is still pinned to a
#   real location, and the result must lie strictly inside this checkout
#   (or inside the state root, for the web env file);
# - the canonical path is what gets used and passed upstream, so what was
#   validated is what is deleted, whichever directory this was invoked from.
#
# Missing GNU realpath/readlink is a refusal, never a fallback to the raw
# string. This defends against accidents (a mistyped or inherited variable,
# an off-by-one `..`), which is the threat here; the caller already has the
# user's privileges.

canonical_path_m() {
  local p
  p="$(readlink -m -- "$1" 2>/dev/null)" || return 1
  [[ -n "$p" ]] || return 1
  printf '%s\n' "$p"
}

lexical_path() {
  local p
  p="$(realpath -sm -- "$1" 2>/dev/null)" || return 1
  [[ -n "$p" ]] || return 1
  printf '%s\n' "$p"
}

# bounded_target WHAT RAW [ALSO]: print the canonical form of RAW, or exit 1
# with a message naming WHAT. ALSO is an extra canonical directory the
# target may live under besides the checkout.
bounded_target() {
  local what="$1" raw="$2" also="${3:-}" root lexical canon
  root="$(canonical_path_m "$PROJECT_ROOT")" || { err "Cannot canonicalize $PROJECT_ROOT"; exit 1; }
  if ! lexical="$(lexical_path "$raw")"; then
    err "Refusing to touch $what ($raw): cannot resolve it (GNU realpath required)."
    exit 1
  fi
  if [[ -L "$lexical" ]]; then
    err "Refusing to touch $what ($raw): it is a symlink. Remove the link and its target yourself."
    exit 1
  fi
  if ! canon="$(canonical_path_m "$lexical")"; then
    err "Refusing to touch $what ($raw): cannot canonicalize it (GNU readlink required)."
    exit 1
  fi
  if [[ "$canon" == "$root"/* ]]; then
    printf '%s\n' "$canon"
    return 0
  fi
  if [[ -n "$also" && "$canon" == "$also"/* ]]; then
    printf '%s\n' "$canon"
    return 0
  fi
  err "Refusing to touch $what ($raw): it resolves to $canon, outside this checkout ($root)."
  exit 1
}

# Pin every path reset/purge will delete or hand upstream: the state root,
# the web env file, and any SUI_DEVSTACK_STATE_DIR / SUI_DEVSTACK_LOGS_DIR
# the caller exported (upstream deletes those too). Rewrites the globals to
# their canonical forms.
bound_teardown_targets() {
  STATE_DIR="$(bounded_target PAIRMARKET_DEVSTACK_DIR "$STATE_DIR")" || exit 1
  WEB_ENV_FILE="$(bounded_target PAIRMARKET_WEB_ENV_FILE "$WEB_ENV_FILE" "$STATE_DIR")" || exit 1
  if [[ -n "${SUI_DEVSTACK_STATE_DIR:-}" ]]; then
    SUI_DEVSTACK_STATE_DIR="$(bounded_target SUI_DEVSTACK_STATE_DIR "$SUI_DEVSTACK_STATE_DIR")" || exit 1
    export SUI_DEVSTACK_STATE_DIR
  fi
  if [[ -n "${SUI_DEVSTACK_LOGS_DIR:-}" ]]; then
    SUI_DEVSTACK_LOGS_DIR="$(bounded_target SUI_DEVSTACK_LOGS_DIR "$SUI_DEVSTACK_LOGS_DIR")" || exit 1
    export SUI_DEVSTACK_LOGS_DIR
  fi
  # Derived paths follow the (possibly rewritten) state root.
  PUBLISH_WORKDIR="$STATE_DIR/publish-workdir"
  PUBLISH_JSON="$STATE_DIR/publish-output.json"
  PUBFILE="$STATE_DIR/Published.localnet.toml"
  PACKAGE_ID_FILE="$STATE_DIR/package-id.txt"
  CONFIG_ID_FILE="$STATE_DIR/config-id.txt"
  ADMIN_CAP_ID_FILE="$STATE_DIR/admin-cap-id.txt"
  LOCAL_ENV_FILE="$STATE_DIR/pairmarket-local.env"
  PORT_ENV_FILE="$STATE_DIR/ports.env"
}

# purge: nothing survives. The whole state root goes to upstream purge as an
# extra directory so it is removed by the same root-owned-safe helper that
# handles the chain state living inside it: a plain rm would stop at any
# file the Sui container left owned by uid 0, and would miss state left
# under an older layout. The web env file lives outside the state root and
# is removed here, only once upstream has succeeded.
purge_pairmarket_state() {
  local script help status=0
  script="$(sui_devstack_script)"
  bound_teardown_targets
  # The upstream wrapper only grew `purge` recently; probe its usage text so
  # an older checkout fails with a pointer instead of a bare usage dump.
  # Capture first, then inspect: `grep -q` on a pipe can SIGPIPE the producer
  # and, under pipefail, misreport a good upstream as old.
  help="$("$script" --help 2>/dev/null)" || help=""
  if ! grep -qE '^[[:space:]]+purge[[:space:]]' <<<"$help"; then
    err "The sui-devstack wrapper at $script has no 'purge' command."
    err "Update that checkout (sui-devstack master with PR #4) or point SUI_DEVSTACK_HOME at one that has it."
    exit 1
  fi
  # Run upstream from the checkout root so its own "under \$PWD" rule lines
  # up with the bounds checked above, whichever directory this was invoked
  # from. STATE_DIR is canonical and absolute here, so the cd cannot change
  # what it names.
  (cd "$PROJECT_ROOT" && with_sui_devstack_env purge "$STATE_DIR") || status=$?
  if (( status != 0 )); then
    err "Upstream purge exited $status; leaving $WEB_ENV_FILE in place. Deal with what it reported, then run purge again."
    return "$status"
  fi
  log "Removing $WEB_ENV_FILE"
  rm -f -- "$WEB_ENV_FILE" || { err "Could not remove $WEB_ENV_FILE"; return 1; }
}

# Default compose project: `pairmarket-devstack` for the master worktree,
# `pairmarket-devstack-<worktree>` elsewhere, so two worktrees' stacks (and
# their pgdata volumes) do not share a project and one worktree's
# down/reset/purge cannot tear down another's. SUI_DEVSTACK_COMPOSE_PROJECT
# overrides it.
default_compose_project() {
  local base
  base="$(basename -- "$PROJECT_ROOT")"
  case "$base" in
    master|main) printf 'pairmarket-devstack\n' ;;
    *)
      base="${base#pairmarket-}"
      base="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"
      printf 'pairmarket-devstack-%s\n' "${base:-worktree}"
      ;;
  esac
}

case "${1:-}" in
  up)
    with_sui_devstack_env up
    prepare_client_env
    with_sui_devstack_env status
    show_pairmarket_status
    ;;
  deploy)
    publish_contracts
    show_pairmarket_status
    ;;
  status)
    with_sui_devstack_env status
    show_pairmarket_status
    ;;
  logs)
    shift
    with_sui_devstack_env logs "$@"
    ;;
  env)
    if [[ ! -f "$LOCAL_ENV_FILE" ]]; then
      err "No local env file found. Run scripts/devstack.sh up first."
      exit 1
    fi
    cat "$LOCAL_ENV_FILE"
    ;;
  down)
    with_sui_devstack_env down
    ;;
  reset)
    bound_teardown_targets
    with_sui_devstack_env reset
    reset_pairmarket_state
    ;;
  purge)
    purge_pairmarket_state
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
