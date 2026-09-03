import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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
// two arguments, plus the compose project and cwd it saw) and emulates
// what the real wrapper deletes: on `reset` the configured state and logs
// directories, on `purge` those plus every extra directory it is given.
// It refuses (exit 99) to delete anything outside its own scenario
// directory, so a wrapper bug cannot reach past the test.
// FAKE_UPSTREAM_PURGE_FAIL=1 makes `purge` exit 1 after deleting nothing.
//
// purge only accepts a state root strictly inside the checkout, so the
// scenario directories live under the repo as .devstack-test-* (ignored by
// git) rather than under the system temp dir. Path spellings that must
// reach bash verbatim (`..`, trailing slashes) are built by string
// concatenation, never with path.join(), which would normalize them away.

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/devstack.sh");

// Mirrors derived_compose_project() in scripts/devstack.sh.
function expectedComposeProject() {
  const base = basename(root);
  if (base === "master" || base === "main") return "pairmarket-devstack";
  const suffix = base
    .replace(/^pairmarket-/, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, "-");
  const hash = createHash("sha256")
    .update(`${realpathSync(root)}\n`)
    .digest("hex")
    .slice(0, 6);
  return `pairmarket-devstack-${suffix || "worktree"}-${hash}`;
}

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
  printf 'project=%s\\n' "\${SUI_DEVSTACK_COMPOSE_PROJECT:-}"
  printf 'cwd=%s\\n' "$PWD"
} >> "${capture}"

