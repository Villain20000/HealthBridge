import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { clientNavigate, expect, test } from "./support/fixtures";

/**
 * Navigation across the M1 integration: run detail → stored-trace debugger → Studio.
 *
 * The session is memory-only, so every route change here goes through the nav or
 * `clientNavigate`; a hard load of an authenticated route would (correctly) sign out. The
 * debugger rewrites its own URL with `?event=…` through `replaceUrl`, so assertions use the
 * settled path and Back is expected to leave the debugger in one step.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openRunDetail(page: Page, runId: string): Promise<void> {
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.getByRole("link", { name: runId, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: runId })).toBeVisible();
}

/** One `@switch` panel is rendered at a time; it must be the one the selected tab controls. */
async function expectSelectedPanel(page: Page, tab: string): Promise<void> {
  const selected = page.locator(`#run-tab-${tab}`);
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toHaveAttribute("tabindex", "0");
  await expect(selected).toHaveAttribute("aria-controls", `run-panel-${tab}`);

  const panels = page.getByRole("tabpanel");
  await expect(panels).toHaveCount(1);
  await expect(panels).toHaveAttribute("id", `run-panel-${tab}`);
  await expect(panels).toHaveAttribute("aria-labelledby", `run-tab-${tab}`);
  await expect(panels).toBeVisible();
}

