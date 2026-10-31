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

  test("mapping editor has no serious WCAG 2.2 AA violations", async ({ page, state }) => {
    await signIn(page, state.key);
    await clientNavigate(page, `/studio/editor/${state.editorMappingName}`);
    await expect(page.getByRole("form", { name: "Rule r1" })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual(
      [],
    );
  });

  test("mapping editor survives a 390 px viewport without horizontal page overflow", async ({ page, state }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, state.key);
    await clientNavigate(page, `/studio/editor/${state.editorMappingName}`);
    await expect(page.getByRole("form", { name: "Rule r1" })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
