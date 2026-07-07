import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/devstack.sh");

function makeFakeUpstream(dir) {
  const fake = join(dir, "fake-sui-localnet.sh");
  const capture = join(dir, "capture.env");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'command=%s\\n' "\${1:-}"
  printf 'rpc=%s\\n' "\${SUI_DEVSTACK_RPC_PORT:-}"
  printf 'faucet=%s\\n' "\${SUI_DEVSTACK_FAUCET_PORT:-}"
  printf 'graphql=%s\\n' "\${SUI_DEVSTACK_GRAPHQL_PORT:-}"
} >> "${capture}"

case "\${1:-}" in
  status)
    printf 'container=none state=stopped\\n'
    printf 'rpc=not_ready\\n'
    ;;
  env)
    printf 'SUI_RPC_URL=http://127.0.0.1:%s\\n' "\${SUI_DEVSTACK_RPC_PORT:-}"
    printf 'SUI_FAUCET_URL=http://127.0.0.1:%s/gas\\n' "\${SUI_DEVSTACK_FAUCET_PORT:-}"
    printf 'SUI_GRAPHQL_URL=http://127.0.0.1:%s/graphql\\n' "\${SUI_DEVSTACK_GRAPHQL_PORT:-}"
    ;;
  up)
    printf 'fake up should not be reached by collision test\\n'
    ;;
esac
`,
  );
  chmodSync(fake, 0o700);
  return { fake, capture };
}

function runDevstack(env, command = "status") {
  return spawnSync("bash", [script, command], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function readPorts(dir) {
  const text = readFileSync(join(dir, "ports.env"), "utf8");
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

function assertCaptured(capture, ports) {
  const text = readFileSync(capture, "utf8");
  assert.match(text, new RegExp(`rpc=${ports.SUI_DEVSTACK_RPC_PORT}`));
  assert.match(text, new RegExp(`faucet=${ports.SUI_DEVSTACK_FAUCET_PORT}`));
  assert.match(text, new RegExp(`graphql=${ports.SUI_DEVSTACK_GRAPHQL_PORT}`));
}

function assertPortSet(ports) {
  const values = Object.values(ports).map(Number);
  assert.equal(values.length, 3);
  assert.equal(new Set(values).size, 3);
  for (const port of values) {
    assert.ok(Number.isInteger(port), `expected integer port, got ${port}`);
    assert.ok(
      port >= 20000 && port <= 29999,
      `expected generated port range, got ${port}`,
    );
    assert.notEqual(port, 9000);
    assert.notEqual(port, 9123);
    assert.notEqual(port, 9125);
  }
}

async function listen(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "0.0.0.0", port, exclusive: true }, resolve);
  });
  return server;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

const tempDirs = [];

try {
  const generatedDir = mkdtempSync(
    join(tmpdir(), "pairmarket-devstack-ports-"),
  );
  tempDirs.push(generatedDir);
  const generated = makeFakeUpstream(generatedDir);
  const generatedEnv = {
    PAIRMARKET_DEVSTACK_DIR: generatedDir,
    SUI_DEVSTACK_SCRIPT: generated.fake,
  };

  const first = runDevstack(generatedEnv);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstPorts = readPorts(generatedDir);
  assertPortSet(firstPorts);
  assertCaptured(generated.capture, firstPorts);

  const second = runDevstack(generatedEnv);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.deepEqual(readPorts(generatedDir), firstPorts);
  assertCaptured(generated.capture, firstPorts);

  const reset = runDevstack(generatedEnv, "reset");
  assert.equal(reset.status, 0, reset.stderr || reset.stdout);
  assert.equal(existsSync(join(generatedDir, "ports.env")), false);

  const explicitDir = mkdtempSync(
    join(tmpdir(), "pairmarket-devstack-explicit-"),
  );
  tempDirs.push(explicitDir);
  const explicit = makeFakeUpstream(explicitDir);
  const explicitResult = runDevstack({
    PAIRMARKET_DEVSTACK_DIR: explicitDir,
    SUI_DEVSTACK_SCRIPT: explicit.fake,
    SUI_DEVSTACK_RPC_PORT: "19100",
    SUI_DEVSTACK_FAUCET_PORT: "19123",
    SUI_DEVSTACK_GRAPHQL_PORT: "19125",
  });
  assert.equal(
    explicitResult.status,
    0,
    explicitResult.stderr || explicitResult.stdout,
  );
  assert.deepEqual(readPorts(explicitDir), {
    SUI_DEVSTACK_RPC_PORT: "19100",
    SUI_DEVSTACK_FAUCET_PORT: "19123",
    SUI_DEVSTACK_GRAPHQL_PORT: "19125",
  });
  assertCaptured(explicit.capture, readPorts(explicitDir));

  const partialDir = mkdtempSync(
    join(tmpdir(), "pairmarket-devstack-partial-"),
  );
  tempDirs.push(partialDir);
  const partial = makeFakeUpstream(partialDir);
  const partialResult = runDevstack({
    PAIRMARKET_DEVSTACK_DIR: partialDir,
    SUI_DEVSTACK_SCRIPT: partial.fake,
    SUI_DEVSTACK_RPC_PORT: "19100",
  });
  assert.equal(
    partialResult.status,
    0,
    partialResult.stderr || partialResult.stdout,
  );
  const partialPorts = readPorts(partialDir);
  assert.equal(partialPorts.SUI_DEVSTACK_RPC_PORT, "19100");
  assert.notEqual(partialPorts.SUI_DEVSTACK_FAUCET_PORT, "19100");
  assert.notEqual(partialPorts.SUI_DEVSTACK_GRAPHQL_PORT, "19100");
  assert.ok(Number(partialPorts.SUI_DEVSTACK_FAUCET_PORT) >= 20000);
  assert.ok(Number(partialPorts.SUI_DEVSTACK_FAUCET_PORT) <= 29999);
  assert.ok(Number(partialPorts.SUI_DEVSTACK_GRAPHQL_PORT) >= 20000);
  assert.ok(Number(partialPorts.SUI_DEVSTACK_GRAPHQL_PORT) <= 29999);
  assertCaptured(partial.capture, partialPorts);

  const collisionDir = mkdtempSync(
    join(tmpdir(), "pairmarket-devstack-collision-"),
  );
  tempDirs.push(collisionDir);
  const collision = makeFakeUpstream(collisionDir);
  const server = await listen(0);
  try {
    const port = String(server.address().port);
    const collisionResult = runDevstack(
      {
        PAIRMARKET_DEVSTACK_DIR: collisionDir,
        SUI_DEVSTACK_SCRIPT: collision.fake,
        SUI_DEVSTACK_RPC_PORT: port,
        SUI_DEVSTACK_FAUCET_PORT: "19133",
        SUI_DEVSTACK_GRAPHQL_PORT: "19135",
      },
      "up",
    );
    assert.notEqual(collisionResult.status, 0);
    assert.match(
      collisionResult.stderr,
      /Selected Sui localnet ports are already in use/,
    );
  } finally {
    await close(server);
  }
} finally {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}
