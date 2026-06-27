import type { JSX } from "react";
import type { CustodyState } from "@pairmarket/core";
import type { AppState } from "../types.ts";
import { formatAddress } from "../format.ts";

type Props = {
  readonly state: AppState;
  readonly custody: CustodyState;
};

export function AccountPanel({ state, custody }: Props): JSX.Element {
  const viewer = state.users.get(state.viewer);
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

function describeOwner(
  owner: Extract<CustodyState, { kind: "linked" }>["owner"],
): string {
  switch (owner.kind) {
    case "custodial":
      return `custodial · ${owner.keyRef}`;
    case "migrating":
      return `migrating · ${owner.from} → ${owner.to}`;
    case "self-custody":
      return `self-custody · ${owner.address}`;
    case "locked":
      return `locked · ${owner.reason}`;
  }
}
