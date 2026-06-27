#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${PAIRMARKET_DEVSTACK_DIR:-$PROJECT_ROOT/.devstack}"
SUI_STATE_DIR="$STATE_DIR/sui-network"
CLIENT_DIR="$STATE_DIR/sui-client"
CLIENT_CONFIG="$CLIENT_DIR/client.yaml"
ADDRESS_JSON="$CLIENT_DIR/deployer-address.json"
LOCAL_ENV_FILE="$STATE_DIR/pairmarket-local.env"
PUBLISH_JSON="$STATE_DIR/publish-output.json"
PID_FILE="$STATE_DIR/sui-localnet.pid"
LOG_FILE="$STATE_DIR/sui-localnet.log"
PUBFILE="$STATE_DIR/Published.localnet.toml"
PACKAGE_ID_FILE="$STATE_DIR/package-id.txt"
PUBLISH_WORKDIR="$STATE_DIR/publish-workdir"
COMPOSE_FILE="$PROJECT_ROOT/deploy/docker-compose.localnet.yml"
COMPOSE_PROJECT="${PAIRMARKET_COMPOSE_PROJECT:-pairmarket-devstack}"
BACKEND="${PAIRMARKET_DEVSTACK_BACKEND:-docker}"

RPC_HOST="${SUI_RPC_HOST:-127.0.0.1}"
RPC_PORT="${SUI_RPC_PORT:-9000}"
FAUCET_HOST="${SUI_FAUCET_HOST:-127.0.0.1}"
FAUCET_PORT="${SUI_FAUCET_PORT:-9123}"
SUI_RPC_URL="${SUI_RPC_URL:-http://$RPC_HOST:$RPC_PORT}"
SUI_FAUCET_URL="${SUI_FAUCET_URL:-http://$FAUCET_HOST:$FAUCET_PORT/gas}"
PUBLISH_GAS_BUDGET="${PAIRMARKET_PUBLISH_GAS_BUDGET:-1000000000}"

log() { printf '[devstack] %s\n' "$*"; }
err() { printf '[devstack][ERROR] %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: scripts/devstack.sh <command>

Commands:
  up       Start Sui Localnet and create/fund the isolated deployer
  deploy   Publish pairmarket to a running Localnet
  status   Show localnet, deployer, and package status
  logs     Tail the Sui Localnet log
  env      Print the generated environment file
  down     Stop Sui Localnet, preserving state
  reset    Stop Sui Localnet and remove .devstack state

Environment:
  PAIRMARKET_DEVSTACK_DIR       Override state dir (default: .devstack)
  PAIRMARKET_DEVSTACK_BACKEND   docker or native (default: docker)
  SUI_RPC_PORT / SUI_FAUCET_PORT Override local ports
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

ensure_dirs() {
  mkdir -p "$STATE_DIR" "$SUI_STATE_DIR" "$CLIENT_DIR"
}

json_field() {
  local file="$1"
  local expr="$2"

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

native_is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
}

docker_is_running() {
  require_cmd docker
  local id
  id="$(compose ps -q sui-localnet 2>/dev/null || true)"
  [[ -n "$id" ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null || true)" == "true" ]]
}

is_running() {
  case "$BACKEND" in
    docker) docker_is_running ;;
    native) native_is_running ;;
    *)
      err "Unknown PAIRMARKET_DEVSTACK_BACKEND: $BACKEND"
      exit 2
      ;;
  esac
}

rpc_ready() {
  curl -fsS --max-time 2 \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"sui_getLatestCheckpointSequenceNumber","params":[]}' \
    "$SUI_RPC_URL" >/dev/null 2>&1
}

wait_for_rpc() {
  local timeout="${1:-90}"
  local elapsed=0

  while [[ "$elapsed" -lt "$timeout" ]]; do
    if rpc_ready; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  err "Sui RPC did not become ready at $SUI_RPC_URL within ${timeout}s"
  tail -80 "$LOG_FILE" >&2 || true
  return 1
}

