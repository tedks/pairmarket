import { parseSuiAddress } from "@pairmarket/core";
import {
  AUTO_GAS_COOLDOWN_MS,
  autoGasRequestForConnectedWallet,
  canAutoFundConnectedWallet,
  canReadLocalnetGasBalance,
  maybeRequestLocalnetGas,
  reserveAutoGasAttempt,
} from "../src/sui/gas.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const address = parseSuiAddress(
  "0x0000000000000000000000000000000000000000000000000000000000000123",
);
const otherAddress = parseSuiAddress(
  "0x0000000000000000000000000000000000000000000000000000000000000456",
);

function response(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

function makeFetch(balanceMist) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url === "/sui-rpc") {
      const request = JSON.parse(init.body);
      assert(request.method === "suix_getBalance", "balance RPC is requested");
      assert(request.params[0] === address, "balance uses connected address");
      return response({ result: { totalBalance: String(balanceMist) } });
    }
    if (url === "/sui-faucet/v2/gas") {
      const request = JSON.parse(init.body);
      assert(
        request.FixedAmountRequest.recipient === address,
        "faucet uses connected address",
      );
      return response({ status: "Success" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetchFn };
}

function memoryStore() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function throwingStore() {
  return {
    getItem: () => {
      throw new Error("storage denied");
    },
    setItem: () => {
      throw new Error("storage denied");
    },
  };
}

{
  const { calls, fetchFn } = makeFetch(0n);
  const result = await maybeRequestLocalnetGas({
    address,
    network: "localnet",
    fetchFn,
  });
  assert(result === "requested", "empty localnet wallet requests gas");
  assert(calls.length === 2, "empty localnet wallet checks balance and faucet");
}

{
  const { calls, fetchFn } = makeFetch(2_000_000_000n);
  const result = await maybeRequestLocalnetGas({
    address,
    network: "localnet",
    fetchFn,
  });
  assert(result === "funded", "funded localnet wallet skips faucet");
  assert(calls.length === 1, "funded wallet only checks balance");
}

{
  const { calls, fetchFn } = makeFetch(0n);
  const result = await maybeRequestLocalnetGas({
    address,
    network: "testnet",
    fetchFn,
  });
  assert(result === "skipped", "non-localnet wallet is ignored");
  assert(calls.length === 0, "non-localnet wallet never calls RPC or faucet");
}

{
  const store = memoryStore();
  assert(
    reserveAutoGasAttempt({
      address,
      network: "localnet",
      nowMs: 1_000,
      store,
    }),
    "first auto-gas attempt is reserved",
  );
  assert(
    !reserveAutoGasAttempt({
      address,
      network: "localnet",
      nowMs: 1_000 + AUTO_GAS_COOLDOWN_MS - 1,
      store,
    }),
    "repeat auto-gas attempt inside cooldown is blocked",
  );
  assert(
    reserveAutoGasAttempt({
      address,
      network: "localnet",
      nowMs: 1_000 + AUTO_GAS_COOLDOWN_MS,
      store,
    }),
    "auto-gas attempt after cooldown is allowed",
  );
}

{
  const store = throwingStore();
  assert(
    reserveAutoGasAttempt({
      address: otherAddress,
      network: "localnet",
      nowMs: 1_000,
      store,
    }),
    "storage failures fall back to memory and do not block auto-gas",
  );
  assert(
    !reserveAutoGasAttempt({
      address: otherAddress,
      network: "localnet",
      nowMs: 1_001,
      store,
    }),
    "memory fallback still blocks repeated attempts when storage throws",
  );
}

{
  assert(
    canAutoFundConnectedWallet({
      custody: {
        kind: "self-custody",
        address,
        walletName: "Generated",
        network: "localnet",
      },
      address,
      network: "localnet",
    }),
    "active matching self-custody wallet can auto-fund",
  );
  assert(
    !canAutoFundConnectedWallet({
      custody: {
        kind: "self-custody",
        address: otherAddress,
        walletName: "Generated",
        network: "localnet",
      },
      address,
      network: "localnet",
    }),
    "different active self-custody wallet cannot auto-fund",
  );
  assert(
    !canAutoFundConnectedWallet({
      custody: {
        kind: "self-custody",
        address,
        walletName: "Generated",
        network: "testnet",
      },
      address,
      network: "localnet",
    }),
    "same address on a different active network cannot auto-fund",
  );
  assert(
    !canAutoFundConnectedWallet({
      custody: {
        kind: "linked",
        sub: "twitter:ada",
        userId: "twitter:ada",
        sessionId: "twitter_session_1234567890",
        address: otherAddress,
        owner: { kind: "custodial" },
      },
      address,
      network: "localnet",
    }),
    "linked Twitter custody cannot auto-fund a connected wallet",
  );
}

{
  const custody = {
    kind: "self-custody",
    address,
    walletName: "Generated",
    network: "localnet",
  };
  assert(
    autoGasRequestForConnectedWallet({
      custody,
      connected: true,
      rawAddress: address,
      network: "localnet",
    })?.address === address,
    "bridge request helper accepts connected matching localnet self-custody",
  );
  assert(
    autoGasRequestForConnectedWallet({
      custody,
      connected: true,
      rawAddress: address,
      network: "testnet",
    }) === undefined,
    "bridge request helper rejects non-localnet network",
  );
  assert(
    autoGasRequestForConnectedWallet({
      custody: { kind: "anonymous" },
      connected: true,
      rawAddress: address,
      network: "localnet",
    }) === undefined,
    "bridge request helper rejects inactive self-custody",
  );
}

{
  assert(
    canReadLocalnetGasBalance({
      kind: "self-custody",
      address,
      walletName: "Generated",
      network: "localnet",
    }),
    "Account gas card may read localnet self-custody balance",
  );
  assert(
    !canReadLocalnetGasBalance({
      kind: "self-custody",
      address,
      walletName: "Generated",
      network: "testnet",
    }),
    "Account gas card must not read localnet RPC for non-localnet custody",
  );
}
