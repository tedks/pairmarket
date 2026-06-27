import type { Brand } from "./brand";
import type {
  InviteId,
  MarketId,
  MistAmount,
  Nonce,
  PositionId,
  SuiAddress,
  TxDigest,
  WalrusBlobId,
} from "./ids";

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

export type WagerOutcome = "yes" | "no";

export type ResolutionOutcome = WagerOutcome | "invalid";

type BaseTxSpec<TKind extends TxKind> = {
  readonly kind: TKind;
  readonly sender: SuiAddress;
  readonly nonce: Nonce;
};

export type CreateMarketTxSpec = BaseTxSpec<"create-market"> & {
  readonly payload: {
    readonly termsHash: string;
  };
};

export type ConsentAsSubjectTxSpec = BaseTxSpec<"consent-as-subject"> & {
  readonly market: MarketId;
  readonly payload: {
    readonly termsHash: string;
    readonly subjectRole: "subject-a" | "subject-b";
  };
};

export type AcceptInviteTxSpec = BaseTxSpec<"accept-invite"> & {
  readonly market: MarketId;
  readonly payload: {
    readonly invite: InviteId;
  };
};

export type PlaceWagerTxSpec = BaseTxSpec<"place-wager"> & {
  readonly market: MarketId;
  readonly payload: {
    readonly outcome: WagerOutcome;
    readonly amountMist: MistAmount;
  };
};

export type SubmitAttestationTxSpec = BaseTxSpec<"submit-attestation"> & {
  readonly market: MarketId;
  readonly payload: {
    readonly outcome: ResolutionOutcome;
    readonly evidence?: WalrusBlobId;
  };
};

export type OpenChallengeTxSpec = BaseTxSpec<"open-challenge"> & {
  readonly market: MarketId;
  readonly payload: {
    readonly bondMist: MistAmount;
    readonly evidence: WalrusBlobId;
  };
};

export type ClaimPayoutTxSpec = BaseTxSpec<"claim-payout"> & {
  readonly market: MarketId;
  readonly payload: {
    readonly position: PositionId;
  };
};

export type RefundTxSpec = BaseTxSpec<"refund"> & {
  readonly market: MarketId;
  readonly payload: {
    readonly position: PositionId;
  };
};

export type MigrateCustodyTxSpec = BaseTxSpec<"migrate-custody"> & {
  readonly payload: {
    readonly to: SuiAddress;
  };
};

export type TxSpec =
  | CreateMarketTxSpec
  | ConsentAsSubjectTxSpec
  | AcceptInviteTxSpec
  | PlaceWagerTxSpec
  | SubmitAttestationTxSpec
  | OpenChallengeTxSpec
  | ClaimPayoutTxSpec
  | RefundTxSpec
  | MigrateCustodyTxSpec;

export type TxSpecFor<TKind extends TxKind> = Extract<
  TxSpec,
  { readonly kind: TKind }
>;

export type TxIntent<TKind extends TxKind = TxKind> = Brand<
  TxSpecFor<TKind>,
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
    readonly digest: TxDigest;
  },
  "SubmittedIntent"
>;
