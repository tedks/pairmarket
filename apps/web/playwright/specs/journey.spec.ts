import { test, expect, type Page } from "@playwright/test";

// Seeded market IDs from src/mock/seed.ts. Kept in sync with the
// fixture so the test fails loudly if the seed changes shape.
const MARKETS = {
  trading: "0x" + "11".padStart(64, "0"),
  proposed: "0x" + "22".padStart(64, "0"),
  attestationPending: "0x" + "33".padStart(64, "0"),
  settled: "0x" + "44".padStart(64, "0"),
};

async function switchViewer(page: Page, userId: string): Promise<void> {
  await page.getByTestId("viewer-switcher").selectOption(userId);
}

async function openMarket(page: Page, marketId: string): Promise<void> {
  await page.getByTestId(`market-row-${marketId}`).click();
  await expect(page.getByTestId("market-detail")).toBeVisible();
}

async function backToMarkets(page: Page): Promise<void> {
  await page.getByRole("button", { name: "← Markets" }).click();
  await expect(
    page.getByRole("heading", { name: "Your markets" }),
  ).toBeVisible();
}

test.describe("pairmarket prototype journey", () => {
  test("home loads with the operational market workspace as the first viewport", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Your markets" }),
    ).toBeVisible();
    await expect(page.getByText("private by invitation")).toBeVisible();
    // Trading market for Ada (default viewer = creator).
    await expect(
      page.getByText("Will Cleo and Dru last 3 dates?"),
    ).toBeVisible();
  });

  test("twitter custody remains available as a fallback sign-in", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("connect-wallet")).toBeVisible();
    await expect(page.getByTestId("sign-in-twitter")).toBeVisible();
    await page.getByTestId("sign-in-twitter").click();
    await expect(page.getByTestId("custody-linked")).toBeVisible();
    await expect(page.getByTestId("custody-linked")).toContainText("@ada");

    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    const accountPanel = page.locator(".account-panel");
    await expect(
      accountPanel.getByText("linked", { exact: true }),
    ).toBeVisible();
    await expect(
      accountPanel.locator(".kv", {
        has: page.getByText("Twitter sub", { exact: true }),
      }),
    ).toContainText("twitter:ada");
    await expect(
      accountPanel.locator(".kv", {
        has: page.getByText("Custodial user", { exact: true }),
      }),
    ).toContainText("twitter:ada");
    await expect(
      accountPanel.getByText("custodial", { exact: true }),
    ).toBeVisible();
    await expect(accountPanel.getByText(/kms|keyRef/i)).toHaveCount(0);
    await expect(accountPanel.getByText(/twitter_session/i)).toHaveCount(0);
    await expect(accountPanel.getByText(/twitter:twitter/i)).toHaveCount(0);
  });

  test("self-custody wallet sign-in is the primary account path", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("custody-self")).toBeVisible();
    await expect(page.getByTestId("custody-self")).toContainText("Burner");

    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.getByText("self-custody", { exact: true })).toBeVisible();
    await expect(page.getByText("testnet", { exact: true })).toBeVisible();
  });

  test("self-custody sign-out returns to anonymous and clears wallet storage", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("custody-self")).toBeVisible();

    await page.getByTestId("custody-self").click();
    await expect(page.getByTestId("connect-wallet")).toBeVisible();
    await expect(page.getByTestId("sign-in-twitter")).toBeVisible();
    const storedWallet = await page.evaluate(() =>
      localStorage.getItem("pairmarket:selected-wallet-and-address"),
    );
    expect(storedWallet).toBeNull();
  });

  test("wager form defaults to remaining invite cap", async ({ page }) => {
    await page.goto("/");
    await switchViewer(page, "ben-okri");
    await openMarket(page, MARKETS.trading);

    await expect(page.getByTestId("wager-amount")).toHaveValue("0.5");
    await expect(page.locator(".wager-meta")).toContainText("cap 0.5 SUI");

    await page.getByTestId("wager-no").check();
    await page.getByTestId("wager-amount").fill("0.4");
    await page.getByTestId("wager-submit").click();

    await expect(page.getByTestId("wager-no")).toBeChecked();
    await expect(page.getByTestId("wager-amount")).toHaveValue("0.1");
    await expect(page.locator(".wager-meta")).toContainText("cap 0.1 SUI");
    await expect(page.getByTestId("wager-submit")).toBeEnabled();
  });

  test("end-to-end: consent → wager → attest → settle → claim", async ({
    page,
  }) => {
    await page.goto("/");

    // Step 1: as the pending subject (Fae) consent to the proposed market.
    await switchViewer(page, "fae-shimizu");
    await openMarket(page, MARKETS.proposed);
    await expect(page.locator(".phase-chip.phase-proposed")).toBeVisible();
    await page.getByTestId("consent-accept").click();
    // Both subjects accepted → market transitions to Trading.
    await expect(page.locator(".phase-chip.phase-trading")).toBeVisible();
    await backToMarkets(page);

    // Step 2: as an invitee (Ben) accept the invite and place a wager.
    await switchViewer(page, "ben-okri");
    await openMarket(page, MARKETS.proposed);
    await page.getByTestId("accept-invite").click();
    await expect(
      page.locator(".invite-row .invite-status.accepted").first(),
    ).toBeVisible();
    await page.getByTestId("wager-yes").check();
    await page.getByTestId("wager-amount").fill("0.5");
    await page.getByTestId("wager-submit").click();
    // Position appears with Ben as owner and a 0.5 SUI stake.
    const positionRow = page
      .locator(".position-row")
      .filter({ hasText: "Ben Okri" });
    await expect(positionRow).toBeVisible();
    await expect(positionRow).toContainText("0.5 SUI");
    await backToMarkets(page);

    // Step 3: as subject A of the attestation-pending market (Ada) attest YES.
    await switchViewer(page, "ada-lovelace");
    await openMarket(page, MARKETS.attestationPending);
    await expect(
      page.locator(".phase-chip.phase-attestation-pending"),
    ).toBeVisible();
    await page.getByTestId("attest-yes").click();
    // One attestation in, still attestation-pending.
    await expect(
      page.locator(".phase-chip.phase-attestation-pending"),
    ).toBeVisible();
    await backToMarkets(page);

    // Step 4: as subject B (Cleo) attest YES → market settles.
    await switchViewer(page, "cleo-park");
    await openMarket(page, MARKETS.attestationPending);
    await page.getByTestId("attest-yes").click();
    await expect(page.locator(".phase-chip.phase-settled")).toBeVisible();
    await backToMarkets(page);

    // Step 5: as Ada (winning unclaimed YES position in the seeded settled
    // market), claim the payout.
    await switchViewer(page, "ada-lovelace");
    await openMarket(page, MARKETS.settled);
    await expect(page.locator(".phase-chip.phase-settled")).toBeVisible();
    await page.getByTestId("claim-payout").click();
    await expect(
      page.getByText("claimed", { exact: true }).first(),
    ).toBeVisible();
  });

  test("non policy-member sees encrypted placeholder for content", async ({
    page,
  }) => {
    await page.goto("/");
    // The proposed market's policy is creator (Ada) + subjects (Eli, Fae)
    // + invitees (Ben, Cleo). Dru is outside the policy → market should
    // not appear in Dru's list (private by invitation).
    await switchViewer(page, "dru-haines");
    await expect(
      page.getByText("Will Eli and Fae go on a second date if introduced?"),
    ).toHaveCount(0);

    await switchViewer(page, "ada-lovelace");
    await openMarket(page, MARKETS.proposed);
    await expect(
      page.getByText("Will Eli and Fae go on a second date if introduced?"),
    ).toBeVisible();

    await switchViewer(page, "dru-haines");
    await expect(
      page.getByRole("heading", {
        name: "[encrypted · not a policy member]",
      }),
    ).toBeVisible();
    const detail = page.getByTestId("market-detail");
    await expect(detail.getByText("Private market")).toBeVisible();
    await expect(detail.getByText("Eli Ramos")).toHaveCount(0);
    await expect(detail.getByText("Fae Shimizu")).toHaveCount(0);
    await expect(detail.getByText("Ben Okri")).toHaveCount(0);
  });

  test("date markets require operationalization before resolution", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New market" }).click();
    await page.getByTestId("create-op-kind").selectOption("meet-by-date");
    await page.getByTestId("create-op-deadline-days").fill("30");
    await page.getByTestId("create-deadline-days").fill("7");

    await expect(page.getByTestId("create-deadline-error")).toContainText(
      "Operationalization deadline must be on or before the resolution deadline.",
    );
    await expect(page.getByTestId("create-submit")).toBeDisabled();
  });
});
