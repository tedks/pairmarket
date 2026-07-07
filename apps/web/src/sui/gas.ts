import {
  tryParseSuiAddress,
  type CustodyState,
  type SuiAddress,
  type SuiNetwork,
} from "@pairmarket/core";

export const MIN_WORKING_GAS_MIST = 1_000_000_000n;
export const AUTO_GAS_COOLDOWN_MS = 5 * 60 * 1000;

type FetchLike = typeof fetch;
type GasAttemptStore = Pick<Storage, "getItem" | "setItem">;

type SuiBalanceResponse = {
  readonly totalBalance?: string;
};

export type LocalnetAutoGasRequest = {
  readonly address: SuiAddress;
  readonly network: "localnet";
};

export async function getSuiBalanceMist(
  address: SuiAddress,
  fetchFn: FetchLike = fetch,
): Promise<bigint> {
  const result = await suiRpc<SuiBalanceResponse>(
    "suix_getBalance",
    [address],
    fetchFn,
  );
  return BigInt(result.totalBalance ?? "0");
}

export async function requestSuiGas(
  recipient: SuiAddress,
  fetchFn: FetchLike = fetch,
): Promise<void> {
  const response = await fetchFn("/sui-faucet/v2/gas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ FixedAmountRequest: { recipient } }),
  });
  const payload = (await response.json()) as {
    status?: "Success" | { Failure?: { internal?: string } };
  };
  if (!response.ok || payload.status !== "Success") {
    const failure =
      typeof payload.status === "object"
        ? payload.status.Failure?.internal
        : undefined;
    throw new Error(failure ?? "Faucet request failed");
  }
}

export async function maybeRequestLocalnetGas({
  address,
  network,
  minimumMist = MIN_WORKING_GAS_MIST,
  fetchFn = fetch,
}: {
  readonly address: SuiAddress;
  readonly network: SuiNetwork;
  readonly minimumMist?: bigint;
  readonly fetchFn?: FetchLike;
}): Promise<"requested" | "funded" | "skipped"> {
  if (network !== "localnet") return "skipped";
  const balance = await getSuiBalanceMist(address, fetchFn);
  if (balance >= minimumMist) return "funded";
  await requestSuiGas(address, fetchFn);
  return "requested";
}

const memoryAutoGasAttempts = new Map<string, number>();

export function reserveAutoGasAttempt({
  address,
  network,
  nowMs = Date.now(),
  cooldownMs = AUTO_GAS_COOLDOWN_MS,
  store = browserStorage(),
}: {
  readonly address: SuiAddress;
  readonly network: SuiNetwork;
  readonly nowMs?: number;
  readonly cooldownMs?: number;
  readonly store?: GasAttemptStore | undefined;
}): boolean {
  const key = `pairmarket:auto-gas:${network}:${address}`;
  const previous = readAttempt(key, store);
  if (previous !== undefined && nowMs - previous < cooldownMs) return false;
  writeAttempt(key, nowMs, store);
  return true;
}

export function canAutoFundConnectedWallet({
  custody,
  address,
  network,
}: {
  readonly custody: CustodyState;
  readonly address: SuiAddress;
  readonly network: SuiNetwork;
}): boolean {
  return (
    custody.kind === "self-custody" &&
    custody.address === address &&
    custody.network === network
  );
}

export function autoGasRequestForConnectedWallet({
  custody,
  connected,
  rawAddress,
  network,
}: {
  readonly custody: CustodyState;
  readonly connected: boolean;
  readonly rawAddress: string | undefined;
  readonly network: SuiNetwork | string;
}): LocalnetAutoGasRequest | undefined {
  if (!connected || network !== "localnet") return undefined;
  const address = tryParseSuiAddress(rawAddress);
  if (!address.ok) return undefined;
  if (
    !canAutoFundConnectedWallet({
      custody,
      address: address.value,
      network,
    })
  ) {
    return undefined;
  }
  return { address: address.value, network };
}

export function canReadLocalnetGasBalance(
  custody: Extract<CustodyState, { kind: "self-custody" }> | undefined,
): custody is Extract<CustodyState, { kind: "self-custody" }> {
  return custody?.network === "localnet";
}

async function suiRpc<T>(
  method: string,
  params: readonly unknown[],
  fetchFn: FetchLike,
): Promise<T> {
  const response = await fetchFn("/sui-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (
    !response.ok ||
    payload.error !== undefined ||
    payload.result === undefined
  ) {
    throw new Error(payload.error?.message ?? `Sui RPC ${method} failed`);
  }
  return payload.result;
}

function browserStorage(): GasAttemptStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readAttempt(
  key: string,
  store: GasAttemptStore | undefined,
): number | undefined {
  let raw: string | number | null | undefined;
  try {
    raw = store?.getItem(key);
  } catch {
    raw = undefined;
  }
  raw ??= memoryAutoGasAttempts.get(key);
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function writeAttempt(
  key: string,
  value: number,
  store: GasAttemptStore | undefined,
): void {
  memoryAutoGasAttempts.set(key, value);
  try {
    store?.setItem(key, String(value));
  } catch {
    // In-memory fallback above is enough for browsers that deny localStorage.
  }
}
