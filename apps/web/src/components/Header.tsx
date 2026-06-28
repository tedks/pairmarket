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
  setPrototypeViewer,
  signInWithTwitter,
  signOut,
} from "../mock/store.ts";
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
  const [selectedWalletName, setSelectedWalletName] = useState<string | null>(
    null,
  );
  const [walletError, setWalletError] = useState<string | null>(null);
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const account = useCurrentAccount();
  const wallet = useCurrentWallet();
  const connection = useWalletConnection();
  const effectiveWalletName =
    selectedWalletName !== null &&
    wallets.some((candidate) => candidate.name === selectedWalletName)
      ? selectedWalletName
      : preferredWalletName(wallets);

  useEffect(() => {
    setSelectedWalletName((current) => {
      if (wallets.length === 0) return null;
      if (
        current !== null &&
        wallets.some((candidate) => candidate.name === current)
      ) {
        return current;
      }
      return preferredWalletName(wallets);
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
        wallets={wallets.map((w) => ({ name: w.name }))}
        selectedWalletName={effectiveWalletName}
        walletError={walletError}
        connectingWallet={connection.isConnecting || connection.isReconnecting}
        onSelectWallet={(name) => {
          setSelectedWalletName(name);
          setWalletError(null);
        }}
        onConnectWallet={async () => {
          const selectedWallet = wallets.find(
            (candidate) => candidate.name === effectiveWalletName,
          );
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
          if (connection.wallet != null) {
            try {
              await dAppKit.disconnectWallet();
            } catch {
              localStorage.removeItem(WALLET_STORAGE_KEY);
              if (custody.kind === "self-custody") {
                setWalletError("Wallet disconnect failed");
                return;
              }
            }
          } else {
            localStorage.removeItem(WALLET_STORAGE_KEY);
          }
          setWalletError(null);
          signOut();
        }}
      />
    </header>
  );
}

function preferredWalletName(
  wallets: readonly { readonly name: string }[],
): string | null {
  if (wallets.length === 0) return null;
  const burnerWallet = wallets.find((w) =>
    w.name.toLowerCase().includes("burner"),
  );
  return burnerWallet?.name ?? wallets[0]?.name ?? null;
}

function walletConnectErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (
    code === 4001 ||
    code === "4001" ||
    (error instanceof Error &&
      /\b(cancel|reject|denied|deny|abort)/i.test(error.message))
  ) {
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
          if (next) setPrototypeViewer(next.id);
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
  selectedWalletName,
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
    readonly name: string;
  }[];
  readonly selectedWalletName: string | null;
  readonly walletError: string | null;
  readonly connectingWallet: boolean;
  readonly onSelectWallet: (name: string) => void;
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
            value={selectedWalletName ?? ""}
            onChange={(e) => onSelectWallet(e.target.value)}
            disabled={connectingWallet}
            data-testid="wallet-select"
          >
            {/* DAppKit exposes wallet names as the stable public selector. */}
            {wallets.map((wallet) => (
              <option key={wallet.name} value={wallet.name}>
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
          <span className="auth-error" role="alert" data-testid="wallet-error">
            {walletError}
          </span>
        ) : null}
      </div>
    );
  }
  if (custody.kind === "self-custody") {
    return (
      <div className="auth-actions">
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
        {walletError ? (
          <span className="auth-error" role="alert" data-testid="wallet-error">
            {walletError}
          </span>
        ) : null}
      </div>
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
