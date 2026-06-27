import type { JSX } from "react";
import type { Route } from "../App.tsx";
import type { AppState } from "../types.ts";
import { viewerIsMember } from "../mock/intents.ts";

type SidebarProps = {
  readonly route: Route;
  readonly setRoute: (r: Route) => void;
  readonly state: AppState;
};

export function Sidebar({ route, setRoute, state }: SidebarProps): JSX.Element {
  const memberMarkets = [...state.markets.values()].filter((m) =>
    viewerIsMember(state, m),
  );
  const needsAction = memberMarkets.filter((m) => {
    const subj = m.subjects.find((s) => s.user === state.viewer);
    if (subj && subj.consent.status === "pending") return true;
    if (
      m.phase === "attestation-pending" &&
      m.subjects.some((s) => s.user === state.viewer) &&
      !m.attestations.some((a) => a.attestor === state.viewer)
    )
      return true;
    if (
      m.phase === "settled" &&
      m.positions.some(
        (p) =>
          p.owner === state.viewer &&
          !p.claimed &&
          (m.settledOutcome === "invalid" || p.outcome === m.settledOutcome),
      )
    )
      return true;
    return false;
  }).length;

  return (
    <nav className="app-sidebar" aria-label="primary">
      <NavItem
        label="Markets"
        badge={memberMarkets.length}
        active={route.kind === "markets" || route.kind === "market"}
        onClick={() => setRoute({ kind: "markets" })}
      />
      <NavItem
        label="Needs you"
        badge={needsAction}
        emphasize={needsAction > 0}
        active={false}
        onClick={() => setRoute({ kind: "markets" })}
      />
      <NavItem
        label="New market"
        active={route.kind === "new"}
        onClick={() => setRoute({ kind: "new" })}
      />
      <div className="sidebar-spacer" />
      <NavItem
        label="Account"
        active={route.kind === "account"}
        onClick={() => setRoute({ kind: "account" })}
      />
    </nav>
  );
}

function NavItem({
  label,
  badge,
  active,
  emphasize,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly badge?: number;
  readonly emphasize?: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  const cls = [
    "sidebar-item",
    active ? "sidebar-item-active" : "",
    emphasize ? "sidebar-item-emphasize" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} onClick={onClick}>
      <span>{label}</span>
      {badge !== undefined && badge > 0 ? (
        <span className="sidebar-badge">{badge}</span>
      ) : null}
    </button>
  );
}
