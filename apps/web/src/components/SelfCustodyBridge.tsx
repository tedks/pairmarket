import { useEffect, type JSX } from "react";
import {
  useCurrentAccount,
  useCurrentNetwork,
  useCurrentWallet,
  useWalletConnection,
} from "@mysten/dapp-kit-react";
import { getCustody, setCustody } from "../mock/store.ts";
import { nextSelfCustodyState } from "../self-custody.ts";

export function SelfCustodyBridge(): JSX.Element | null {
  const account = useCurrentAccount();
  const wallet = useCurrentWallet();
  const network = useCurrentNetwork();
  const connection = useWalletConnection();

  useEffect(() => {
    const next = nextSelfCustodyState(getCustody(), {
      connected: connection.isConnected && account !== null,
      address: account?.address,
      walletName: wallet?.name,
      network,
    });
    if (next !== null) setCustody(next);
  }, [account, connection.isConnected, network, wallet?.name]);

  return null;
}
