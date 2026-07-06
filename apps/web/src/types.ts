import type {
  InviteId,
  MarketId,
  MistAmount,
  PositionId,
  SuiAddress,
  SuiObjectId,
  TxIntent,
  TxKind,
  UnixMs,
  UserId,
  WagerOutcome,
} from "@pairmarket/core";

export type OperationalizationKind =
  | { readonly kind: "lasts-n-dates"; readonly n: number }
  | { readonly kind: "together-by-date"; readonly deadlineMs: UnixMs }
  | { readonly kind: "meet-by-date"; readonly deadlineMs: UnixMs };

export type VisibilityScope = "friends" | "friends-of-friends" | "public";

export type MarketPhase =
  | "draft"
  | "proposed"
  | "trading"
  | "locked"
  | "attestation-pending"
  | "challenge-window-open"
  | "settled"
  | "cancelled"
  | "expired"
  | "invalid-refund";

export type SubjectRole = "subject-a" | "subject-b";

export type SubjectConsent =
  | { readonly status: "pending" }
  | { readonly status: "accepted"; readonly atMs: UnixMs }
  | { readonly status: "declined"; readonly atMs: UnixMs };

export type Subject = {
  readonly role: SubjectRole;
  readonly user: UserId;
  readonly consent: SubjectConsent;
};

export type Invite = {
  readonly id: InviteId;
  readonly market: MarketId;
  readonly invitee: UserId;
  readonly maxStakeMist: MistAmount;
  readonly accepted: boolean;
};

export type Position = {
  readonly id: PositionId;
  readonly market: MarketId;
  readonly owner: UserId;
  readonly outcome: WagerOutcome;
  readonly amountMist: MistAmount;
  readonly claimed: boolean;
};

export type Attestation = {
  readonly attestor: UserId;
  readonly outcome: "yes" | "no" | "invalid";
  readonly atMs: UnixMs;
};

export type MarketContent = {
  // SEAL-encrypted client-side; in this prototype we model the policy
  // boundary by gating reveal in the UI rather than encrypting in memory.
  readonly title: string;
  readonly prompt: string;
};

export type Market = {
  readonly id: MarketId;
  readonly creator: UserId;
  readonly subjects: readonly [Subject, Subject];
  readonly visibility: VisibilityScope;
  readonly operationalization: OperationalizationKind;
  readonly closeMs: UnixMs;
  readonly resolutionDeadlineMs: UnixMs;
  readonly challengeWindowMs: number;
  readonly content: MarketContent;
  readonly phase: MarketPhase;
  readonly yesPoolMist: MistAmount;
  readonly noPoolMist: MistAmount;
  readonly payoutPoolMist: MistAmount;
  readonly yesSharesMist: MistAmount;
  readonly noSharesMist: MistAmount;
  readonly invites: readonly Invite[];
  readonly positions: readonly Position[];
  readonly attestations: readonly Attestation[];
  readonly settledOutcome?: "yes" | "no" | "invalid";
  readonly createdAtMs: UnixMs;
};

export type UserProfile = {
  readonly id: UserId;
  readonly handle: string;
  readonly displayName: string;
  readonly profileObjectId?: SuiObjectId;
  readonly address: SuiAddress;
};

export type Friendship = {
  readonly a: UserId;
  readonly b: UserId;
};

export type FriendRequest = {
  readonly id: SuiObjectId;
  readonly requester: UserId;
  readonly target: UserId;
};

export type IntentRecord = {
  readonly digest: string;
  readonly kind: TxKind;
  readonly intent: TxIntent;
  readonly atMs: UnixMs;
};

export type AppState = {
  readonly viewer: UserId;
  readonly users: ReadonlyMap<UserId, UserProfile>;
  readonly friendships: readonly Friendship[];
  readonly friendRequests: readonly FriendRequest[];
  readonly markets: ReadonlyMap<MarketId, Market>;
  readonly intents: readonly IntentRecord[];
  readonly nowMs: UnixMs;
};
