import AxeBuilder from "@axe-core/playwright";
import { clientNavigate, expect, signIn, test } from "./support/fixtures";

/**
 * Mapping editor: read-only schema explorers, a keyboard-complete rule table with
 * client-side static validation, a read-only version history, and save-as-new-version.
 *
 * The seeded mapping holds six rules (`r1`–`r6`) for `Patient`; the seeded asset is
 * the 24-row patients CSV. Saving posts the existing `POST /mappings` endpoint with
 * the seeded mapping name, which appends an immutable version without touching runs.
 */
test.describe("mapping editor", () => {
  test("renders stored schema explorers and the seeded rule table", async ({ console: page, state }) => {
    await clientNavigate(page, `/mapping-editor/${state.mappingId}?assetId=${state.assetId}`);

    await expect(page.getByRole("heading", { name: "Mapping editor" })).toBeVisible();
    await expect(
      page.getByText("Edits never execute against patient data in the browser", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Validate on save via the API: saving creates", { exact: false }).first(),
    ).toBeVisible();

    // Source explorer: stored asset identity plus fields referenced by the rules.
    await expect(page.getByRole("heading", { name: "Source schema" })).toBeVisible();
    await expect(page.getByText("patients.csv")).toBeVisible();
    await expect(page.getByText("patient_id", { exact: true }).first()).toBeVisible();

    // Target explorer: declared resource plus written target paths.
    await expect(page.getByRole("heading", { name: "Target schema" })).toBeVisible();
    await expect(page.getByText("Patient", { exact: true }).first()).toBeVisible();

    // Rule table: seeded rules, fully labelled for keyboard operation.
    await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Mapping rules" })).toBeVisible();
    await expect(page.getByLabel("Rule id row 1")).toHaveValue("r1");
    await expect(page.getByLabel("Transform row 5")).toHaveValue("format_gender_fhir");

    // Clean seeded draft: no client-side issues.
    await expect(page.getByText("The draft passes the client-side checks.")).toBeVisible();
  });

  test("adds, edits, reorders and deletes rules by keyboard with live engine-coded checks", async ({
    console: page,
    state,
  }) => {
    await clientNavigate(page, `/mapping-editor/${state.mappingId}?assetId=${state.assetId}`);
    await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();

    // Add a rule, then break it: an unknown transform reports the engine code.
    await page.getByRole("button", { name: "Add rule" }).click();
    const addedIndex = 7;
    await expect(page.getByLabel(`Rule id row ${addedIndex}`)).toBeVisible();
    await page.getByLabel(`Rule id row ${addedIndex}`).fill("r-dupe");
    await page.getByLabel(`Rule id row 1`).fill("r-dupe");
    await expect(page.getByText("MAPPING_DUPLICATE_RULE_ID").first()).toBeVisible();
    await page.getByLabel(`Rule id row 1`).fill("r1");

    await page.getByLabel(`Source path row ${addedIndex}`).fill("nickname");
    await page.getByLabel(`Target path row ${addedIndex}`).fill("nickname");
    await page.getByLabel(`Transform row ${addedIndex}`).fill("teleport");
    await expect(page.getByText("MAPPING_UNKNOWN_TRANSFORM").first()).toBeVisible();
    await page.getByLabel(`Transform row ${addedIndex}`).fill("trim");
    await expect(page.getByText("MAPPING_UNKNOWN_TRANSFORM")).toHaveCount(0);

    // Bad conditions report the engine's condition codes, still without executing.
    await page.getByLabel(`Conditions row ${addedIndex}`).fill('[{"op":"exists"}]');
    await expect(page.getByText("MAPPING_INVALID_CONDITION").first()).toBeVisible();
    await page.getByLabel(`Conditions row ${addedIndex}`).fill('[{"path":"nickname","op":"vibes"}]');
    await expect(page.getByText("MAPPING_UNKNOWN_CONDITION_OPERATOR").first()).toBeVisible();
    await page.getByLabel(`Conditions row ${addedIndex}`).fill("");

    // Reorder by keyboard: Move up on the added row swaps it with row 6.
    await page.getByLabel(`Target path row ${addedIndex}`).fill("nickname");
    const rows = page.getByRole("table", { name: "Mapping rules" }).getByRole("row");
    await expect(rows.nth(addedIndex).getByLabel(`Rule id row ${addedIndex}`)).toBeVisible();
    await rows.nth(addedIndex).getByRole("button", { name: "Move up" }).click();
    await expect(page.getByLabel("Rule id row 6")).toHaveValue("r-dupe");

    // Delete removes the row again; the draft is clean once more.
    await rows.nth(6).getByRole("button", { name: "Delete" }).click();
    await expect(page.getByLabel(`Rule id row ${addedIndex}`)).toHaveCount(0);
    await expect(page.getByText("The draft passes the client-side checks.")).toBeVisible();
  });

  test("shows a read-only version history and saves a new version via the API", async ({ console: page, state }) => {
    await clientNavigate(page, `/mapping-editor/${state.mappingId}?assetId=${state.assetId}`);
    await expect(page.getByRole("heading", { name: "Version history" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Mapping version history" })).toBeVisible();

    const before = await page.getByRole("table", { name: "Mapping version history" }).getByRole("row").count();

    // Editing the draft then saving appends a version; the API validates the spec.
    await page.getByLabel("Source path row 1").fill("patient_id");
    await expect(page.getByLabel("Mapping name")).toHaveValue(state.mappingName);
    await page.getByRole("button", { name: "Save as new version" }).click();
    await expect(page.getByText(/Saved .* v\d+/)).toBeVisible();

    const after = await page.getByRole("table", { name: "Mapping version history" }).getByRole("row").count();
    expect(after).toBeGreaterThan(before);
  });

  test("is read-only outside the draft and reports an unknown mapping", async ({ console: page }) => {
    await clientNavigate(page, "/mapping-editor/mp_does_not_exist");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("NOT_FOUND");
    await expect(alert).toContainText("request");

    // No execution, replay or cancellation is ever offered on this page.
    await expect(page.getByRole("button", { name: "Replay" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit run" })).toHaveCount(0);
  });

  test("has no serious WCAG 2.2 AA violations and survives a 390 px viewport", async ({ page, state }) => {
    await signIn(page, state.key);
    await clientNavigate(page, `/mapping-editor/${state.mappingId}?assetId=${state.assetId}`);
    await expect(page.getByRole("heading", { name: "Mapping editor" })).toBeVisible();

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
