import type { Brand } from "./brand";
import type { MarketId, Nonce, SuiAddress } from "./ids";

export type TxKind =
  | "create-market"
  | "consent-as-subject"
  | "accept-invite"
  | "place-wager"
  | "submit-attestation"
  | "open-challenge"
  | "claim-payout"
  | "refund"
  | "migrate-custody";

export type TxSpec<TKind extends TxKind = TxKind> = {
  readonly kind: TKind;
  readonly sender: SuiAddress;
  readonly market?: MarketId;
  readonly nonce: Nonce;
  readonly payload: unknown;
};

export type TxIntent<TKind extends TxKind = TxKind> = Brand<
  TxSpec<TKind>,
  readonly ["TxIntent", TKind]
>;

export type SignedIntent<TKind extends TxKind = TxKind> = Brand<
  {
    readonly intent: TxIntent<TKind>;
    readonly signature: Uint8Array;
  },
  readonly ["SignedIntent", TKind]
>;

export type SubmittedIntent = Brand<
  {
    readonly digest: string;
  },
  "SubmittedIntent"
>;
