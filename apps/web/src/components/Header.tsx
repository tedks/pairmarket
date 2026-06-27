import type { JSX } from "react";
import { useState } from "react";
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
        onSignIn={async () => {
          setSigningIn(true);
          try {
            await signInWithTwitter();
          } finally {
            setSigningIn(false);
          }
        }}
        onSignOut={signOut}
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
  onSignIn,
  onSignOut,
}: {
  readonly custody: CustodyState;
  readonly signingIn: boolean;
  readonly onSignIn: () => void;
  readonly onSignOut: () => void;
}): JSX.Element {
  if (custody.kind === "anonymous") {
    return (
      <button
        type="button"
        className="custody-pill custody-pill-anon"
        onClick={onSignIn}
        disabled={signingIn}
        data-testid="sign-in"
      >
        {signingIn ? "signing in…" : "Sign in with Twitter"}
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
      onClick={onSignOut}
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
