import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Exercises the teardown ladder of scripts/devstack.sh against a fake
// upstream sui-localnet.sh (selected via SUI_DEVSTACK_SCRIPT), so no docker
// daemon is needed:
//
//   down   keeps everything
//   reset  drops chain-bound state (published IDs, publish output, env
//          files) and keeps the deployer key and generated ports
//   purge  hands the whole state root to upstream `purge` and removes the
//          web env file; nothing survives
//
// The fake upstream records every invocation and, on `purge`, removes each
// extra directory it is given, which is what the real wrapper does.

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/devstack.sh");

const PORTS = {
  SUI_DEVSTACK_RPC_PORT: "21000",
  SUI_DEVSTACK_FAUCET_PORT: "21123",
  SUI_DEVSTACK_GRAPHQL_PORT: "21125",
};

function makeFakeUpstream(dir, { supportsPurge = true } = {}) {
  const fake = join(dir, "fake-sui-localnet.sh");
  const capture = join(dir, "capture.log");
  const purgeHelp = supportsPurge
    ? "  purge    reset + remove extra directories\\n"
    : "";
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'argv=%s\\n' "$*"
  printf 'rpc=%s faucet=%s graphql=%s\\n' "\${SUI_DEVSTACK_RPC_PORT:-}" "\${SUI_DEVSTACK_FAUCET_PORT:-}" "\${SUI_DEVSTACK_GRAPHQL_PORT:-}"
  printf 'state_dir=%s\\n' "\${SUI_DEVSTACK_STATE_DIR:-}"
} >> "${capture}"

case "\${1:-}" in
  -h|--help|help)
    printf 'Usage: sui-localnet.sh <command> [args...]\\n\\nCommands:\\n'
    printf '  up       Start\\n  down     Stop\\n  reset    Reset\\n'
    printf '${purgeHelp}'
    printf '  status   Status\\n'
    ;;
  purge)
    shift
    for d in "$@"; do
      rm -r -f -- "$d"
    done
    ;;
  status)
    printf 'container=none state=stopped\\n'
    printf 'rpc=not_ready\\n'
    ;;
  env)
    printf 'SUI_RPC_URL=http://127.0.0.1:%s\\n' "\${SUI_DEVSTACK_RPC_PORT:-}"
    printf 'SUI_FAUCET_URL=http://127.0.0.1:%s/gas\\n' "\${SUI_DEVSTACK_FAUCET_PORT:-}"
    printf 'SUI_GRAPHQL_URL=http://127.0.0.1:%s/graphql\\n' "\${SUI_DEVSTACK_GRAPHQL_PORT:-}"
    ;;
  down|reset)
    ;;
  *)
    printf 'unknown command %s\\n' "\${1:-}" >&2
    exit 2
    ;;
