import type { AppState, Market } from "./types.ts";

export type ViewerMarketAction =
  | "Consent required"
  | "Accept invite"
  | "Place wager"
  | "Attest outcome"
  | "Claim payout";

export function viewerMarketAction(
  state: AppState,
  market: Market,
): ViewerMarketAction | undefined {
  const subject = market.subjects.find((s) => s.user === state.viewer);
  if (subject?.consent.status === "pending") return "Consent required";

  const invite = market.invites.find((i) => i.invitee === state.viewer);
  if (
    invite &&
    !invite.accepted &&
    (market.phase === "trading" || market.phase === "proposed")
  ) {
    return "Accept invite";
  }

  const hasPosition = market.positions.some((p) => p.owner === state.viewer);
  if (invite?.accepted && market.phase === "trading" && !hasPosition) {
    return "Place wager";
  }

  if (
    market.phase === "attestation-pending" &&
    subject &&
    !market.attestations.some((a) => a.attestor === state.viewer)
  ) {
    return "Attest outcome";
  }

  if (
    market.phase === "settled" &&
    market.positions.some(
      (p) =>
        p.owner === state.viewer &&
        !p.claimed &&
        (market.settledOutcome === "invalid" ||
          p.outcome === market.settledOutcome),
    )
  ) {
    return "Claim payout";
  }

  return undefined;
}
