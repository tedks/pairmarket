import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
//   purge  hands the whole state root to upstream `purge` and, once that
//          succeeds, removes the web env file; nothing survives
//
// The fake upstream records every invocation (argument count plus each
// argument on its own line, so a path with spaces is distinguishable from
// two arguments) and emulates what the real wrapper deletes: on `reset`
// the configured state and logs directories, on `purge` those plus every
// extra directory it is given. FAKE_UPSTREAM_PURGE_FAIL=1 makes `purge`
// exit 1 after deleting nothing.
//
// purge only accepts a state root strictly inside the checkout, so the
// scenario directories live under the repo as .devstack-test-* (ignored by
// git) rather than under the system temp dir.

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
  printf 'call argc=%s\\n' "$#"
  for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done
  printf 'rpc=%s faucet=%s graphql=%s\\n' "\${SUI_DEVSTACK_RPC_PORT:-}" "\${SUI_DEVSTACK_FAUCET_PORT:-}" "\${SUI_DEVSTACK_GRAPHQL_PORT:-}"
  printf 'cwd=%s\\n' "$PWD"
} >> "${capture}"

remove_configured_dirs() {
  rm -r -f -- "\${SUI_DEVSTACK_STATE_DIR:?}" "\${SUI_DEVSTACK_LOGS_DIR:?}"
}

case "\${1:-}" in
  -h|--help|help)
    printf 'Usage: sui-localnet.sh <command> [args...]\\n\\nCommands:\\n'
    printf '  up       Start\\n  down     Stop\\n  reset    Reset\\n'
    printf '${purgeHelp}'
    printf '  status   Status\\n'
    ;;
  reset)
    remove_configured_dirs
    ;;
  purge)
    if [[ "\${FAKE_UPSTREAM_PURGE_FAIL:-0}" == 1 ]]; then
      echo "fake upstream: left files behind" >&2
      exit 1
    fi
    remove_configured_dirs
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
  down)
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

// Everything `up` + `deploy` leave in .devstack, a stale directory from an
// older layout that only purge should reach, and the web env file that
// lives outside the state root.
const CURRENT_CHAIN_STATE = [
  "sui-localnet/state/db/CURRENT",
  "sui-localnet/logs/sui.log",
];
const CHAIN_BOUND_FILES = [
  "package-id.txt",
  "config-id.txt",
  "admin-cap-id.txt",
  "Published.localnet.toml",
  "publish-output.json",
  "publish-workdir",
  "pairmarket-local.env",
];
const KEPT_BY_RESET = [
  "sui-client/client.yaml",
  "sui-client/sui.keystore",
  "sui-client/deployer-address.json",
  "ports.env",
];
const LEGACY_STATE = "docker/sui-state/stale";

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
    [LEGACY_STATE]: "left over from an older layout\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const path = join(stateDir, relative);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  writeFileSync(webEnv, "VITE_PAIRMARKET_NETWORK=localnet\n");
}