client() {
  sui client --client.config "$CLIENT_CONFIG" "$@"
}

deployer_address() {
  json_field "$ADDRESS_JSON" 'data.address'
}

configure_client_local_env() {
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
  ensure_dirs

  if [[ ! -f "$ADDRESS_JSON" ]]; then
    log "Creating isolated local deployer key"
    local raw_address="$CLIENT_DIR/deployer-address.raw"
    client -y new-address ed25519 pairmarket-deployer --json > "$raw_address"
    node -e '
      const fs = require("node:fs");
      const raw = fs.readFileSync(process.argv[1], "utf8");
      const start = raw.lastIndexOf("{");
      if (start === -1) throw new Error("missing address JSON");
      const parsed = JSON.parse(raw.slice(start));
      fs.writeFileSync(process.argv[2], `${JSON.stringify(parsed, null, 2)}\n`);
    ' "$raw_address" "$ADDRESS_JSON"
    chmod 600 "$ADDRESS_JSON"
  fi

  configure_client_local_env
  client switch --env local --address "$(deployer_address)" >/dev/null
}

fund_deployer() {
  local address
  address="$(deployer_address)"
  log "Funding deployer $address from $SUI_FAUCET_URL"

  for _ in $(seq 1 8); do
    if client faucet --address "$address" --url "$SUI_FAUCET_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  err "Unable to fund deployer from faucet"
  return 1
}

start_localnet() {
  require_cmd curl
  ensure_dirs

  if is_running && rpc_ready; then
    log "Sui Localnet already running at $SUI_RPC_URL"
    return 0
  fi

  if is_running; then
    log "Removing stale PID for unresponsive localnet"
    rm -f "$PID_FILE"
  fi

  log "Starting Sui Localnet ($BACKEND backend)"
  log "  RPC:    $SUI_RPC_URL"
  log "  Faucet: $SUI_FAUCET_URL"
  log "  State:  $SUI_STATE_DIR"

  case "$BACKEND" in
    docker)
      require_cmd docker
      export LOCAL_UID="${LOCAL_UID:-$(id -u)}"
      export LOCAL_GID="${LOCAL_GID:-$(id -g)}"
      export SUI_RPC_PORT="$RPC_PORT"
      export SUI_FAUCET_PORT="$FAUCET_PORT"
      export PAIRMARKET_DOCKER_LOGS_DIR="$STATE_DIR/docker/logs"
      export PAIRMARKET_DOCKER_STATE_DIR="$STATE_DIR/docker/sui-state"
      mkdir -p "$PAIRMARKET_DOCKER_LOGS_DIR" "$PAIRMARKET_DOCKER_STATE_DIR"
      compose up -d
      ;;
    native)
      require_cmd sui
      log "  Log:    $LOG_FILE"
      if [[ ! -f "$SUI_STATE_DIR/network.yaml" ]]; then
        log "Generating Sui Localnet genesis config"
        sui genesis --working-dir "$SUI_STATE_DIR" --with-faucet --force >> "$LOG_FILE" 2>&1
      fi

      nohup sui start \
        --network.config "$SUI_STATE_DIR" \
        --fullnode-rpc-port "$RPC_PORT" \
        --with-faucet="$FAUCET_HOST:$FAUCET_PORT" \
        > "$LOG_FILE" 2>&1 &
      echo "$!" > "$PID_FILE"
      ;;
  esac

  wait_for_rpc 120
}

publish_contracts() {
  require_cmd sui
  require_cmd node
  wait_for_rpc 30
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
    --json > "$PUBLISH_JSON"; then
    err "Package publish failed; captured output is in $PUBLISH_JSON"
    if [[ "$BACKEND" == "docker" ]]; then
      err "The default Docker localnet is Sui 1.67.3; pairmarket publish compatibility is tracked by pm-local-devstack-sui-173-runtime."
    fi
    return 1
  fi

  local package_id
  package_id="$(json_field "$PUBLISH_JSON" 'data.objectChanges.find((change) => change.type === "published")?.packageId')"
  printf '%s\n' "$package_id" > "$PACKAGE_ID_FILE"

  write_env_file
  log "Published pairmarket package: $package_id"
}

