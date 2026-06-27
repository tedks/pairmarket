import type { JSX } from "react";
import { useState } from "react";
import {
  useCurrentAccount,
  useCurrentWallet,
  useDAppKit,
  useWalletConnection,
  useWallets,
} from "@mysten/dapp-kit-react";
import type { CustodyState } from "@pairmarket/core";
import {
  setState as setAppState,
  signInWithTwitter,
  signOut,
} from "../mock/store.ts";
import { setViewer } from "../mock/intents.ts";
import { formatAddress } from "../format.ts";
import type { UserProfile } from "../types.ts";

type HeaderProps = {
  readonly viewer: UserProfile;
  readonly users: readonly UserProfile[];
  readonly custody: CustodyState;
};

export function Header({ viewer, users, custody }: HeaderProps): JSX.Element {
  const [signingIn, setSigningIn] = useState(false);
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const account = useCurrentAccount();
  const wallet = useCurrentWallet();
  const connection = useWalletConnection();
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          ◐
        </span>
        <span className="brand-name">pairmarket</span>
        <span className="brand-tag">prototype</span>
      </div>
      <div className="header-spacer" />
      <ViewerSwitcher viewer={viewer} users={users} />
      <CustodyPill
        custody={custody}
        signingIn={signingIn}
        accountAddress={account?.address}
        walletName={wallet?.name}
        canConnectWallet={wallets.length > 0}
        connectingWallet={connection.isConnecting || connection.isReconnecting}
        onConnectWallet={async () => {
          const wallet =
            wallets.find((w) => w.name.toLowerCase().includes("burner")) ??
            wallets[0];
          if (!wallet) return;
          await dAppKit.connectWallet({ wallet });
        }}
        onSignIn={async () => {
          setSigningIn(true);
          try {
            await signInWithTwitter();
          } finally {
            setSigningIn(false);
          }
        }}
        onSignOut={async () => {
          if (connection.isConnected) await dAppKit.disconnectWallet();
          signOut();
        }}
      />
    </header>
  );
}

function ViewerSwitcher({
  viewer,
  users,
}: {
  readonly viewer: UserProfile;
  readonly users: readonly UserProfile[];
}): JSX.Element {
  return (
    <label
      className="viewer-switcher"
      title="Dev-only: change which seeded identity is the active viewer"
    >
      <span className="viewer-switcher-label">viewing as</span>
      <select
        value={viewer.id}
        onChange={(e) => {
          const nextId = e.target.value;
          const next = users.find((u) => u.id === nextId);
          if (next) setAppState((s) => setViewer(s, next.id));
        }}
        data-testid="viewer-switcher"
      >
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.displayName} · @{u.handle}
          </option>
        ))}
      </select>
    </label>
  );
}

function CustodyPill({
  custody,
  signingIn,
  accountAddress,
  walletName,
  canConnectWallet,
  connectingWallet,
  onConnectWallet,
  onSignIn,
  onSignOut,
}: {
  readonly custody: CustodyState;
  readonly signingIn: boolean;
  readonly accountAddress: string | undefined;
  readonly walletName: string | undefined;
  readonly canConnectWallet: boolean;
  readonly connectingWallet: boolean;
  readonly onConnectWallet: () => Promise<void>;
  readonly onSignIn: () => void;
  readonly onSignOut: () => Promise<void>;
}): JSX.Element {
  if (custody.kind === "anonymous") {
    return (
      <div className="auth-actions">
        <button
          type="button"
          className="custody-pill custody-pill-anon"
          onClick={() => void onConnectWallet()}
          disabled={!canConnectWallet || connectingWallet}
          data-testid="connect-wallet"
        >
          {connectingWallet
            ? "connecting wallet…"
            : canConnectWallet
              ? "Connect wallet"
              : "No Sui wallet found"}
        </button>
        <button
          type="button"
          className="custody-pill custody-pill-secondary"
          onClick={onSignIn}
          disabled={signingIn}
          data-testid="sign-in-twitter"
        >
          {signingIn ? "signing in…" : "Twitter custody"}
        </button>
      </div>
    );
  }
  if (custody.kind === "self-custody") {
    return (
      <button
        type="button"
        className="custody-pill custody-pill-linked"
        onClick={() => void onSignOut()}
        title="Disconnect wallet"
        data-testid="custody-self"
      >
        <span className="custody-pill-sub">
          {walletName ?? custody.walletName}
        </span>
        <span className="custody-pill-addr">
          {formatAddress(accountAddress ?? custody.address)}
        </span>
      </button>
    );
  }
  if (custody.kind === "awaiting-oauth") {
    return (
      <span
        className="custody-pill custody-pill-pending"
        data-testid="custody-pending"
      >
        awaiting OAuth · {custody.nonce.slice(0, 8)}…
      </span>
    );
  }
  return (
    <button
      type="button"
      className="custody-pill custody-pill-linked"
      onClick={() => void onSignOut()}
      title="Sign out"
      data-testid="custody-linked"
    >
      <span className="custody-pill-sub">
        {custody.sub.replace(/^twitter:/, "@")}
      </span>
      <span className="custody-pill-addr">
        {formatAddress(custody.address)}
      </span>
    </button>
  );
}
