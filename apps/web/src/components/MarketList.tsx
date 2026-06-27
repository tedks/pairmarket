import type { JSX } from "react";
import type { Route } from "../App.tsx";
import type { AppState, Market } from "../types.ts";
import {
  formatMarketId,
  formatSui,
  operationalizationLabel,
  phaseLabel,
  formatDuration,
} from "../format.ts";
import { payoutPool, viewerIsMember } from "../mock/intents.ts";

type Props = {
  readonly state: AppState;
  readonly setRoute: (r: Route) => void;
};

export function MarketList({ state, setRoute }: Props): JSX.Element {
  const markets = [...state.markets.values()]
    .filter((m) => viewerIsMember(state, m))
    .sort((a, b) => phaseSortRank(a) - phaseSortRank(b));

  return (
    <section className="market-list">
      <div className="market-list-head">
        <h1>Your markets</h1>
        <p className="market-list-sub">
          {markets.length} visible · private by invitation
        </p>
      </div>
      <table className="market-table" role="table">
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Operationalization</th>
            <th scope="col">Phase</th>
            <th scope="col">Pool</th>
            <th scope="col">Deadline</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => (
            <MarketRow
              key={m.id}
              market={m}
              state={state}
              onOpen={() => setRoute({ kind: "market", id: m.id })}
            />
          ))}
          {markets.length === 0 ? (
            <tr>
              <td colSpan={6} className="market-table-empty">
                No markets yet. Create one or wait for an invite.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function MarketRow({
  market,
  state,
  onOpen,
}: {
  readonly market: Market;
  readonly state: AppState;
  readonly onOpen: () => void;
}): JSX.Element {
  const role = describeViewerRole(state, market);
  const action = describeAction(state, market);
  return (
    <tr
      className="market-row"
      data-testid={`market-row-${market.id}`}
      data-phase={market.phase}
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
    >
      <td>
        <div className="market-title-cell">
          <span className="market-title">{market.content.title}</span>
          <span className="market-sub">
            {formatMarketId(market.id)} · {role}
          </span>
        </div>
      </td>
      <td>{operationalizationLabel(market.operationalization)}</td>
      <td>
        <span className={`phase-chip phase-${market.phase}`}>
          {phaseLabel(market.phase)}
        </span>
      </td>
      <td>{formatSui(payoutPool(market))}</td>
      <td>{formatDuration(state.nowMs, market.resolutionDeadlineMs)}</td>
      <td>
        {action ? (
          <span className="action-chip">{action}</span>
        ) : (
          <span className="action-none">—</span>
        )}
      </td>
    </tr>
  );
}

function describeViewerRole(state: AppState, market: Market): string {
  if (market.creator === state.viewer) return "creator";
  const subj = market.subjects.find((s) => s.user === state.viewer);
  if (subj) return subj.role === "subject-a" ? "subject A" : "subject B";
  const inv = market.invites.find((i) => i.invitee === state.viewer);
  if (inv) return inv.accepted ? "participant" : "invitee";
  return "observer";
}

function describeAction(state: AppState, market: Market): string | undefined {
  const subj = market.subjects.find((s) => s.user === state.viewer);
  if (subj && subj.consent.status === "pending") return "Consent required";
  if (
    market.phase === "attestation-pending" &&
    subj &&
    !market.attestations.some((a) => a.attestor === state.viewer)
  )
    return "Attest outcome";
  const invite = market.invites.find(
    (i) => i.invitee === state.viewer && !i.accepted,
  );
  if (invite && (market.phase === "trading" || market.phase === "proposed"))
    return "Accept invite";
  const open = market.invites.find(
    (i) => i.invitee === state.viewer && i.accepted,
  );
  const hasPosition = market.positions.some((p) => p.owner === state.viewer);
  if (open && market.phase === "trading" && !hasPosition) return "Place wager";
  if (
    market.phase === "settled" &&
    market.positions.some(
      (p) =>
        p.owner === state.viewer &&
        !p.claimed &&
        (market.settledOutcome === "invalid" ||
          p.outcome === market.settledOutcome),
    )
  )
    return "Claim payout";
  return undefined;
}

function phaseSortRank(m: Market): number {
  switch (m.phase) {
    case "proposed":
      return 0;
    case "trading":
      return 1;
    case "attestation-pending":
      return 2;
    case "challenge-window-open":
      return 3;
    case "locked":
      return 4;
    case "draft":
      return 5;
    case "settled":
      return 10;
    case "cancelled":
    case "expired":
    case "invalid-refund":
      return 20;
  }
}