function runDevstack(env, command, cwd = root) {
  const result = spawnSync("bash", [script, command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  result.message = `exit ${result.status}\n${result.stderr}${result.stdout}`;
  return result;
}

function captured(capture) {
  return existsSync(capture) ? readFileSync(capture, "utf8") : "";
}

function assertAll(stateDir, relatives, expected, what) {
  for (const relative of relatives) {
    assert.equal(
      existsSync(join(stateDir, relative)),
      expected,
      `${what}: ${relative} should ${expected ? "exist" : "be gone"}`,
    );
  }
}

const cleanups = [];

function scenario(
  name,
  { supportsPurge = true, parent = root, dirName = "devstack" } = {},
) {
  const dir = mkdtempSync(join(parent, `.devstack-test-${name}-`));
  cleanups.push(dir);
  const stateDir = join(dir, dirName);
  const webEnv = join(dir, "web.env.local");
  const upstream = makeFakeUpstream(dir, { supportsPurge });
  seedState(stateDir, webEnv);
  const env = {
    PAIRMARKET_DEVSTACK_DIR: stateDir,
    PAIRMARKET_WEB_ENV_FILE: webEnv,
    SUI_DEVSTACK_SCRIPT: upstream.fake,
  };
  return { dir, stateDir, webEnv, upstream, env };
}

try {
  {
    const { stateDir, webEnv, upstream, env } = scenario("down");
    const result = runDevstack(env, "down");
    assert.equal(result.status, 0, result.message);
    assert.match(captured(upstream.capture), /^call argc=1\narg=down$/m);
    assertAll(
      stateDir,
      [
        ...KEPT_BY_RESET,
        ...CHAIN_BOUND_FILES,
        ...CURRENT_CHAIN_STATE,
        LEGACY_STATE,
      ],
      true,
      "down",
    );
    assert.ok(existsSync(webEnv), "down kept the web env file");
  }

  {
    const { stateDir, webEnv, upstream, env } = scenario("reset");
    const portsBefore = readFileSync(join(stateDir, "ports.env"), "utf8");
    const result = runDevstack(env, "reset");
    assert.equal(result.status, 0, result.message);
    const log = captured(upstream.capture);
    assert.match(log, /^call argc=1\narg=reset$/m);
    assert.match(
      log,
      /^rpc=21000 faucet=21123 graphql=21125$/m,
      "reset passes the persisted ports to upstream",
    );
    assertAll(stateDir, KEPT_BY_RESET, true, "reset");
    assert.equal(
      readFileSync(join(stateDir, "ports.env"), "utf8"),
      portsBefore,
      "reset left ports.env byte-identical",
    );
    assertAll(stateDir, CHAIN_BOUND_FILES, false, "reset");
    assertAll(stateDir, CURRENT_CHAIN_STATE, false, "reset (via upstream)");
    assert.ok(
      existsSync(join(stateDir, LEGACY_STATE)),
      "reset does not know about legacy-layout state and leaves it",
    );
    assert.equal(existsSync(webEnv), false, "reset removed the web env file");
  }

  {
    const { dir, stateDir, webEnv, upstream, env } = scenario("purge");
    // Invoke from a subdirectory: purge must still run upstream from the
    // checkout root so upstream's under-$PWD rule matches the layout.
    const result = runDevstack(env, "purge", join(root, "scripts"));
    assert.equal(result.status, 0, result.message);
    const log = captured(upstream.capture);
    assert.match(
      log,
      /^call argc=1\narg=--help$/m,
      "purge probes upstream --help first",
    );
    assert.match(
      log,
      new RegExp(
        `^call argc=2\\narg=purge\\narg=${stateDir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n` +
          `rpc= faucet= graphql=\\ncwd=${root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
      "purge hands exactly the state root to upstream purge, allocates no ports, runs from the checkout root",
    );
    assert.equal(existsSync(stateDir), false, "purge removed the state root");
    assert.equal(existsSync(webEnv), false, "purge removed the web env file");
    assert.ok(
      existsSync(dir),
      "purge removed only the state root, not its parent",
    );
  }

  {
    const { stateDir, webEnv, upstream, env } = scenario("with space", {
      dirName: "dev stack",
    });
    const result = runDevstack(env, "purge");
    assert.equal(result.status, 0, result.message);
    assert.match(
      captured(upstream.capture),
      new RegExp(
        `^call argc=2\\narg=purge\\narg=${stateDir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
      "a state root with spaces is passed as one argument",
    );
    assert.equal(existsSync(stateDir), false);
    assert.equal(existsSync(webEnv), false);
  }

  {
    const { stateDir, webEnv, upstream, env } = scenario("old-upstream", {
      supportsPurge: false,
    });
    const result = runDevstack(env, "purge");
    assert.notEqual(result.status, 0, "purge fails on an upstream without it");
    assert.match(result.stderr, /has no 'purge' command/);
    assert.doesNotMatch(captured(upstream.capture), /^arg=purge$/m);
    assertAll(stateDir, KEPT_BY_RESET, true, "old upstream");
    assert.ok(existsSync(webEnv), "old upstream: web env file untouched");
  }

  {
    const { stateDir, webEnv, upstream, env } = scenario("upstream-fails");
    const result = runDevstack(
      { ...env, FAKE_UPSTREAM_PURGE_FAIL: "1" },
      "purge",
    );
    assert.equal(result.status, 1, result.message);
    assert.match(result.stderr, /Upstream purge exited 1; leaving .* in place/);
    assert.match(
      captured(upstream.capture),
      /^arg=purge$/m,
      "upstream purge was attempted",
    );
    assert.ok(
      existsSync(webEnv),
      "web env file kept when upstream purge fails",
    );
    assertAll(
      stateDir,
      KEPT_BY_RESET,
      true,
      "upstream failure (fake deleted nothing)",
    );
  }

  {
    const { stateDir, webEnv, env } = scenario("missing-upstream");
    const result = runDevstack(
      { ...env, SUI_DEVSTACK_SCRIPT: join(stateDir, "does-not-exist.sh") },
      "purge",
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Missing executable sui-devstack localnet wrapper/,
    );
    assertAll(stateDir, KEPT_BY_RESET, true, "missing upstream");
    assert.ok(existsSync(webEnv), "missing upstream: web env file untouched");
  }

  {
    // A state root outside the checkout (here: the system temp dir) is
    // refused before upstream is called, whatever it contains.
    const outside = mkdtempSync(join(tmpdir(), "pairmarket-devstack-outside-"));
    cleanups.push(outside);
    const { upstream, env } = scenario("outside-anchor");
    const stateDir = join(outside, "devstack");
    const webEnv = join(outside, "web.env.local");
    seedState(stateDir, webEnv);
    const result = runDevstack(
      {
        ...env,
        PAIRMARKET_DEVSTACK_DIR: stateDir,
        PAIRMARKET_WEB_ENV_FILE: webEnv,
      },
      "purge",
    );
    assert.equal(result.status, 1, result.message);
    assert.match(result.stderr, /must be a directory inside this checkout/);
    assert.doesNotMatch(captured(upstream.capture), /^arg=purge$/m);
    assertAll(
      stateDir,
      [...KEPT_BY_RESET, ...CHAIN_BOUND_FILES],
      true,
      "outside checkout",
    );
    assert.ok(existsSync(webEnv));
  }

  {
    const { dir, upstream, env } = scenario("symlink-root");
    const real = join(dir, "real-devstack");
    const link = join(dir, "linked-devstack");
    mkdirSync(join(real, "sui-client"), { recursive: true });
    writeFileSync(join(real, "sui-client/sui.keystore"), "[]\n");
    symlinkSync(real, link);
    const result = runDevstack(
      { ...env, PAIRMARKET_DEVSTACK_DIR: link },
      "purge",
    );
    assert.equal(result.status, 1, result.message);
    assert.match(result.stderr, /it is a symlink/);
    assert.doesNotMatch(captured(upstream.capture), /^arg=purge$/m);
    assert.ok(
      existsSync(join(real, "sui-client/sui.keystore")),
      "symlink target untouched",
    );
  }

  {
    const { stateDir, upstream, env } = scenario("checkout-root");
    const result = runDevstack(
      { ...env, PAIRMARKET_DEVSTACK_DIR: root },
      "purge",
    );
    assert.equal(result.status, 1, result.message);
    assert.match(result.stderr, /must be a directory inside this checkout/);
    assert.doesNotMatch(captured(upstream.capture), /^arg=purge$/m);
    assertAll(stateDir, KEPT_BY_RESET, true, "checkout root as state dir");
    assert.ok(
      existsSync(join(root, "package.json")),
      "the checkout is still here",
    );
  }

  {
    // The web env override must stay inside the checkout or the state dir,
    // for reset as well as purge.
    const outside = mkdtempSync(join(tmpdir(), "pairmarket-devstack-webenv-"));
    cleanups.push(outside);
    const stray = join(outside, "precious.env");
    writeFileSync(stray, "do not delete\n");
    for (const command of ["reset", "purge"]) {
      const { stateDir, upstream, env } = scenario(`webenv-${command}`);
      const result = runDevstack(
        { ...env, PAIRMARKET_WEB_ENV_FILE: stray },
        command,
      );
      assert.equal(result.status, 1, result.message);
      assert.match(result.stderr, /PAIRMARKET_WEB_ENV_FILE must point inside/);
      assert.doesNotMatch(captured(upstream.capture), /^arg=(reset|purge)$/m);
      assert.ok(existsSync(stray), `${command}: stray file untouched`);
      assertAll(
        stateDir,
        [...KEPT_BY_RESET, ...CHAIN_BOUND_FILES],
        true,
        `${command} refused`,
      );
    }
  }

  {
    const { stateDir, webEnv, env } = scenario("purge-twice");
    let result = runDevstack(env, "purge");
    assert.equal(result.status, 0, result.message);
    result = runDevstack(env, "purge");
    assert.equal(result.status, 0, `purge is idempotent: ${result.message}`);
    assert.equal(existsSync(stateDir), false);
    assert.equal(existsSync(webEnv), false);
  }
} finally {
  for (const dir of cleanups) {
    rmSync(dir, { recursive: true, force: true });
  }
}
