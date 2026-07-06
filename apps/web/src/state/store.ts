import { useSyncExternalStore } from "react";
import {
  parseSuiAddress,
  parseUnixMs,
  parseUserId,
  type CustodyState,
  type SuiAddress,
} from "@pairmarket/core";
import type { AppState } from "../types.ts";
import { formatAddress } from "../format.ts";

type Listener = () => void;

const ANONYMOUS_USER_ID = parseUserId("anonymous");
const ANONYMOUS_ADDRESS = parseSuiAddress("0x1");

function anonymousState(): AppState {
  return {
    viewer: ANONYMOUS_USER_ID,
    users: new Map([
      [
        ANONYMOUS_USER_ID,
        {
          id: ANONYMOUS_USER_ID,
          handle: "anonymous",
          displayName: "Connect wallet",
          address: ANONYMOUS_ADDRESS,
        },
      ],
    ]),
    markets: new Map(),
    intents: [],
    nowMs: parseUnixMs(Date.now()),
  };
}

let state: AppState = anonymousState();
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
  if (next.kind === "self-custody") {
    state = stateWithWalletViewer(state, next.address);
  } else if (next.kind === "anonymous") {
    state = { ...state, viewer: ANONYMOUS_USER_ID };
  }
  notify();
}

function stateWithWalletViewer(prev: AppState, address: SuiAddress): AppState {
  const id = parseUserId(address);
  const users = new Map(prev.users);
  users.set(id, {
    id,
    handle: address,
    displayName: formatAddress(address),
    address,
  });
  return {
    ...prev,
    viewer: id,
    users,
    nowMs: parseUnixMs(Date.now()),
  };
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

export function signOut(): void {
  setCustody({ kind: "anonymous" });
}

export function resetAppState(): void {
  state = anonymousState();
  custody = { kind: "anonymous" };
  notify();
}
