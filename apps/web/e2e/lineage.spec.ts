import AxeBuilder from "@axe-core/playwright";
import { clientNavigate, expect, signIn, test } from "./support/fixtures";

/**
 * Data lineage: read-only rendering of a run's stored field lineage.
 *
 * The seeded run is built from clean CSV rows through the real pipeline with a six-rule
 * mapping (identity, trim, format_gender_fhir, parse_date_iso, default_value), so the
 * stored mapping traces back every declared rule and the page renders source, transform
 * and target nodes with the transform kind on each rule edge. Every assertion below reads
 * stored rows — the page must never offer replay, cancel, submit or any other mutation,
 * and it must never claim a live execution.
 */
test.describe("data lineage", () => {
  test("renders the stored field graph with transform-labelled edges", async ({ console: page, state }) => {
    await clientNavigate(page, `/lineage/${state.runId}`);

    await expect(page.getByRole("heading", { name: "Data lineage" })).toBeVisible();
    await expect(page.getByText(state.runId).first()).toBeVisible();
    await expect(page.getByText("never a live execution").first()).toBeVisible();

    // Declared rules from the seeded mapping version appear as transform nodes.
    await expect(page.getByText("(identity)").first()).toBeVisible();
    await expect(page.getByText("(format_gender_fhir)").first()).toBeVisible();

    // The edge table is the accessible source of truth: transform kinds on rule edges.
    const edges = page.getByRole("table", { name: "Lineage edges" });
    await expect(edges).toBeVisible();
    await expect(edges.getByText("format_gender_fhir")).toBeVisible();

    // Stored evidence backs the rule edges: the engine records per-record mapping traces
    // without rule ids, so the stored run coverage (consumed source fields) backs them.
    await expect(edges.getByText(/stored run coverage/).first()).toBeVisible();
  });

  test("is read-only and links back to run detail", async ({ console: page, state }) => {
    await clientNavigate(page, `/lineage/${state.runId}`);
    await expect(page.getByRole("heading", { name: "Data lineage" })).toBeVisible();

    // Refresh only re-reads the stored rows; no mutation is offered.
    await expect(page.getByRole("button", { name: "Replay" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit run" })).toHaveCount(0);

    await page.getByRole("link", { name: "Back to run detail" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${state.runId}$`));
  });

  test("reports an unknown run as NOT_FOUND with a request id", async ({ console: page }) => {
    await clientNavigate(page, "/lineage/run_does_not_exist");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("NOT_FOUND");
    await expect(alert).toContainText("request");
  });

  test("has no serious WCAG 2.2 AA violations and survives a 390 px viewport", async ({ page, state }) => {
    await signIn(page, state.key);
    await clientNavigate(page, `/lineage/${state.runId}`);
    await expect(page.getByRole("heading", { name: "Data lineage" })).toBeVisible();

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
