import {
  tryParseSuiAddress,
  tryParseSuiNetwork,
  type CustodyState,
  type SuiNetwork,
} from "@pairmarket/core";

export type WalletCustodySnapshot = {
  readonly connected: boolean;
  readonly address: string | undefined;
  readonly walletName: string | undefined;
  readonly network: SuiNetwork | string;
};

export function nextSelfCustodyState(
  current: CustodyState,
  wallet: WalletCustodySnapshot,
): CustodyState | null {
  if (!wallet.connected) {
    return current.kind === "self-custody" ? { kind: "anonymous" } : null;
  }

  if (current.kind !== "anonymous" && current.kind !== "self-custody") {
    return null;
  }

  const address = tryParseSuiAddress(wallet.address);
  const network = tryParseSuiNetwork(wallet.network);
  if (!address.ok || !network.ok) {
    return current.kind === "self-custody" ? { kind: "anonymous" } : null;
  }

  return {
    kind: "self-custody",
    address: address.value,
    walletName: wallet.walletName ?? "Sui wallet",
    network: network.value,
  };
}
