import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

const RPC_URLS = {
  localnet:
    import.meta.env.VITE_PAIRMARKET_SUI_RPC_URL ?? "http://127.0.0.1:9000",
  devnet: getJsonRpcFullnodeUrl("devnet"),
  testnet: getJsonRpcFullnodeUrl("testnet"),
  mainnet: getJsonRpcFullnodeUrl("mainnet"),
} as const;

const DEFAULT_NETWORK =
  import.meta.env.VITE_PAIRMARKET_NETWORK === "devnet" ||
  import.meta.env.VITE_PAIRMARKET_NETWORK === "testnet" ||
  import.meta.env.VITE_PAIRMARKET_NETWORK === "mainnet"
    ? import.meta.env.VITE_PAIRMARKET_NETWORK
    : "localnet";

export const WALLET_STORAGE_KEY = "pairmarket:selected-wallet-and-address";

export const dAppKit = createDAppKit({
  networks: ["localnet", "devnet", "testnet", "mainnet"],
  defaultNetwork: DEFAULT_NETWORK,
  createClient: (network) =>
    new SuiJsonRpcClient({ network, url: RPC_URLS[network] }),
  enableBurnerWallet: import.meta.env.VITE_PAIRMARKET_ENABLE_BURNER === "1",
  storageKey: WALLET_STORAGE_KEY,
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
