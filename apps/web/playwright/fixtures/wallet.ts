import { test as base, type Page } from "@playwright/test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toBase64 } from "@mysten/sui/utils";

const NETWORK = "localnet" as const;

export type WalletFixture = {
  readonly walletKeypair: Ed25519Keypair;
  readonly walletAddress: string;
  readonly walletPage: Page;
};

export const test = base.extend<WalletFixture>({
  walletKeypair: async ({}, use) => {
    await use(new Ed25519Keypair());
  },

  walletAddress: async ({ walletKeypair }, use) => {
    await use(walletKeypair.getPublicKey().toSuiAddress());
  },

  walletPage: async ({ page, walletKeypair, walletAddress }, use) => {
    const publicKeyBase64 = toBase64(walletKeypair.getPublicKey().toRawBytes());

    await page.exposeFunction(
      "__signTxBytes",
      async (
        base64Bytes: string,
      ): Promise<{ readonly signature: string; readonly bytes: string }> => {
        const txBytes = Uint8Array.from(atob(base64Bytes), (c) =>
          c.charCodeAt(0),
        );
        const { signature } = await walletKeypair.signTransaction(txBytes);
        return { signature, bytes: base64Bytes };
      },
    );

    await page.exposeFunction(
      "__signPersonalMessage",
      async (
        base64Message: string,
      ): Promise<{ readonly signature: string; readonly bytes: string }> => {
        const message = Uint8Array.from(atob(base64Message), (c) =>
          c.charCodeAt(0),
        );
        const { signature } = await walletKeypair.signPersonalMessage(message);
        return { signature, bytes: base64Message };
      },
    );

    await page.addInitScript(
      ({ address, publicKeyBase64, network }) => {
        const account = {
          address,
          publicKey: Uint8Array.from(atob(publicKeyBase64), (c) =>
            c.charCodeAt(0),
          ),
          chains: [`sui:${network}`] as const,
          features: [
            "sui:signTransaction",
            "sui:signAndExecuteTransaction",
            "sui:signPersonalMessage",
          ] as const,
        };

        let accounts: (typeof account)[] = [];
        let connected = false;
        const listeners = new Map<string, Set<(d: unknown) => void>>();
        const emit = (event: string, data: unknown) => {
          listeners.get(event)?.forEach((listener) => listener(data));
        };
        const base64Re =
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
        const toBase64Chunked = (bytes: Uint8Array): string => {
          const chunk = 0x8000;
          let encoded = "";
          for (let i = 0; i < bytes.length; i += chunk) {
            encoded += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          return btoa(encoded);
        };

        const signTransaction = async (input: {
          readonly transaction: { readonly toJSON: () => Promise<string> };
        }) => {
          const payload = await input.transaction.toJSON();
          if (!base64Re.test(payload)) {
            throw new Error("Generated-key wallet expected base64 tx bytes");
          }
          const sign = (
            window as unknown as {
              readonly __signTxBytes: (b64: string) => Promise<{
                readonly signature: string;
                readonly bytes: string;
              }>;
            }
          ).__signTxBytes;
          return sign(payload);
        };

        const signPersonalMessage = async (input: {
          readonly message: Uint8Array;
        }) => {
          const sign = (
            window as unknown as {
              readonly __signPersonalMessage: (b64: string) => Promise<{
                readonly signature: string;
                readonly bytes: string;
              }>;
            }
          ).__signPersonalMessage;
          return sign(toBase64Chunked(input.message));
        };

        const wallet = {
          version: "1.0.0" as const,
          name: "Generated Test Wallet",
          icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" as const,
          chains: [`sui:${network}`] as const,
          get accounts() {
            return accounts;
          },
          features: {
            "standard:connect": {
              version: "1.0.0" as const,
              connect: async () => {
                if (!connected) {
                  accounts = [account];
                  connected = true;
                  emit("change", { accounts });
                }
                return { accounts };
              },
            },
            "standard:disconnect": {
              version: "1.0.0" as const,
              disconnect: async () => {
                accounts = [];
                connected = false;
                emit("change", { accounts });
              },
            },
            "standard:events": {
              version: "1.0.0" as const,
              on: (event: string, listener: (d: unknown) => void) => {
                const set = listeners.get(event) ?? new Set();
                set.add(listener);
                listeners.set(event, set);
                return () => set.delete(listener);
              },
            },
            "sui:signTransaction": {
              version: "2.0.0" as const,
              signTransaction,
            },
            "sui:signAndExecuteTransaction": {
              version: "2.0.0" as const,
              signAndExecuteTransaction: async () => {
                throw new Error("signAndExecuteTransaction is not implemented");
              },
            },
            "sui:signPersonalMessage": {
              version: "1.1.0" as const,
              signPersonalMessage,
            },
          },
        };

        window.addEventListener("wallet-standard:app-ready", (e: Event) => {
          const detail = (
            e as CustomEvent<{ readonly register?: (w: unknown) => void }>
          ).detail;
          detail?.register?.(wallet);
        });
        window.dispatchEvent(
          new CustomEvent("wallet-standard:register-wallet", {
            detail: (registerFn: (w: unknown) => void) => registerFn(wallet),
          }),
        );
      },
      { address: walletAddress, publicKeyBase64, network: NETWORK },
    );

    await use(page);
  },
});

export { expect } from "@playwright/test";
