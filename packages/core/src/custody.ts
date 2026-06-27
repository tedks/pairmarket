import type { KeyRef, Nonce, SuiAddress, TwitterSub } from "./ids";

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
  | { readonly kind: "awaiting-oauth"; readonly nonce: Nonce }
  | {
      readonly kind: "linked";
      readonly sub: TwitterSub;
      readonly address: SuiAddress;
      readonly owner: AccountOwner;
    };

export function requireCustodyState<TKind extends CustodyState["kind"]>(
  state: CustodyState,
  kind: TKind,
): Extract<CustodyState, { readonly kind: TKind }> {
  if (state.kind !== kind) {
    throw new Error(`Expected custody state ${kind}, got ${state.kind}`);
  }

  return state as Extract<CustodyState, { readonly kind: TKind }>;
}
