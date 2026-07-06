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

  test("new market form collects friend handles and requires a profile object", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New market" }).click();

    await expect(
      page.getByRole("heading", { name: "New market" }),
    ).toBeVisible();
    await expect(page.getByTestId("create-subject-a")).toHaveAttribute(
      "placeholder",
      "@heyellieday",
    );
    await expect(page.getByTestId("create-subject-b")).toHaveAttribute(
      "placeholder",
      "@tedks",
    );
    await expect(page.getByTestId("create-visibility")).toHaveValue("friends");
    await expect(
      page.getByText("Create a profile object before creating a market."),
    ).toBeVisible();
    await expect(page.getByTestId("create-submit")).toBeDisabled();
  });

  test("social graph page starts with profile creation", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Social" }).click();

    await expect(
      page.getByRole("heading", { name: "Social graph" }),
    ).toBeVisible();
    await expect(page.getByTestId("profile-handle")).toHaveAttribute(
      "placeholder",
      "@tedks",
    );
    await expect(
      page.getByRole("button", { name: "Create profile" }),
    ).toBeVisible();
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
