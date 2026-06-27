import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const GRPC_URLS = {
  localnet: "http://127.0.0.1:9000",
  devnet: "https://fullnode.devnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
} as const;

export const WALLET_STORAGE_KEY = "pairmarket:selected-wallet-and-address";

export const dAppKit = createDAppKit({
  networks: ["localnet", "devnet", "testnet", "mainnet"],
  defaultNetwork: "testnet",
  createClient: (network) =>
    new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] }),
  // Playwright uses the dev-only burner wallet; production relies on real wallets.
  enableBurnerWallet: import.meta.env.DEV,
  slushWalletConfig: null,
  storageKey: WALLET_STORAGE_KEY,
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
