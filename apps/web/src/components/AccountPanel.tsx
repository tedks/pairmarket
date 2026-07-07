import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import type { CustodyState } from "@pairmarket/core";
import type { AppState } from "../types.ts";
import { formatAddress } from "../format.ts";

type Props = {
  readonly state: AppState;
  readonly custody: CustodyState;
};

export function AccountPanel({ state, custody }: Props): JSX.Element {
  const viewer = state.users.get(state.viewer);
  const selfCustody = custody.kind === "self-custody" ? custody : undefined;
  return (
    <section className="account-panel">
      <header className="market-list-head">
        <h1>Account</h1>
        <p className="market-list-sub">
          Self-custody first; Twitter custody remains a fallback path.
        </p>
      </header>

      <div className="card">
        <h2 className="card-title">Identity</h2>
        <div className="card-body">
          <div className="kv">
            <span className="kv-k">Display name</span>
            <span className="kv-v">{viewer?.displayName ?? state.viewer}</span>
          </div>
          <div className="kv">
            <span className="kv-k">Handle</span>
            <span className="kv-v">@{viewer?.handle ?? "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-k">User ID</span>
            <span className="kv-v mono">{state.viewer}</span>
          </div>
        </div>
      </div>

      <GasCard custody={selfCustody} />

      <div className="card">
        <h2 className="card-title">Custody</h2>
        <div className="card-body">
          <div className="kv">
            <span className="kv-k">State</span>
            <span className="kv-v">{custody.kind}</span>
          </div>
          {custody.kind === "self-custody" ? (
            <>
              <div className="kv">
                <span className="kv-k">Wallet</span>
                <span className="kv-v">{custody.walletName}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Network</span>
                <span className="kv-v">{custody.network}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Sui address</span>
                <span className="kv-v mono">{custody.address}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Owner</span>
                <span className="kv-v">
                  self-custody · {formatAddress(custody.address)}
                </span>
              </div>
            </>
          ) : custody.kind === "linked" ? (
            <>
              <div className="kv">
                <span className="kv-k">Twitter sub</span>
                <span className="kv-v mono">{custody.sub}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Custodial user</span>
                <span className="kv-v mono">{custody.userId}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Sui address</span>
                <span className="kv-v mono">{custody.address}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Owner</span>
                <span className="kv-v">{describeOwner(custody.owner)}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Address (short)</span>
                <span className="kv-v">{formatAddress(custody.address)}</span>
              </div>
            </>
          ) : custody.kind === "awaiting-oauth" ? (
            <div className="kv">
              <span className="kv-k">Nonce</span>
              <span className="kv-v mono">{custody.nonce}</span>
            </div>
          ) : (
            <p className="card-empty">
              Connect a Sui wallet or use Twitter custody from the header.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Recent intents</h2>
        <div className="card-body">
          {state.intents.length === 0 ? (
            <p className="card-empty">No transactions yet.</p>
          ) : (
            <ul className="intent-list">
              {state.intents.slice(0, 12).map((i) => (
                <li key={i.digest} className="intent-row">
                  <span className="intent-kind">{i.kind}</span>
                  <span className="intent-digest mono">
                    {i.digest.slice(0, 12)}…
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function GasCard({
  custody,
}: {
  readonly custody: Extract<CustodyState, { kind: "self-custody" }> | undefined;
}): JSX.Element {
  const [balanceMist, setBalanceMist] = useState<bigint | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const address = custody?.address;
  const isLocalnet = custody?.network === "localnet";

  const refreshBalance = useCallback(async () => {
    if (address === undefined) {
      setBalanceMist(undefined);
      return;
    }
    const result = await suiRpc<{ totalBalance?: string }>("suix_getBalance", [
      address,
    ]);
    setBalanceMist(BigInt(result.totalBalance ?? "0"));
  }, [address]);

  useEffect(() => {
    setMessage(undefined);
    setError(undefined);
    void refreshBalance().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [refreshBalance]);

  return (
    <div className="card">
      <h2 className="card-title">Gas</h2>
      <div className="card-body">
        {custody === undefined ? (
          <p className="card-empty">
            Connect a Sui wallet to request localnet gas.
          </p>
        ) : (
          <>
            <div className="kv">
              <span className="kv-k">Balance</span>
              <span className="kv-v">
                {balanceMist === undefined
                  ? "checking..."
                  : formatSui(balanceMist)}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!isLocalnet || busy}
              onClick={() => {
                setBusy(true);
                setMessage(undefined);
                setError(undefined);
                void (async () => {
                  try {
                    await requestGas(custody.address);
                    await refreshBalance();
                    setMessage("Gas requested from localnet faucet.");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {busy ? "Requesting..." : "Request gas"}
            </button>
            {!isLocalnet ? (
              <p className="card-empty">
                Local faucet is only available on localnet.
              </p>
            ) : null}
            {message ? <p className="card-empty">{message}</p> : null}
            {error ? <p className="form-error">{error}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

async function suiRpc<T>(
  method: string,
  params: readonly unknown[],
): Promise<T> {
  const response = await fetch("/sui-rpc", {
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

async function requestGas(recipient: string): Promise<void> {
  const response = await fetch("/sui-faucet/v2/gas", {
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

function formatSui(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const frac = (mist % 1_000_000_000n).toString().padStart(9, "0");
  return `${whole}.${frac.slice(0, 3)} SUI`;
}

function describeOwner(
  owner: Extract<CustodyState, { kind: "linked" }>["owner"],
): string {
  switch (owner.kind) {
    case "custodial":
      return "custodial";
    case "migrating":
      return `migrating · ${owner.to}`;
    case "self-custody":
      return `self-custody · ${owner.address}`;
    case "locked":
      return `locked · ${owner.reason}`;
  }
}
