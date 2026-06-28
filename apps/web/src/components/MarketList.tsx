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
import { viewerMarketAction } from "../market-actions.ts";

type Props = {
  readonly state: AppState;
  readonly filter: "all" | "needs-you";
  readonly setRoute: (r: Route) => void;
};

export function MarketList({ state, filter, setRoute }: Props): JSX.Element {
  const memberMarkets = [...state.markets.values()]
    .filter((m) => viewerIsMember(state, m))
    .sort((a, b) => phaseSortRank(a) - phaseSortRank(b));
  const markets =
    filter === "needs-you"
      ? memberMarkets.filter((m) => viewerMarketAction(state, m))
      : memberMarkets;

  return (
    <section className="market-list">
      <div className="market-list-head">
        <h1>{filter === "needs-you" ? "Needs you" : "Your markets"}</h1>
        <p className="market-list-sub">
          {filter === "needs-you"
            ? `${markets.length} actionable · ${memberMarkets.length} visible total`
            : `${markets.length} visible · private by invitation`}
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
                {filter === "needs-you"
                  ? "No markets need action from you."
                  : "No markets yet. Create one or wait for an invite."}
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
  const action = viewerMarketAction(state, market);
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
      <td data-label="Market">
        <div className="market-title-cell">
          <span className="market-title">{market.content.title}</span>
          <span className="market-sub">
            {formatMarketId(market.id)} · {role}
          </span>
        </div>
      </td>
      <td data-label="Operationalization">
        {operationalizationLabel(market.operationalization)}
      </td>
      <td data-label="Phase">
        <span className={`phase-chip phase-${market.phase}`}>
          {phaseLabel(market.phase)}
        </span>
      </td>
      <td data-label="Pool">{formatSui(payoutPool(market))}</td>
      <td data-label="Deadline">
        {formatDuration(state.nowMs, market.resolutionDeadlineMs)}
      </td>
      <td data-label="Action">
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
