import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { MarketId } from "@pairmarket/core";
import { Header } from "./components/Header.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { MarketList } from "./components/MarketList.tsx";
import { MarketDetail } from "./components/MarketDetail.tsx";
import { CreateMarket } from "./components/CreateMarket.tsx";
import { AccountPanel } from "./components/AccountPanel.tsx";
import { useAppState, useCustody } from "./mock/store.ts";

export type Route =
  | { readonly kind: "markets" }
  | { readonly kind: "market"; readonly id: MarketId }
  | { readonly kind: "new" }
  | { readonly kind: "account" };

export function App(): JSX.Element {
  const state = useAppState();
  const custody = useCustody();
  const [route, setRoute] = useState<Route>({ kind: "markets" });

  const viewerProfile = useMemo(
    () => state.users.get(state.viewer),
    [state.users, state.viewer],
  );
  if (!viewerProfile) throw new Error("viewer profile missing");

  return (
    <div className="app-shell">
      <Header
        viewer={viewerProfile}
        users={[...state.users.values()]}
        custody={custody}
      />
      <div className="app-body">
        <Sidebar route={route} setRoute={setRoute} state={state} />
        <main className="app-main">
          {route.kind === "markets" ? (
            <MarketList state={state} setRoute={setRoute} />
          ) : route.kind === "market" ? (
            <MarketDetail
              state={state}
              marketId={route.id}
              setRoute={setRoute}
            />
          ) : route.kind === "new" ? (
            <CreateMarket state={state} setRoute={setRoute} />
          ) : (
            <AccountPanel state={state} custody={custody} />
          )}
        </main>
      </div>
    </div>
  );
}
