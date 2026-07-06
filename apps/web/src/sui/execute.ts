import { useCallback } from "react";
import {
  useCurrentAccount,
  useCurrentClient,
  useCurrentNetwork,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

export type ExecutedTransaction = NonNullable<
  Awaited<
    ReturnType<SuiJsonRpcClient["core"]["executeTransaction"]>
  >["Transaction"]
>;

export function useExecuteSuiTransaction(): (
  transaction: Transaction,
) => Promise<ExecutedTransaction> {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const network = useCurrentNetwork();

  return useCallback(
    async (transaction: Transaction): Promise<ExecutedTransaction> => {
      if (!account) throw new Error("Connect a Sui wallet first");

      transaction.setSender(account.address);
      if (network === "localnet") {
        transaction.setExpiration({ None: true } as never);
      }

      const bytes = await transaction.build({ client });
      const signed = await dAppKit.signTransaction({
        transaction: toBase64(bytes),
        network,
      });

      const executed = await client.core.executeTransaction({
        transaction: fromBase64(signed.bytes),
        signatures: [signed.signature],
        include: {
          effects: true,
          events: true,
          objectTypes: true,
        },
      });

      if (executed.FailedTransaction) {
        const error = executed.FailedTransaction.status.error;
        const message =
          typeof error === "string"
            ? error
            : (error?.message ?? "Sui transaction failed");
        throw new Error(message);
      }

      const committed = executed.Transaction;
      try {
        await client.core.waitForTransaction({
          result: executed,
          timeout: 15_000,
          include: {
            effects: true,
            events: true,
            objectTypes: true,
          },
        });
      } catch {
        // The write has already committed; callers should refresh chain state.
      }

      return committed;
    },
    [account, client, dAppKit, network],
  );
}
