import type { WagerOutcome } from "@pairmarket/core";
import type { AppState, Market } from "./types.ts";

export function payoutPool(market: Market): bigint {
  return (
    (market.yesPoolMist as bigint) +
    (market.noPoolMist as bigint) +
    (market.payoutPoolMist as bigint)
  );
}

export function sharesByOutcome(market: Market, outcome: WagerOutcome): bigint {
  return outcome === "yes"
    ? (market.yesSharesMist as bigint)
    : (market.noSharesMist as bigint);
}

export function viewerIsMember(state: AppState, market: Market): boolean {
  if (market.creator === state.viewer) return true;
  if (market.invites.some((i) => i.invitee === state.viewer)) return true;
  if (market.positions.some((p) => p.owner === state.viewer)) return true;
  return false;
}
