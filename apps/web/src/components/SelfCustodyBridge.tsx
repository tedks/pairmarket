import { useEffect, type JSX } from "react";
import {
  useCurrentAccount,
  useCurrentNetwork,
  useCurrentWallet,
  useWalletConnection,
} from "@mysten/dapp-kit-react";
import { parseSuiAddress } from "@pairmarket/core";
import { getCustody, setCustody } from "../mock/store.ts";

export function SelfCustodyBridge(): JSX.Element | null {
  const account = useCurrentAccount();
  const wallet = useCurrentWallet();
  const network = useCurrentNetwork();
  const connection = useWalletConnection();

  useEffect(() => {
    if (connection.isConnected && account) {
      setCustody({
        kind: "self-custody",
        address: parseSuiAddress(account.address),
        walletName: wallet?.name ?? "Sui wallet",
        network,
      });
      return;
    }

    if (getCustody().kind === "self-custody") {
      setCustody({ kind: "anonymous" });
    }
  }, [account, connection.isConnected, network, wallet?.name]);

  return null;
}
