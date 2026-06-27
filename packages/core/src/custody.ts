import type { KeyRef, Nonce, SuiAddress, TwitterSub } from "./ids.js";

export type AccountOwner =
  | { readonly kind: "custodial"; readonly keyRef: KeyRef }
  | {
      readonly kind: "migrating";
      readonly from: KeyRef;
      readonly to: SuiAddress;
    }
  | { readonly kind: "self-custody"; readonly address: SuiAddress }
  | { readonly kind: "locked"; readonly reason: string };

export type CustodyState =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "self-custody";
      readonly address: SuiAddress;
      readonly walletName: string;
      readonly network: string;
    }
  | { readonly kind: "awaiting-oauth"; readonly nonce: Nonce }
  | {
      readonly kind: "linked";
      readonly sub: TwitterSub;
      readonly address: SuiAddress;
      readonly owner: AccountOwner;
    };

export class CustodyStateError extends Error {
  readonly expected: CustodyState["kind"];
  readonly actual: CustodyState["kind"];

  constructor(expected: CustodyState["kind"], actual: CustodyState["kind"]) {
    super(`Expected custody state ${expected}, got ${actual}`);
    this.name = "CustodyStateError";
    this.expected = expected;
    this.actual = actual;
  }
}

export function isCustodyState<TKind extends CustodyState["kind"]>(
  state: CustodyState,
  kind: TKind,
): state is Extract<CustodyState, { readonly kind: TKind }> {
  return state.kind === kind;
}

export function requireCustodyState<TKind extends CustodyState["kind"]>(
  state: CustodyState,
  kind: TKind,
): Extract<CustodyState, { readonly kind: TKind }> {
  if (!isCustodyState(state, kind)) {
    throw new CustodyStateError(kind, state.kind);
  }

  return state;
}
