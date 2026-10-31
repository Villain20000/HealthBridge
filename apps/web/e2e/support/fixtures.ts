import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";

/**
 * Shared fixtures.
 *
 * `state` is produced by the seed script (real API responses, never a mock). `console` opens
 * the app with the seeded key already entered — through the connect form, so the sign-in path
 * is exercised by every test that needs a session.
 */
// Playwright transpiles specs to CommonJS, where `__dirname` is available (unlike import.meta).
export const STATE_FILE = join(__dirname, "..", ".state.json");

export interface SeedState {
  baseUrl: string;
  slug: string;
  workspace: { id: string; name: string; slug: string };
  key: string;
  viewerKey: string;
  viewerKeyId: string;
  assetId: string;
  emptyAssetId: string;
  mappingId: string;
  mappingName: string;
  editorMappingId: string;
  editorMappingName: string;
  runId: string;
  runStatus: string;
  secondRunId: string;
  secondRunStatus: string;
  idempotencyKey: string;
  patientRows: number;
}

export function readState(): SeedState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SeedState;
}

/** Signs in through the real form. Returns the page with a live session. */
export async function signIn(page: Page, key: string): Promise<void> {
  await page.goto("/connect");
  await page.getByLabel("API key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/**
 * Client-side navigation.
 *
 * The session lives in memory, so a full `page.goto()` would (correctly) sign the operator out.
 * Deep links are therefore exercised the way they happen in the app: the router receives a
 * location change and the guard sees a live session.
 */
export async function clientNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}

export const test = base.extend<{ state: SeedState; console: Page }>({
  // Playwright requires the destructured first parameter to declare dependencies.
  // eslint-disable-next-line no-empty-pattern
  state: async ({}, use) => {
    await use(readState());
  },
  console: async ({ page, state }, use) => {
    await signIn(page, state.key);
    await use(page);
  },
});

export { expect };
