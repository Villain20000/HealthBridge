import AxeBuilder from "@axe-core/playwright";
import { clientNavigate, expect, signIn, test } from "./support/fixtures";

/**
 * Validation Centre: read-only rendering of a run's stored validation report.
 *
 * The seeded run is built from clean CSV rows through the real pipeline, so levels 1-3
 * (source-structural, mapping-definition, target-structural) are executed and levels 4-6
 * (profile, terminology, referential-integrity) are skipped with their Phase F reasons.
 * Every assertion below reads stored rows — the page must never offer replay, cancel or
 * any other mutation, and skipped levels must never read as passed.
 */
test.describe("validation centre", () => {
  test("renders executed levels with validators and skipped levels as not run, never passed", async ({
    console: page,
    state,
  }) => {
    await clientNavigate(page, `/validation-centre/${state.runId}`);

    await expect(page.getByRole("heading", { name: "Validation Centre" })).toBeVisible();
    await expect(page.getByText(state.runId).first()).toBeVisible();
    await expect(page.getByText("stored result, not a live execution")).toBeVisible();

    // Executed levels name the validator that produced them.
    await expect(page.getByRole("heading", { name: "Level 1 — source-structural" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 2 — mapping-definition" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 3 — target-structural" })).toBeVisible();
    await expect(page.getByText("mapping-engine").first()).toBeVisible();
    await expect(page.getByText("fhir-r4-validator").first()).toBeVisible();

    // Skipped levels 4-6 are explicit: not run, never passed, with the stored reason.
    await expect(page.getByRole("heading", { name: "Level 4 — profile" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 5 — terminology" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 6 — referential-integrity" })).toBeVisible();
    await expect(page.getByText("Not run, never passed", { exact: true })).toHaveCount(3);
    await expect(page.getByText(/Phase F/).first()).toBeVisible();
  });

  test("is read-only and links back to the run detail issues tab", async ({ console: page, state }) => {
    await clientNavigate(page, `/validation-centre/${state.runId}`);
    await expect(page.getByRole("heading", { name: "Validation Centre" })).toBeVisible();

    // No mutation is offered: refresh only re-reads the stored rows.
    await expect(page.getByRole("button", { name: "Replay" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit run" })).toHaveCount(0);

    await page.getByRole("link", { name: "Back to run detail" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${state.runId}$`));
  });

  test("reports an unknown run as NOT_FOUND with a request id", async ({ console: page }) => {
    await clientNavigate(page, "/validation-centre/run_does_not_exist");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("NOT_FOUND");
    await expect(alert).toContainText("request");
  });

  test("has no serious WCAG 2.2 AA violations and survives a 390 px viewport", async ({ page, state }) => {
    await signIn(page, state.key);
    await clientNavigate(page, `/validation-centre/${state.runId}`);
    await expect(page.getByRole("heading", { name: "Validation Centre" })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual(
      [],
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
