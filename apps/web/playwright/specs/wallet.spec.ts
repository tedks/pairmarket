import { test, expect } from "../fixtures/wallet.ts";

test.describe("generated-key wallet", () => {
  test("connects through the self-custody wallet path", async ({
    walletPage,
    walletAddress,
  }) => {
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
  });
});
