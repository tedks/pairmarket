import { useSyncExternalStore } from "react";
import type { CustodyState } from "@pairmarket/core";
import {
  parseNonce,
  parseSuiAddress,
  parseTwitterSub,
  parseKeyRef,
} from "@pairmarket/core";
import type { AppState } from "../types.ts";
import { seedAppState } from "./seed.ts";

type Listener = () => void;

let state: AppState = seedAppState();
let custody: CustodyState = { kind: "anonymous" };
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

// Mock OAuth: the real flow is a redirect to Twitter; here we synthesize
// a nonce, briefly transition through awaiting-oauth, and resolve linked
// with the seeded address for the current viewer.
export async function signInWithTwitter(): Promise<void> {
  const startNonce = parseNonce(crypto.randomUUID());
  setCustody({ kind: "awaiting-oauth", nonce: startNonce });
  await new Promise((r) => setTimeout(r, 150));
  const profile = state.users.get(state.viewer);
  if (!profile) throw new Error("no viewer profile");
  setCustody({
    kind: "linked",
    sub: parseTwitterSub(`twitter:${profile.handle}`),
    address: parseSuiAddress(profile.address),
    owner: {
      kind: "custodial",
      keyRef: parseKeyRef(`kms://mock/${profile.handle}`),
    },
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