prepare_client_env() {
  wait_for_rpc 30
  ensure_client
  fund_deployer
  write_env_file
}

write_env_file() {
  local package_id=""
  if [[ -f "$PACKAGE_ID_FILE" ]]; then
    package_id="$(cat "$PACKAGE_ID_FILE")"
  fi

  cat > "$LOCAL_ENV_FILE" <<EOF
PAIRMARKET_NETWORK=localnet
PAIRMARKET_SUI_RPC_URL=$SUI_RPC_URL
PAIRMARKET_SUI_FAUCET_URL=$SUI_FAUCET_URL
PAIRMARKET_SUI_CLIENT_CONFIG=$CLIENT_CONFIG
PAIRMARKET_SUI_DEPLOYER_ADDRESS=$(deployer_address 2>/dev/null || true)
PAIRMARKET_MOVE_PACKAGE_ID=$package_id
PAIRMARKET_WALRUS_MODE=not-yet-local
PAIRMARKET_SEAL_MODE=not-yet-local
EOF
}

show_status() {
  printf 'backend=%s\n' "$BACKEND"
  printf 'state_dir=%s\n' "$STATE_DIR"
  printf 'rpc_url=%s\n' "$SUI_RPC_URL"
  printf 'faucet_url=%s\n' "$SUI_FAUCET_URL"

  if is_running; then
    if [[ "$BACKEND" == "docker" ]]; then
      printf 'localnet_process=running container=%s\n' "$(compose ps -q sui-localnet)"
    else
      printf 'localnet_process=running pid=%s\n' "$(cat "$PID_FILE")"
    fi
  else
    printf 'localnet_process=stopped\n'
  fi

  if rpc_ready; then
    printf 'rpc=ready\n'
  else
    printf 'rpc=not_ready\n'
  fi

  if [[ -f "$ADDRESS_JSON" ]]; then
    printf 'deployer_address=%s\n' "$(deployer_address)"
  fi

  if [[ -f "$PACKAGE_ID_FILE" ]]; then
    printf 'package_id=%s\n' "$(cat "$PACKAGE_ID_FILE")"
  else
    printf 'package_id=not_deployed\n'
  fi
}

stop_localnet() {
  if [[ "$BACKEND" == "docker" ]]; then
    require_cmd docker
    log "Stopping Docker devstack"
    compose down
    return 0
  fi

  if ! native_is_running; then
    log "Sui Localnet is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  log "Stopping Sui Localnet pid $pid"
  kill "$pid" >/dev/null 2>&1 || true

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 1
  done

  log "Localnet did not exit after SIGTERM; sending SIGKILL"
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
}

reset_stack() {
  stop_localnet
  log "Removing $STATE_DIR"
  if ! rm -rf "$STATE_DIR" 2>/dev/null && [[ -d "$STATE_DIR" ]]; then
    require_cmd docker
    docker run --rm -v "$STATE_DIR:/cleanup" alpine sh -c \
      'rm -rf /cleanup/* /cleanup/.[!.]* /cleanup/..?*'
    rmdir "$STATE_DIR" 2>/dev/null || true
  fi
}

case "${1:-}" in
  up)
    start_localnet
    prepare_client_env
    show_status
    ;;
  deploy)
    publish_contracts
    show_status
    ;;
  status)
    show_status
    ;;
  logs)
    if [[ "$BACKEND" == "docker" ]]; then
      compose logs -f
    else
      tail -f "$LOG_FILE"
    fi
    ;;
  env)
    if [[ ! -f "$LOCAL_ENV_FILE" ]]; then
      err "No local env file found. Run scripts/devstack.sh up first."
      exit 1
    fi
    cat "$LOCAL_ENV_FILE"
    ;;
  down)
    stop_localnet
    ;;
  reset)
    reset_stack
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
