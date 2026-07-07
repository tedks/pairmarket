import { useEffect, type JSX } from "react";
import {
  useCurrentAccount,
  useCurrentNetwork,
  useCurrentWallet,
  useWalletConnection,
} from "@mysten/dapp-kit-react";
import { getCustody, setCustody } from "../state/store.ts";
import { nextSelfCustodyState } from "../self-custody.ts";
import {
  autoGasRequestForConnectedWallet,
  maybeRequestLocalnetGas,
  reserveAutoGasAttempt,
} from "../sui/gas.ts";

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

  useEffect(() => {
    const request = autoGasRequestForConnectedWallet({
      custody: getCustody(),
      connected: connection.isConnected && account !== null,
      rawAddress: account?.address,
      network,
    });
    if (request === undefined) return;

    if (!reserveAutoGasAttempt(request)) return;

    void maybeRequestLocalnetGas(request).catch((error: unknown) => {
      console.warn(
        "Unable to request localnet gas for connected wallet",
        error,
      );
    });
  }, [account, connection.isConnected, network]);

  return null;
}
