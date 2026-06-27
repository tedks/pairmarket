import { useSyncExternalStore } from "react";
import type { CustodyState } from "@pairmarket/core";
import type { AppState } from "../types.ts";
import { seedAppState } from "./seed.ts";
import { createPrototypeTwitterCustodyClient } from "../auth/twitter-custody.ts";

type Listener = () => void;

let state: AppState = seedAppState();
let custody: CustodyState = { kind: "anonymous" };
const twitterCustody = createPrototypeTwitterCustodyClient();
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l();
}

export function getState(): AppState {
  return state;
}

export function getCustody(): CustodyState {
  return custody;
}

export function setState(
  next: AppState | ((prev: AppState) => AppState),
): void {
  const computed = typeof next === "function" ? next(state) : next;
  if (computed === state) return;
  state = computed;
  notify();
}

export function setCustody(next: CustodyState): void {
  if (
    custody.kind === next.kind &&
    (next.kind === "anonymous" ||
      (next.kind === "self-custody" &&
        custody.kind === "self-custody" &&
        custody.address === next.address &&
        custody.walletName === next.walletName &&
        custody.network === next.network))
  ) {
    return;
  }
  custody = next;
  notify();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function useCustody(): CustodyState {
  return useSyncExternalStore(subscribe, getCustody, getCustody);
}

// Mock OAuth: the real flow is a redirect to Twitter; here the client speaks
// through the same public session shape the eventual API will return.
export async function signInWithTwitter(): Promise<void> {
  const profile = state.users.get(state.viewer);
  if (!profile) throw new Error("no viewer profile");
  const challenge = twitterCustody.beginSignIn(profile);
  setCustody({ kind: "awaiting-oauth", nonce: challenge.nonce });
  await new Promise((r) => setTimeout(r, 150));
  const session = await twitterCustody.completeSignIn(challenge);
  if (custody.kind !== "awaiting-oauth" || custody.nonce !== challenge.nonce) {
    return;
  }
  setCustody({
    kind: "linked",
    sub: session.sub,
    userId: session.userId,
    sessionId: session.sessionId,
    address: session.address,
    owner: session.owner,
  });
}

export function signOut(): void {
  setCustody({ kind: "anonymous" });
}

// Test/dev affordance: reset to seeded state and clear custody.
export function resetMockState(): void {
  state = seedAppState();
  custody = { kind: "anonymous" };
  notify();
}
