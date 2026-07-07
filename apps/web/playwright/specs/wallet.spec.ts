import { test, expect } from "../fixtures/wallet.ts";

test.describe("generated-key wallet", () => {
  test("connects through the self-custody wallet path", async ({
    walletPage,
    walletAddress,
  }) => {
    const faucetRecipients: string[] = [];

    await walletPage.route("**/sui-rpc", async (route) => {
      const request = route.request().postDataJSON() as {
        readonly method?: string;
      };
      if (request.method === "suix_getBalance") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { totalBalance: "0" },
          }),
        });
        return;
      }
      if (
        request.method === "suix_queryEvents" ||
        request.method === "suix_getOwnedObjects"
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { data: [], nextCursor: null, hasNextPage: false },
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }),
      });
    });

    await walletPage.route("**/sui-faucet/v2/gas", async (route) => {
      const request = route.request().postDataJSON() as {
        readonly FixedAmountRequest?: { readonly recipient?: string };
      };
      const recipient = request.FixedAmountRequest?.recipient;
      if (recipient !== undefined) faucetRecipients.push(recipient);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "Success" }),
      });
    });

    await walletPage.goto("/");

    await expect(walletPage.getByTestId("connect-wallet")).toBeEnabled();
    await walletPage.getByTestId("connect-wallet").click();

    await expect(walletPage.getByTestId("custody-self")).toBeVisible();
    await expect(walletPage.getByTestId("custody-self")).toContainText(
      "Generated Test Wallet",
    );

    await walletPage.getByRole("button", { name: "Account" }).click();
    await expect(
      walletPage.getByRole("heading", { name: "Account" }),
    ).toBeVisible();
    await expect(walletPage.locator(".account-panel")).toContainText(
      "self-custody",
    );
    await expect(walletPage.locator(".account-panel")).toContainText(
      walletAddress.slice(-4),
    );
    await expect.poll(() => faucetRecipients).toEqual([walletAddress]);
  });
});
