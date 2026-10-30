import { clientNavigate, expect, signIn, test } from "./support/fixtures";

/**
 * The Studio opens as a lazy sibling of the console features. These tests cover the entry
 * point, the real data it shows, the sign-in return trip, route titles, and the two keyboard
 * behaviours the shell owns: the skip link and focus after a real path change.
 */
test.describe("studio shell", () => {
  test("opens from the primary nav and shows the API's latest records", async ({ console: page, request, state }) => {
    // Read the same latest-five lists the Studio will request. Comparing against the API
    // response, rather than the seeded ids, keeps the assertion valid when other specs have
    // added newer runs, assets or mappings before this one.
    const headers = { "x-api-key": state.key };
    const [runsResponse, assetsResponse, mappingsResponse] = await Promise.all([
      request.get("/api/v1/runs?limit=5", { headers }),
      request.get("/api/v1/assets?limit=5", { headers }),
      request.get("/api/v1/mappings?limit=5", { headers }),
    ]);
    expect(runsResponse.ok()).toBe(true);
    expect(assetsResponse.ok()).toBe(true);
    expect(mappingsResponse.ok()).toBe(true);

    const { runs } = (await runsResponse.json()) as { runs: { id: string }[] };
    const { assets } = (await assetsResponse.json()) as { assets: { filename: string }[] };
    const { mappings } = (await mappingsResponse.json()) as { mappings: { name: string }[] };
    expect(runs.length, "the seed guarantees at least one run").toBeGreaterThan(0);
    expect(assets.length, "the seed guarantees at least one asset").toBeGreaterThan(0);
    expect(mappings.length, "the seed guarantees at least one mapping").toBeGreaterThan(0);

    await page.getByRole("link", { name: "Studio", exact: true }).click();

    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.getByRole("heading", { level: 1, name: "Studio" })).toBeVisible();
    await expect(page).toHaveTitle("Studio · HealthBridge");

    for (const run of runs) {
      await expect(page.getByRole("link", { name: run.id, exact: true })).toBeVisible();
    }
    // Filenames and mapping names may legitimately repeat, so compare visible text sets
    // instead of exact cells: every record the API returned must appear at least once.
    const assetCells = await page.getByRole("region", { name: "Recent assets" }).getByRole("cell").allInnerTexts();
    for (const asset of assets) expect(assetCells).toContain(asset.filename);
    const mappingCells = await page.getByRole("region", { name: "Recent mappings" }).getByRole("cell").allInnerTexts();
    for (const mapping of mappings) expect(mappingCells).toContain(mapping.name);
  });

  test("returns to the requested page after signing in", async ({ page, state }) => {
    await page.goto("/runs?status=completed");
    await expect(page).toHaveURL(/\/connect\?returnUrl=/);

    await page.getByLabel("API key", { exact: true }).fill(state.key);
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect(page).toHaveURL(/\/runs\?status=completed$/);
  });

  test("rejects an absolute return URL and falls back to the dashboard", async ({ page, state }) => {
    await page.goto(`/connect?returnUrl=${encodeURIComponent("https://evil.example/steal")}`);
    await page.getByLabel("API key", { exact: true }).fill(state.key);
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    expect(page.url()).not.toContain("evil.example");
  });

  test("skip link focuses the main landmark from the post-sign-in focus state", async ({ page, state }) => {
    // Signing in navigates from the connect page into a shell that is created by that same
    // navigation, so the shell's path-change focus rule does not fire and focus lands on the
    // document body. From that exact state, the skip link must be reachable by Shift+Tab alone
    // — no DOM mutation to restart sequential focus.
    await page.goto("/studio");
    await expect(page).toHaveURL(/\/connect\?returnUrl=%2Fstudio$/);
    await page.getByLabel("API key", { exact: true }).fill(state.key);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.locator("body")).toBeFocused();

    const skip = page.getByRole("link", { name: "Skip to content" });
    let reached = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await page.keyboard.press("Shift+Tab");
      if (await skip.evaluate((element) => element === document.activeElement)) {
        reached = true;
        break;
      }
    }
    expect(reached, "Shift+Tab reaches the skip link from the post-sign-in focus state").toBe(true);
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();

    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("moves focus to main on a path change, not on a query-only update", async ({ page, state }) => {
    await signIn(page, state.key);

    await page.getByRole("link", { name: "Studio", exact: true }).click();
    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.locator("#main")).toBeFocused();

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await clientNavigate(page, "/studio?refresh=1");
    await expect(page).toHaveURL(/\/studio\?refresh=1$/);
    // Let Angular emit NavigationEnd before asserting the negative; otherwise the assertion
    // can pass simply because the router has not settled yet.
    await page.waitForTimeout(300);
    await expect(page.locator("#main")).not.toBeFocused();
  });

  test("sets the document title for each route", async ({ console: page }) => {
    await page.getByRole("link", { name: "Studio", exact: true }).click();
    await expect(page).toHaveTitle("Studio · HealthBridge");

    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await expect(page).toHaveTitle("Runs · HealthBridge");
  });
});
