import { test, expect } from "@playwright/test";

test.describe("pairmarket localnet shell", () => {
  test("starts empty until a wallet-backed localnet journey creates objects", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Your markets" }),
    ).toBeVisible();
    await expect(page.getByText("No markets yet.")).toBeVisible();
    await expect(page.getByTestId("viewer-switcher")).toHaveCount(0);
  });

  test("keeps Twitter custody disabled", async ({ page }) => {
    await page.goto("/");

    const twitter = page.getByTestId("sign-in-twitter");
    await expect(twitter).toBeVisible();
    await expect(twitter).toBeDisabled();
    await expect(twitter).toContainText("Twitter custody coming later");
  });

  test("new market form collects Sui addresses and requires wallet custody", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New market" }).click();

    await expect(
      page.getByRole("heading", { name: "New market" }),
    ).toBeVisible();
    await expect(page.getByTestId("create-subject-a")).toHaveAttribute(
      "placeholder",
      "0x...",
    );
    await expect(page.getByTestId("create-subject-b")).toHaveAttribute(
      "placeholder",
      "0x...",
    );
    await expect(
      page.getByText("Connect a Sui wallet to create a market."),
    ).toBeVisible();
    await expect(page.getByTestId("create-submit")).toBeDisabled();
  });

  test("account page starts anonymous with no linked custody", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Account" }).click();

    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.locator(".account-panel")).toContainText("anonymous");
    await expect(page.locator(".account-panel")).toContainText(
      "Connect wallet",
    );
  });
});
