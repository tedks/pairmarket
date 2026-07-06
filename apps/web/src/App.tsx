import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { MarketId } from "@pairmarket/core";
import { Header } from "./components/Header.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { MarketList } from "./components/MarketList.tsx";
import { MarketDetail } from "./components/MarketDetail.tsx";
import { CreateMarket } from "./components/CreateMarket.tsx";
import { AccountPanel } from "./components/AccountPanel.tsx";
import { SelfCustodyBridge } from "./components/SelfCustodyBridge.tsx";
import { useAppState, useCustody } from "./state/store.ts";
import { useChainAppState } from "./sui/state.ts";

export type Route =
  | { readonly kind: "markets"; readonly filter: "all" | "needs-you" }
  | { readonly kind: "market"; readonly id: MarketId }
  | { readonly kind: "new" }
  | { readonly kind: "account" };

export function App(): JSX.Element {
  const localState = useAppState();
  const chain = useChainAppState(localState);
  const state = chain.state;
  const custody = useCustody();
  const [route, setRoute] = useState<Route>({ kind: "markets", filter: "all" });

  const viewerProfile = useMemo(
    () => state.users.get(state.viewer),
    [state.users, state.viewer],
  );
  if (!viewerProfile) throw new Error("viewer profile missing");

  return (
    <div className="app-shell">
      <SelfCustodyBridge />
      <Header viewer={viewerProfile} custody={custody} />
      <div className="app-body">
        <Sidebar route={route} setRoute={setRoute} state={state} />
        <main className="app-main">
          {chain.error ? (
            <div className="chain-banner" role="status">
              {chain.error}
            </div>
          ) : chain.loading ? (
            <div className="chain-banner" role="status">
              Syncing localnet objects...
            </div>
          ) : null}
          {route.kind === "markets" ? (
            <MarketList
              state={state}
              filter={route.filter}
              setRoute={setRoute}
            />
          ) : route.kind === "market" ? (
            <MarketDetail
              state={state}
              marketId={route.id}
              setRoute={setRoute}
              refresh={chain.refresh}
            />
          ) : route.kind === "new" ? (
            <CreateMarket setRoute={setRoute} refresh={chain.refresh} />
          ) : (
            <AccountPanel state={state} custody={custody} />
          )}
        </main>
      </div>
    </div>
  );
}
