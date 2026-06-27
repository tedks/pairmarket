import { defineConfig, devices } from "@playwright/test";

// Dedicated port to avoid colliding with `pnpm web:dev` on 5173 or
// other projects on this dev box. Same pattern as
// ~/Projects/predictionbook/master/frontend/playwright/playwright.config.ts.
const E2E_PORT = Number(process.env["E2E_PORT"] ?? 5276);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./specs",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env["CI"] ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${E2E_PORT}`,
    cwd: "..",
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