test.describe("studio navigation", () => {
  test("round-trips run detail, the stored-trace debugger and Studio through their links", async ({
    console: page,
    state,
  }) => {
    await openRunDetail(page, state.runId);
    await expect(page).toHaveURL(new RegExp(`/runs/${state.runId}$`));

    await page.getByRole("link", { name: "Open stored-trace debugger", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: state.runId })).toBeVisible();
    await expect(page.getByText("Stored trace replay — not live execution.", { exact: false })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/studio/debugger/${state.runId}(\\?.*)?$`));

    // Selections use `replaceUrl`, so a single Back must leave the debugger entirely.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/runs/${state.runId}$`));
    await expect(page.getByRole("heading", { level: 1, name: state.runId })).toBeVisible();

    // Debugger header links, reusing the same session.
    await page.getByRole("link", { name: "Open stored-trace debugger", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: state.runId })).toBeVisible();
    await page.getByRole("link", { name: "Run detail", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${state.runId}$`));
    await expect(page.getByRole("heading", { level: 1, name: state.runId })).toBeVisible();

    await page.getByRole("link", { name: "Open stored-trace debugger", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: state.runId })).toBeVisible();
    await page.getByRole("link", { name: "Back to Studio", exact: true }).click();
    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.getByRole("heading", { level: 1, name: "Studio" })).toBeVisible();
  });

  test("honours a ?tab= deep link and falls back to Overview for an unknown value", async ({
    console: page,
    state,
  }) => {
    const runPath = `/runs/${state.runId}`;

    await clientNavigate(page, `${runPath}?tab=traces`);
    await expect(page.getByRole("tab", { name: "Traces" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#run-panel-traces")).toBeVisible();
    await expect(page.locator("#run-panel-traces")).toHaveAttribute("role", "tabpanel");
    await expect(page.locator("#run-panel-traces")).toHaveAttribute("aria-labelledby", "run-tab-traces");

    await clientNavigate(page, `${runPath}?tab=issues`);
    await expect(page.getByRole("tab", { name: "Issues" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#run-panel-issues")).toBeVisible();

    // The invalid value resolves when the page is created, so leave the route first rather
    // than reusing the tab that is already selected.
    await clientNavigate(page, "/runs");
    await clientNavigate(page, `${runPath}?tab=nope`);
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#run-panel-overview")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: state.runId })).toBeVisible();
  });

  test("tabs follow the keyboard and expose aria-controls only for the rendered panel", async ({
    console: page,
    state,
  }) => {
    const runPath = `/runs/${state.runId}`;
    await clientNavigate(page, runPath);
    await expectSelectedPanel(page, "overview");

    for (const tab of ["issues", "resources", "traces", "bundle"]) {
      const inactive = page.locator(`#run-tab-${tab}`);
      await expect(inactive).toHaveAttribute("tabindex", "-1");
      await expect(inactive).toHaveAttribute("aria-selected", "false");
      await expect(inactive).not.toHaveAttribute("aria-controls");
    }

    await page.locator("#run-tab-overview").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#run-tab-issues")).toBeFocused();
    await expectSelectedPanel(page, "issues");
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(runPath)}\\?tab=issues$`));

    await page.keyboard.press("End");
    await expect(page.locator("#run-tab-bundle")).toBeFocused();
    await expectSelectedPanel(page, "bundle");
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(runPath)}\\?tab=bundle$`));

    await page.keyboard.press("Home");
    await expect(page.locator("#run-tab-overview")).toBeFocused();
    await expectSelectedPanel(page, "overview");
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(runPath)}$`));

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("#run-tab-bundle")).toBeFocused();
    await expectSelectedPanel(page, "bundle");
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(runPath)}\\?tab=bundle$`));
  });

  test("run detail has no serious axe violations on the issues or overview tab", async ({ console: page, state }) => {
    await clientNavigate(page, `/runs/${state.runId}?tab=issues`);
    await expect(page.getByRole("heading", { level: 2, name: "Validation issues" })).toBeVisible();

    const issues = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    const issuesBlocking = issues.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(issuesBlocking, `issues tab violations: ${JSON.stringify(issuesBlocking.map((v) => v.id))}`).toEqual([]);

    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.locator("#run-panel-overview")).toBeVisible();

    const overview = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    const overviewBlocking = overview.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(overviewBlocking, `overview tab violations: ${JSON.stringify(overviewBlocking.map((v) => v.id))}`).toEqual(
      [],
    );
  });

  test("links every recent Studio run to its stored-trace debugger", async ({ console: page, request, state }) => {
    // The page's own 200 responses prove it fetched all three lists. Bodies come from the
    // `request` fixture instead: Angular's `withFetch` backend aborts its controller on
    // teardown, so Chromium can report an already-completed 200 as net::ERR_ABORTED and
    // Playwright then has no body to return (`Network.getResponseBody: No data found`).
    const pageLists = Promise.all([
      page.waitForResponse((response) => /\/api\/v1\/runs\?limit=5$/.test(response.url()) && response.ok()),
      page.waitForResponse((response) => /\/api\/v1\/assets\?limit=5$/.test(response.url()) && response.ok()),
      page.waitForResponse((response) => /\/api\/v1\/mappings\?limit=5$/.test(response.url()) && response.ok()),
    ]);

    const headers = { "x-api-key": state.key };
    const [runsResponse, assetsResponse, mappingsResponse] = await Promise.all([
      request.get("/api/v1/runs?limit=5", { headers }),
      request.get("/api/v1/assets?limit=5", { headers }),
      request.get("/api/v1/mappings?limit=5", { headers }),
    ]);
    expect(runsResponse.ok()).toBe(true);
    expect(assetsResponse.ok()).toBe(true);
    expect(mappingsResponse.ok()).toBe(true);

    await page.getByRole("link", { name: "Studio", exact: true }).click();
    await pageLists;

    const { runs } = (await runsResponse.json()) as { runs: { id: string }[] };
    const { assets } = (await assetsResponse.json()) as { assets: { filename: string }[] };
    const { mappings } = (await mappingsResponse.json()) as { mappings: { name: string }[] };

    expect(runs.length, "the workspace has runs").toBeGreaterThan(0);
    expect(assets.length, "the workspace has assets").toBeGreaterThan(0);
    expect(mappings.length, "the workspace has mappings").toBeGreaterThan(0);

    await expect(page.getByRole("heading", { level: 1, name: "Studio" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Open stored-trace debugger for run / })).toHaveCount(runs.length);

    const firstRun = runs[0];
    await expect(
      page.getByRole("link", { name: `Open stored-trace debugger for run ${firstRun.id}`, exact: true }),
    ).toBeVisible();

    for (const run of runs) {
      await expect(page.getByRole("link", { name: run.id, exact: true })).toBeVisible();
    }
    // Duplicate filenames/names are legitimate, so compare text sets instead of exact cells.
    const assetCells = await page.getByRole("region", { name: "Recent assets" }).getByRole("cell").allInnerTexts();
    for (const asset of assets) expect(assetCells).toContain(asset.filename);
    const mappingCells = await page.getByRole("region", { name: "Recent mappings" }).getByRole("cell").allInnerTexts();
    for (const mapping of mappings) expect(mappingCells).toContain(mapping.name);

    await page.getByRole("link", { name: `Open stored-trace debugger for run ${firstRun.id}`, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: firstRun.id })).toBeVisible();
    await expect(page.getByText("Stored trace replay — not live execution.", { exact: false })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/studio/debugger/${escapeRegExp(firstRun.id)}(\\?.*)?$`));
  });

  test("Studio home survives a 390 px viewport", async ({ console: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await clientNavigate(page, "/studio");
    await expect(page.getByRole("heading", { level: 1, name: "Studio" })).toBeVisible();

    const runsRegion = page.getByRole("region", { name: "Recent runs" });
    await expect(runsRegion.locator(".table-wrap table")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
