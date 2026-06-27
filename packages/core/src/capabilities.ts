import type { Brand } from "./brand.js";
import type { MarketId, MistAmount, UserId } from "./ids.js";
import type { TxIntent, TxKind } from "./tx.js";

export type InviteCap = Brand<
  {
    readonly market: MarketId;
    readonly invitee: UserId;
  },
  "InviteCap"
>;

export type WagerCap = Brand<
  {
    readonly market: MarketId;
    readonly participant: UserId;
  },
  "WagerCap"
>;

export type ResolverCap = Brand<
  {
    readonly market: MarketId;
  },
  "ResolverCap"
>;

export type MarketScopedTxKind = Extract<
  TxKind,
  | "consent-as-subject"
  | "accept-invite"
  | "place-wager"
  | "submit-attestation"
  | "open-challenge"
  | "claim-payout"
  | "refund"
>;

export type AccountScopedTxKind = Extract<TxKind, "create-market">;

export type CustodyScope =
  | {
      readonly kind: "sign-market-tx";
      readonly market: MarketId;
      readonly txKinds: readonly MarketScopedTxKind[];
      readonly maxAmountMist: MistAmount;
    }
  | {
      readonly kind: "sign-account-tx";
      readonly txKinds: readonly AccountScopedTxKind[];
    }
  | {
      readonly kind: "sign-attestation";
      readonly market: MarketId;
    }
  | {
      readonly kind: "rotate-key";
    }
  | {
      readonly kind: "migrate-custody";
    };

export type CustodyCap = Brand<
  {
    readonly user: UserId;
    readonly scope: CustodyScope;
  },
  "CustodyCap"
>;

export type SigningCustodyScope = Extract<
  CustodyScope,
  { readonly kind: "sign-market-tx" | "sign-account-tx" }
>;

/**
 * Config-time helper only. It preserves literal txKinds from checked fixtures or
 * static policy tables; runtime authorization must still inspect the concrete
 * CustodyScope value before signing.
 */
export function defineSigningCustodyScope<
  const TScope extends SigningCustodyScope,
>(scope: TScope): TScope {
  return scope;
}

export type CustodyScopeTxKind<TScope extends SigningCustodyScope> =
  TScope extends { readonly txKinds: readonly (infer TKind extends TxKind)[] }
    ? TKind
    : never;

export type CustodyScopeTxIntent<TScope extends SigningCustodyScope> = TxIntent<
  CustodyScopeTxKind<TScope>
>;
