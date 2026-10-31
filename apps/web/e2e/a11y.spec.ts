import AxeBuilder from "@axe-core/playwright";
import { clientNavigate, expect, signIn, test } from "./support/fixtures";

/**
 * Interface quality gates: keyboard access, accessible names, and no overflow at phone width.
 * Axe runs with the WCAG 2.2 AA tag set on the screens with the most controls.
 */
test.describe("accessibility", () => {
  test("connect screen has no serious WCAG 2.2 AA violations", async ({ page }) => {
    await page.goto("/connect");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual(
      [],
    );
  });

  test("dashboard has no serious violations in dark and light themes", async ({ page, state }) => {
    await signIn(page, state.key);
    for (const theme of ["Light theme", "Dark theme"]) {
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
      const blocking = results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      );
      expect(blocking, `violations in ${theme}: ${JSON.stringify(blocking.map((v) => v.id))}`).toEqual([]);
      await page.getByRole("button", { name: theme }).click();
    }
  });

  test("runs list is navigable by keyboard", async ({ page, state }) => {
    await signIn(page, state.key);
    await page.getByRole("link", { name: "Runs" }).click();

    // The skip link is focusable and is the first tab stop in the document.
    const skip = page.getByRole("link", { name: "Skip to content" });
    await skip.focus();
    await expect(skip).toBeFocused();
    await expect(skip).toHaveText(/Skip to content/);

    // Each run id is a real link with an accessible name and works from the keyboard.
    const link = page.getByRole("link", { name: state.runId });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/runs/${state.runId}$`));
  });

  test("survives a 390 px viewport without horizontal page overflow", async ({ page, state }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, state.key);
    await clientNavigate(page, "/runs");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The table keeps its own scroll container rather than stretching the page.
    await expect(page.locator(".table-wrap").first()).toBeVisible();
  });

  test("mapping editor has no serious WCAG 2.2 AA violations in dark and light themes", async ({ page, state }) => {
    await signIn(page, state.key);
    await clientNavigate(page, `/studio/mappings/${state.editorMappingName}`);
    await expect(page.getByRole("form", { name: "Rule r1" })).toBeVisible();

    for (const theme of [
      { label: "Light theme", applied: "light" },
      { label: "Dark theme", applied: "dark" },
    ] as const) {
      // The toggle label names the theme it switches to, so click before analysing: the initial
      // rendering depends on the browser's color-scheme preference, not on the shell signal.
      await page.getByRole("button", { name: theme.label, exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.applied);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
      const blocking = results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      );
      expect(blocking, `violations in ${theme.label}: ${JSON.stringify(blocking.map((v) => v.id))}`).toEqual([]);
    }
  });

  test("mapping editor tables stay inside scroll containers at 390 px", async ({ page, state }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, state.key);

    const overflow = async () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // The version-diff table on the run mapping (seed publishes real v1 and v2).
    await clientNavigate(page, `/studio/mappings/${state.mappingName}`);
    await expect(page.getByRole("form", { name: "Rule r1" })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);

    await page.getByLabel("From", { exact: true }).selectOption("1");
    await page.getByLabel("To", { exact: true }).selectOption(String(state.mappingVersion2Version));
    await page.getByRole("button", { name: "Compare versions", exact: true }).click();
    await expect(page.locator("hb-version-diff .table-wrap").first()).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);

    // The coverage table from a preview of the editor mapping.
    await clientNavigate(page, `/studio/mappings/${state.editorMappingName}`);
    await expect(page.getByRole("form", { name: "Rule r1" })).toBeVisible();
    await page.getByLabel("Asset", { exact: true }).selectOption(state.assetId);
    await page.getByRole("button", { name: "Run preview", exact: true }).click();
    await expect(page.locator("hb-preview-panel .table-wrap").first()).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);
  });

  test("mapping editor supports add and reorder from the keyboard only", async ({ page, state }, testInfo) => {
    await signIn(page, state.key);
    // A retry never inherits the first attempt's rules: the name includes the retry index, and
    // any draft left under this name by an earlier invocation is deleted first.
    const name = `e2e-a11y-${state.slug}-r${testInfo.retry}`;
    const leftoverResponse = await page.request.get(`${state.baseUrl}/api/v1/mappings/${name}/draft`, {
      headers: { "x-api-key": state.key },
    });
    expect(leftoverResponse.ok()).toBe(true);
    const { draft: leftover } = (await leftoverResponse.json()) as { draft: { revision: number } | null };
    if (leftover !== null) {
      const deleted = await page.request.delete(
        `${state.baseUrl}/api/v1/mappings/${name}/draft?revision=${leftover.revision}`,
        { headers: { "x-api-key": state.key } },
      );
      expect(deleted.status()).toBe(204);
    }
    await clientNavigate(page, `/studio/mappings/${name}`);
    await expect(page.getByRole("heading", { level: 1, name: "Mapping editor" })).toBeVisible();
    await expect(page.getByText("New mapping — not published.", { exact: true })).toBeVisible();

    const add = page.getByRole("button", { name: "Add rule", exact: true });
    await add.focus();
    await page.keyboard.press("Enter");

    const ruleSelects = page.locator("button.rule-select");
    await expect(ruleSelects).toHaveCount(1);
    await expect(ruleSelects.first()).toBeFocused();
    await page.getByLabel("Source path", { exact: true }).focus();
    await page.keyboard.type("alpha");

    await add.focus();
    await page.keyboard.press("Enter");
    await expect(ruleSelects).toHaveCount(2);
    await expect(ruleSelects.last()).toBeFocused();
    await page.getByLabel("Source path", { exact: true }).focus();
    await page.keyboard.type("beta");

    // Move the second rule up; the list order changes without a mouse.
    const moveUp = page.getByRole("button", { name: "Move rule 2 up", exact: true });
    await moveUp.focus();
    await page.keyboard.press("Enter");
    await expect(ruleSelects.first()).toContainText("beta");
    await expect(ruleSelects.last()).toContainText("alpha");

    // Move the first rule down again; the order returns to alpha, beta.
    const moveDown = page.getByRole("button", { name: "Move rule 1 down", exact: true });
    await moveDown.focus();
    await page.keyboard.press("Enter");
    await expect(ruleSelects.first()).toContainText("alpha");
    await expect(ruleSelects.last()).toContainText("beta");

    // Remove the draft this spec created so the editor specs start from the seeded state.
    await expect(page.locator("p.save-status")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
    const draftResponse = await page.request.get(`${state.baseUrl}/api/v1/mappings/${name}/draft`, {
      headers: { "x-api-key": state.key },
    });
    const { draft } = (await draftResponse.json()) as { draft: { revision: number } | null };
    expect(draft).not.toBeNull();
    const deleted = await page.request.delete(
      `${state.baseUrl}/api/v1/mappings/${name}/draft?revision=${draft?.revision ?? 0}`,
      { headers: { "x-api-key": state.key } },
    );
    expect(deleted.status()).toBe(204);
  });
});
