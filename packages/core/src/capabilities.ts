import type { Brand } from "./brand";
import type { MarketId, UserId } from "./ids";

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

export type CustodyScope =
  | {
      readonly kind: "sign-tx";
      readonly market?: MarketId;
      readonly maxAmountMist?: bigint;
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
