#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${PAIRMARKET_DEVSTACK_DIR:-$PROJECT_ROOT/.devstack}"
CLIENT_DIR="$STATE_DIR/sui-client"
CLIENT_CONFIG="$CLIENT_DIR/client.yaml"
ADDRESS_JSON="$CLIENT_DIR/deployer-address.json"
LOCAL_ENV_FILE="$STATE_DIR/pairmarket-local.env"
WEB_ENV_FILE="$PROJECT_ROOT/apps/web/.env.local"
PUBLISH_JSON="$STATE_DIR/publish-output.json"
PUBFILE="$STATE_DIR/Published.localnet.toml"
PACKAGE_ID_FILE="$STATE_DIR/package-id.txt"
CONFIG_ID_FILE="$STATE_DIR/config-id.txt"
ADMIN_CAP_ID_FILE="$STATE_DIR/admin-cap-id.txt"
PUBLISH_WORKDIR="$STATE_DIR/publish-workdir"
PUBLISH_GAS_BUDGET="${PAIRMARKET_PUBLISH_GAS_BUDGET:-1000000000}"

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
  down     Stop upstream Sui Localnet, preserving state
  reset    Stop upstream Sui Localnet and remove pairmarket local state

Environment:
  SUI_DEVSTACK_HOME             Path to sui-devstack checkout
  SUI_DEVSTACK_SCRIPT           Override path to localnet/sui-localnet.sh
  PAIRMARKET_DEVSTACK_DIR       Override state dir (default: .devstack)
  SUI_DEVSTACK_RPC_PORT         Override local RPC port
  SUI_DEVSTACK_FAUCET_PORT      Override local faucet port
  SUI_DEVSTACK_GRAPHQL_PORT     Override local GraphQL port
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
    "$PROJECT_ROOT/../../../sui-devstack/master/localnet/sui-localnet.sh" \
    "$PROJECT_ROOT/../../../sui-devstack/agent/consumer-contract/localnet/sui-localnet.sh" \
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

with_sui_devstack_env() {
  export SUI_DEVSTACK_COMPOSE_PROJECT="${SUI_DEVSTACK_COMPOSE_PROJECT:-pairmarket-devstack}"
  export SUI_DEVSTACK_STATE_DIR="${SUI_DEVSTACK_STATE_DIR:-$STATE_DIR/sui-localnet/state}"
  export SUI_DEVSTACK_LOGS_DIR="${SUI_DEVSTACK_LOGS_DIR:-$STATE_DIR/sui-localnet/logs}"

  if [[ -n "${SUI_RPC_PORT:-}" && -z "${SUI_DEVSTACK_RPC_PORT:-}" ]]; then
    export SUI_DEVSTACK_RPC_PORT="$SUI_RPC_PORT"
  fi
  if [[ -n "${SUI_FAUCET_PORT:-}" && -z "${SUI_DEVSTACK_FAUCET_PORT:-}" ]]; then
    export SUI_DEVSTACK_FAUCET_PORT="$SUI_FAUCET_PORT"
  fi
  if [[ -n "${SUI_GRAPHQL_PORT:-}" && -z "${SUI_DEVSTACK_GRAPHQL_PORT:-}" ]]; then
    export SUI_DEVSTACK_GRAPHQL_PORT="$SUI_GRAPHQL_PORT"
  fi

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

reset_pairmarket_state() {
  log "Removing pairmarket state from $STATE_DIR"
  rm -rf "$CLIENT_DIR" "$PUBLISH_JSON" "$PUBFILE" "$PACKAGE_ID_FILE" "$CONFIG_ID_FILE" "$ADMIN_CAP_ID_FILE" "$PUBLISH_WORKDIR" "$LOCAL_ENV_FILE" "$WEB_ENV_FILE"
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
    with_sui_devstack_env reset
    reset_pairmarket_state
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