esac
`,
  );
  chmodSync(fake, 0o700);
  return { fake, capture };
}

// A populated .devstack as `up` + `deploy` would leave it, plus the web env
// file that lives outside it.
function seedState(stateDir, webEnv) {
  const files = {
    "sui-client/client.yaml": "keystore: {}\n",
    "sui-client/sui.keystore": "[]\n",
    "sui-client/deployer-address.json": '{"address":"0xabc"}\n',
    "ports.env": Object.entries(PORTS)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
      .concat("\n"),
    "package-id.txt": "0x1\n",
    "config-id.txt": "0x2\n",
    "admin-cap-id.txt": "0x3\n",
    "Published.localnet.toml": "[published]\n",
    "publish-output.json": "{}\n",
    "publish-workdir/pairmarket/Move.toml": "[package]\n",
    "pairmarket-local.env": "PAIRMARKET_NETWORK=localnet\n",
    "sui-localnet/state/db/CURRENT": "MANIFEST\n",
    "sui-localnet/logs/sui.log": "log\n",
    "docker/sui-state/stale": "left over from an older layout\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const path = join(stateDir, relative);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  writeFileSync(webEnv, "VITE_PAIRMARKET_NETWORK=localnet\n");
}

function runDevstack(env, command) {
  return spawnSync("bash", [script, command], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function captured(capture) {
  return existsSync(capture) ? readFileSync(capture, "utf8") : "";
}

const tempDirs = [];

function scenario(name, { supportsPurge = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `pairmarket-devstack-${name}-`));
  tempDirs.push(dir);
  const stateDir = join(dir, "devstack");
  const webEnv = join(dir, "web.env.local");
  const upstream = makeFakeUpstream(dir, { supportsPurge });
  seedState(stateDir, webEnv);
  const env = {
    PAIRMARKET_DEVSTACK_DIR: stateDir,
    PAIRMARKET_WEB_ENV_FILE: webEnv,
    SUI_DEVSTACK_SCRIPT: upstream.fake,
  };
  return { stateDir, webEnv, upstream, env };
}

try {
  {
    const { stateDir, webEnv, upstream, env } = scenario("down");
    const result = runDevstack(env, "down");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(captured(upstream.capture), /^argv=down$/m);
    for (const relative of [
      "sui-client/sui.keystore",
      "ports.env",
      "package-id.txt",
      "Published.localnet.toml",
      "pairmarket-local.env",
      "sui-localnet/state/db/CURRENT",
    ]) {
      assert.ok(existsSync(join(stateDir, relative)), `down kept ${relative}`);
    }
    assert.ok(existsSync(webEnv), "down kept the web env file");
  }

  {
    const { stateDir, webEnv, upstream, env } = scenario("reset");
    const portsBefore = readFileSync(join(stateDir, "ports.env"), "utf8");
    const result = runDevstack(env, "reset");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const log = captured(upstream.capture);
    assert.match(log, /^argv=reset$/m);
    assert.match(
      log,
      /^rpc=21000 faucet=21123 graphql=21125$/m,
      "reset passes the persisted ports to upstream",
    );

    for (const relative of [
      "sui-client/client.yaml",
      "sui-client/sui.keystore",
      "sui-client/deployer-address.json",
      "ports.env",
    ]) {
      assert.ok(existsSync(join(stateDir, relative)), `reset kept ${relative}`);
    }
    assert.equal(
      readFileSync(join(stateDir, "ports.env"), "utf8"),
      portsBefore,
      "reset left ports.env untouched",
    );
    for (const relative of [
      "package-id.txt",
      "config-id.txt",
      "admin-cap-id.txt",
      "Published.localnet.toml",
      "publish-output.json",
      "publish-workdir",
      "pairmarket-local.env",
    ]) {
      assert.equal(
        existsSync(join(stateDir, relative)),
        false,
        `reset removed ${relative}`,
      );
    }
    assert.equal(existsSync(webEnv), false, "reset removed the web env file");
  }

  {
    const { stateDir, webEnv, upstream, env } = scenario("purge");
    const result = runDevstack(env, "purge");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const log = captured(upstream.capture);
    assert.match(log, /^argv=--help$/m, "purge probes upstream --help first");
    assert.match(
      log,
      new RegExp(
        `^argv=purge ${stateDir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
      "purge hands the whole state root to upstream purge",
    );
    assert.match(
      log,
      /^argv=purge .*\n^rpc= faucet= graphql=$/m,
      "purge does not allocate or load ports",
    );
    assert.equal(existsSync(stateDir), false, "purge removed the state root");
    assert.equal(existsSync(webEnv), false, "purge removed the web env file");
  }

  {
    const { stateDir, webEnv, upstream, env } = scenario("old-upstream", {
      supportsPurge: false,
    });
    const result = runDevstack(env, "purge");
    assert.notEqual(result.status, 0, "purge fails on an upstream without it");
    assert.match(result.stderr, /has no 'purge' command/);
    assert.doesNotMatch(captured(upstream.capture), /^argv=purge/m);
    assert.ok(existsSync(join(stateDir, "sui-client/sui.keystore")));
    assert.ok(existsSync(webEnv), "old upstream: web env file untouched");
  }

  {
    const { stateDir, webEnv, env } = scenario("purge-twice");
    let result = runDevstack(env, "purge");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = runDevstack(env, "purge");
    assert.equal(result.status, 0, "purge is idempotent");
    assert.equal(existsSync(stateDir), false);
    assert.equal(existsSync(webEnv), false);
  }
} finally {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}
