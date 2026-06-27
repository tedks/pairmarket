import type { JSX } from "react";
import { useEffect, useState } from "react";
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
import { WALLET_STORAGE_KEY } from "../dapp-kit.ts";
import { formatAddress } from "../format.ts";
import type { UserProfile } from "../types.ts";

type HeaderProps = {
  readonly viewer: UserProfile;
  readonly users: readonly UserProfile[];
  readonly custody: CustodyState;
};

export function Header({ viewer, users, custody }: HeaderProps): JSX.Element {
  const [signingIn, setSigningIn] = useState(false);
  const [selectedWalletIndex, setSelectedWalletIndex] = useState<number | null>(
    null,
  );
  const [walletError, setWalletError] = useState<string | null>(null);
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const account = useCurrentAccount();
  const wallet = useCurrentWallet();
  const connection = useWalletConnection();
  const effectiveWalletIndex =
    selectedWalletIndex !== null && wallets[selectedWalletIndex] !== undefined
      ? selectedWalletIndex
      : preferredWalletIndex(wallets);

  useEffect(() => {
    setSelectedWalletIndex((current) => {
      if (wallets.length === 0) return null;
      if (current !== null && wallets[current] !== undefined) return current;
      return preferredWalletIndex(wallets);
    });
  }, [wallets]);

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
        wallets={wallets.map((w, index) => ({ index, name: w.name }))}
        selectedWalletIndex={effectiveWalletIndex}
        walletError={walletError}
        connectingWallet={connection.isConnecting || connection.isReconnecting}
        onSelectWallet={(index) => {
          setSelectedWalletIndex(index);
          setWalletError(null);
        }}
        onConnectWallet={async () => {
          const selectedWallet =
            effectiveWalletIndex === null
              ? undefined
              : wallets[effectiveWalletIndex];
          if (selectedWallet === undefined) {
            setWalletError("No Sui wallet found");
            return;
          }

          setWalletError(null);
          try {
            const result = await dAppKit.connectWallet({
              wallet: selectedWallet,
            });
            if (result.accounts.length === 0) {
              setWalletError("Wallet returned no Sui accounts");
            }
          } catch (error) {
            setWalletError(walletConnectErrorMessage(error));
          }
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
          try {
            await dAppKit.disconnectWallet();
          } catch {
            localStorage.removeItem(WALLET_STORAGE_KEY);
          }
          signOut();
        }}
      />
    </header>
  );
}

function preferredWalletIndex(
  wallets: readonly { readonly name: string }[],
): number | null {
  if (wallets.length === 0) return null;
  const burnerIndex = wallets.findIndex((w) =>
    w.name.toLowerCase().includes("burner"),
  );
  return burnerIndex >= 0 ? burnerIndex : 0;
}

function walletConnectErrorMessage(error: unknown): string {
  if (error instanceof Error && /cancel/i.test(error.message)) {
    return "Wallet connection canceled";
  }

  return "Wallet connection failed";
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
  wallets,
  selectedWalletIndex,
  walletError,
  connectingWallet,
  onSelectWallet,
  onConnectWallet,
  onSignIn,
  onSignOut,
}: {
  readonly custody: CustodyState;
  readonly signingIn: boolean;
  readonly accountAddress: string | undefined;
  readonly walletName: string | undefined;
  readonly wallets: readonly {
    readonly index: number;
    readonly name: string;
  }[];
  readonly selectedWalletIndex: number | null;
  readonly walletError: string | null;
  readonly connectingWallet: boolean;
  readonly onSelectWallet: (index: number) => void;
  readonly onConnectWallet: () => Promise<void>;
  readonly onSignIn: () => void;
  readonly onSignOut: () => Promise<void>;
}): JSX.Element {
  if (custody.kind === "anonymous") {
    return (
      <div className="auth-actions">
        {wallets.length > 1 ? (
          <select
            className="wallet-select"
            aria-label="Choose Sui wallet"
            value={selectedWalletIndex ?? ""}
            onChange={(e) => onSelectWallet(Number(e.target.value))}
            disabled={connectingWallet}
            data-testid="wallet-select"
          >
            {wallets.map((wallet) => (
              <option
                key={`${wallet.name}-${wallet.index}`}
                value={wallet.index}
              >
                {wallet.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="custody-pill custody-pill-anon"
          onClick={() => void onConnectWallet()}
          disabled={wallets.length === 0 || connectingWallet}
          data-testid="connect-wallet"
        >
          {connectingWallet
            ? "connecting wallet…"
            : wallets.length > 0
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
        {walletError ? (
          <span className="auth-error" role="status" data-testid="wallet-error">
            {walletError}
          </span>
        ) : null}
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