# Delete only inside this scenario; anything else is a wrapper bug.
guarded_rm() {
  local d
  for d in "$@"; do
    case "$d" in
      "${dir}"/*) rm -r -f -- "$d" ;;
      *) echo "fake upstream: refusing to delete outside the scenario: $d" >&2; exit 99 ;;
    esac
  done
}
remove_configured_dirs() {
  guarded_rm "\${SUI_DEVSTACK_STATE_DIR:?}" "\${SUI_DEVSTACK_LOGS_DIR:?}"
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
    guarded_rm "$@"
    ;;
  status)
    printf 'project=%s\\n' "\${SUI_DEVSTACK_COMPOSE_PROJECT:-}"
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
  "compose-project",
];
const LEGACY_STATE = "docker/sui-state/stale";
const EVERYTHING = [
  ...KEPT_BY_RESET,
  ...CHAIN_BOUND_FILES,
  ...CURRENT_CHAIN_STATE,
  LEGACY_STATE,
];

function seedState(stateDir, webEnv, { project = "seeded-project" } = {}) {
  const files = {
    "sui-client/client.yaml": "keystore: {}\n",
    "sui-client/sui.keystore": "[]\n",
    "sui-client/deployer-address.json": '{"address":"0xabc"}\n',
    "ports.env": Object.entries(PORTS)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
      .concat("\n"),
    "compose-project": `${project}\n`,
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

// The wrapper and the fake upstream both act on SUI_DEVSTACK_* and
// PAIRMARKET_* variables; never let a developer's exported values leak into
// a run that deletes things.
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SUI_DEVSTACK_") || key.startsWith("PAIRMARKET_")) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function runDevstack(env, command, cwd = root) {
  const result = spawnSync("bash", [script, command], {
    cwd,
    encoding: "utf8",
    env: { ...cleanEnv(), ...env },
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

const escapeRe = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cleanups = [];

function scenario(
  name,
  { supportsPurge = true, parent = root, dirName = "devstack", project } = {},
) {
  const dir = mkdtempSync(join(parent, `.devstack-test-${name}-`));
  cleanups.push(dir);
  const stateDir = join(dir, dirName);
  const webEnv = join(dir, "web.env.local");
  const upstream = makeFakeUpstream(dir, { supportsPurge });
  seedState(stateDir, webEnv, { project });
  const env = {
    PAIRMARKET_DEVSTACK_DIR: stateDir,
    PAIRMARKET_WEB_ENV_FILE: webEnv,
    SUI_DEVSTACK_SCRIPT: upstream.fake,
  };
  return { dir, stateDir, webEnv, upstream, env };
}

// A refusal must happen before anything destructive: no reset/purge call
// reached upstream, every seeded file is still there.
function assertRefused(result, pattern, { stateDir, webEnv, upstream }) {
  assert.equal(result.status, 1, result.message);
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(captured(upstream.capture), /^arg=(reset|purge)$/m);
  assertAll(stateDir, EVERYTHING, true, "refused");
  assert.ok(existsSync(webEnv), "refused: web env file untouched");
}

try {
  {
    // No persisted project: the derived per-worktree default is used.
    const { stateDir, webEnv, upstream, env } = scenario("down", {
      project: null,
    });
    rmSync(join(stateDir, "compose-project"));
    const result = runDevstack(env, "down");
    assert.equal(result.status, 0, result.message);
    const log = captured(upstream.capture);
    assert.match(log, /^call argc=1\narg=down$/m);
    assert.match(
      log,
      new RegExp(`^project=${escapeRe(expectedComposeProject())}$`, "m"),
      "the compose project defaults per worktree (name plus path hash)",
    );
    assertAll(
      stateDir,
      EVERYTHING.filter((f) => f !== "compose-project"),
      true,
      "down",
    );
    assert.ok(existsSync(webEnv), "down kept the web env file");
    assert.equal(
      existsSync(join(stateDir, "compose-project")),
      false,
      "down does not persist the project (only up does)",
    );
  }

  {
    // A project recorded by `up` wins over the derivation; an explicit env
    // override wins over both.
    const { upstream, env } = scenario("project-persisted", {
      project: "recorded-by-up",
    });
    let result = runDevstack(env, "down");
    assert.equal(result.status, 0, result.message);
    assert.match(captured(upstream.capture), /^project=recorded-by-up$/m);
    result = runDevstack(
      { ...env, SUI_DEVSTACK_COMPOSE_PROJECT: "custom-project" },
      "down",
    );
    assert.equal(result.status, 0, result.message);
    assert.match(captured(upstream.capture), /^project=custom-project$/m);
  }

  {
    // A tampered compose-project file is ignored rather than passed to
    // compose.
    const { stateDir, upstream, env } = scenario("project-garbage");
    writeFileSync(join(stateDir, "compose-project"), "Bad Name; rm\n");
    const result = runDevstack(env, "down");
    assert.equal(result.status, 0, result.message);
    assert.match(
      captured(upstream.capture),
      new RegExp(`^project=${escapeRe(expectedComposeProject())}$`, "m"),
    );
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
        `^call argc=2\\narg=purge\\narg=${escapeRe(stateDir)}\\n` +
          `rpc= faucet= graphql=\\nproject=seeded-project\\ncwd=${escapeRe(root)}$`,
        "m",
      ),
      "purge hands exactly the state root to upstream purge, allocates no ports, uses the recorded project, runs from the checkout root",
    );
    assert.equal(existsSync(stateDir), false, "purge removed the state root");
    assert.equal(existsSync(webEnv), false, "purge removed the web env file");
    assert.ok(
      existsSync(dir),
      "purge removed only the state root, not its parent",
    );

    // After a purge, confirming it is gone must not bring anything back.
    const status = runDevstack(env, "status");
    assert.equal(status.status, 0, status.message);
    assert.equal(
      existsSync(stateDir),
      false,
      "status after purge does not recreate the state dir",
    );
    const down = runDevstack(env, "down");
    assert.equal(down.status, 0, down.message);
    assert.equal(
      existsSync(stateDir),
      false,
      "down after purge does not recreate the state dir",
    );
  }

  {
    // A relative PAIRMARKET_DEVSTACK_DIR is resolved against the caller's
    // cwd, and the canonical absolute path is what upstream receives, so
    // the wrapper's own cd to the checkout root cannot change what gets
    // deleted. Run from scripts/ so the relative spelling only means the
    // right thing from there.
    const { stateDir, webEnv, upstream, env } = scenario("relative");
    const relative = `../${basename(resolve(stateDir, ".."))}/devstack`;
    const result = runDevstack(
      { ...env, PAIRMARKET_DEVSTACK_DIR: relative },
      "purge",
      join(root, "scripts"),
    );
    assert.equal(result.status, 0, result.message);
    assert.match(
      captured(upstream.capture),
      new RegExp(`^arg=${escapeRe(stateDir)}$`, "m"),
      "relative state dir is passed upstream as its canonical absolute path",
    );
    assert.equal(existsSync(stateDir), false);
    assert.equal(existsSync(webEnv), false);
  }

  {
    const { stateDir, webEnv, upstream, env } = scenario("with space", {
      dirName: "dev stack",
    });
    const result = runDevstack(env, "purge");
    assert.equal(result.status, 0, result.message);
    assert.match(
      captured(upstream.capture),
      new RegExp(`^call argc=2\\narg=purge\\narg=${escapeRe(stateDir)}$`, "m"),
      "a state root with spaces is passed as one argument",
    );
    assert.equal(existsSync(stateDir), false);
    assert.equal(existsSync(webEnv), false);
  }

  {
    const s = scenario("old-upstream", { supportsPurge: false });
    const result = runDevstack(s.env, "purge");
    assertRefused(result, /has no 'purge' command/, s);
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
      EVERYTHING,
      true,
      "upstream failure (fake deleted nothing)",
    );
  }

  {
    const s = scenario("missing-upstream");
    const result = runDevstack(
      { ...s.env, SUI_DEVSTACK_SCRIPT: join(s.stateDir, "does-not-exist.sh") },
      "purge",
    );
    assertRefused(
      result,
      /Missing executable sui-devstack localnet wrapper/,
      s,
    );
  }

  {
    // A state root outside the checkout (here: the system temp dir) is
    // refused before upstream is called, whatever it contains.
    const outside = mkdtempSync(join(tmpdir(), "pairmarket-devstack-outside-"));
    cleanups.push(outside);
    const anchor = scenario("outside-anchor");
    const stateDir = join(outside, "devstack");
    const webEnv = join(outside, "web.env.local");
    seedState(stateDir, webEnv);
    const result = runDevstack(
      {
        ...anchor.env,
        PAIRMARKET_DEVSTACK_DIR: stateDir,
        PAIRMARKET_WEB_ENV_FILE: webEnv,
      },
      "purge",
    );
    assertRefused(result, /outside this checkout/, {
      stateDir,
      webEnv,
      upstream: anchor.upstream,
    });
  }

  {
    // Symlinked state roots are refused however they are spelled.
    const { dir, upstream, env } = scenario("symlink-root");
    const real = join(dir, "real-devstack");
    const link = join(dir, "linked-devstack");
    mkdirSync(join(real, "sui-client"), { recursive: true });
    writeFileSync(join(real, "sui-client/sui.keystore"), "[]\n");
    symlinkSync(real, link);
    for (const spelling of [link, `${link}/`, `${link}/.`]) {
      const result = runDevstack(
        { ...env, PAIRMARKET_DEVSTACK_DIR: spelling },
        "purge",
      );
      assert.equal(result.status, 1, `${spelling}: ${result.message}`);
      assert.match(result.stderr, /it is a symlink/, spelling);
    }
    assert.doesNotMatch(captured(upstream.capture), /^arg=purge$/m);
    assert.ok(
      existsSync(join(real, "sui-client/sui.keystore")),
      "symlink target untouched",
    );
  }

  {
    const s = scenario("checkout-root");
    for (const spelling of [root, `${root}/`, `${root}/scripts/..`]) {
      const result = runDevstack(
        { ...s.env, PAIRMARKET_DEVSTACK_DIR: spelling },
        "purge",
      );
      assert.equal(result.status, 1, `${spelling}: ${result.message}`);
      assert.match(result.stderr, /it is the checkout itself/, spelling);
    }
    assert.doesNotMatch(captured(s.upstream.capture), /^arg=purge$/m);
    assertAll(s.stateDir, EVERYTHING, true, "checkout root as state dir");
    assert.ok(
      existsSync(join(root, "package.json")),
      "the checkout is still here",
    );
  }

  {
    // A state root that exists but is a regular file is refused (upstream
    // would otherwise be handed a file as a "directory").
    const s = scenario("file-root");
    const file = join(s.dir, "not-a-dir");
    writeFileSync(file, "x\n");
    for (const command of ["reset", "purge"]) {
      const result = runDevstack(
        { ...s.env, PAIRMARKET_DEVSTACK_DIR: file },
        command,
      );
      assert.equal(result.status, 1, `${command}: ${result.message}`);
      assert.match(result.stderr, /exists but is not a directory/);
    }
    assert.ok(existsSync(file));
    assert.doesNotMatch(captured(s.upstream.capture), /^arg=(reset|purge)$/m);
  }

  {
    // The web env override must stay inside the checkout or the state dir,
    // for reset as well as purge, and a traversal through a directory that
    // does not exist yet must not slip through. The traversal string is
    // built by hand so the `..` segments reach bash.
    const outside = mkdtempSync(join(tmpdir(), "pairmarket-devstack-webenv-"));
    cleanups.push(outside);
    const stray = join(outside, "precious.env");
    writeFileSync(stray, "do not delete\n");
    for (const command of ["reset", "purge"]) {
      const s = scenario(`webenv-${command}`);
      const ups = "../".repeat(s.stateDir.split("/").length);
      const traversal = `${s.stateDir}/missing/${ups}${stray.slice(1)}`;
      assert.match(traversal, /\/missing\/\.\.\//, "traversal keeps its ..");
      for (const spelling of [stray, traversal]) {
        const result = runDevstack(
          { ...s.env, PAIRMARKET_WEB_ENV_FILE: spelling },
          command,
        );
        assertRefused(
          result,
          /PAIRMARKET_WEB_ENV_FILE .*outside this checkout/,
          s,
        );
        assert.ok(existsSync(stray), `${command}: stray file untouched`);
      }
    }
  }

  {
    // Exported upstream dirs are deletion targets too; outside the checkout
    // they are refused before upstream is called, for both variables.
    const outside = mkdtempSync(join(tmpdir(), "pairmarket-devstack-updirs-"));
    cleanups.push(outside);
    mkdirSync(join(outside, "state/db"), { recursive: true });
    mkdirSync(join(outside, "logs"), { recursive: true });
    writeFileSync(join(outside, "state/db/CURRENT"), "x\n");
    writeFileSync(join(outside, "logs/sui.log"), "x\n");
    for (const command of ["reset", "purge"]) {
      for (const [variable, sub] of [
        ["SUI_DEVSTACK_STATE_DIR", "state"],
        ["SUI_DEVSTACK_LOGS_DIR", "logs"],
      ]) {
        const s = scenario(`updirs-${command}-${sub}`);
        const result = runDevstack(
          { ...s.env, [variable]: join(outside, sub) },
          command,
        );
        assertRefused(
          result,
          new RegExp(`${variable} .*outside this checkout`),
          s,
        );
      }
    }
    assert.ok(existsSync(join(outside, "state/db/CURRENT")));
    assert.ok(existsSync(join(outside, "logs/sui.log")));
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
