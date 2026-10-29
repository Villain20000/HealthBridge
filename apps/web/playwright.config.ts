import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * Two modes, one suite:
 *
 *   npx playwright test
 *     starts the built API (demo mode) and the console server on :4400 — the suite still goes
 *     through the real reverse proxy, so SSE and headers are exercised, but no Docker needed.
 *
 *   E2E_BASE_URL=http://127.0.0.1:4200 npx playwright test
 *     runs against an already-running stack, which is how CI tests the composed containers
 *     (`docker compose -f docker/compose.demo.yaml up -d --build`). Bootstrap token must match.
 */
const externalBase = process.env["E2E_BASE_URL"];
const baseURL = externalBase ?? "http://127.0.0.1:4400";
const bootstrapToken =
  process.env["E2E_BOOTSTRAP_TOKEN"] ?? (externalBase ? "demo-bootstrap-token" : "e2e-bootstrap-token");

process.env["E2E_BOOTSTRAP_TOKEN"] = bootstrapToken;

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env["CI"] ? "retain-on-failure" : "off",
    // The console is same-origin only; a permissive ignore would hide real failures.
    ignoreHTTPSErrors: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1000 } } }],
  globalSetup: "./e2e/support/global-setup.mjs",
  webServer: externalBase
    ? undefined
    : [
        {
          command: "node apps/api/dist/main.js",
          url: "http://127.0.0.1:3200/api/v1/healthz",
          cwd: "../..",
          reuseExistingServer: !process.env["CI"],
          timeout: 120_000,
          env: {
            PORT: "3200",
            NODE_ENV: "development",
            HEALTHBRIDGE_BOOTSTRAP_TOKEN: bootstrapToken,
            HEALTHBRIDGE_STORAGE_DIR: "./apps/web/e2e/.objects",
          },
        },
        {
          command: "node apps/web/server.mjs",
          url: "http://127.0.0.1:4400/healthz",
          cwd: "../..",
          reuseExistingServer: !process.env["CI"],
          timeout: 60_000,
          env: {
            PORT: "4400",
            API_ORIGIN: "http://127.0.0.1:3200",
            STATIC_DIR: "./apps/web/dist/web/browser",
          },
        },
      ],
});
