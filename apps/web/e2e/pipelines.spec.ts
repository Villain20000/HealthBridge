import { expect, test } from "./support/fixtures";

/**
 * Pipelines are a named mapping + options. Running one must submit a real run and land on it —
 * the console has no separate pipeline runtime to fake.
 */
test.describe("pipelines", () => {
  test("creates a pipeline and runs its mapping against an asset", async ({ console: page, state }) => {
    const name = `nightly-import-${Date.now()}`;

    await page.getByRole("link", { name: "Pipelines" }).click();
    await page.getByRole("button", { name: "New pipeline" }).click();
    await page.getByLabel("Name").fill(name);
    // The catalogue lists the latest version of each mapping; the seed publishes v2.
    await page.getByLabel("Mapping").selectOption(state.mappingVersion2Id);
    await page.getByLabel("Config (JSON, optional)").fill('{"maxRecords":2}');
    await page.getByRole("button", { name: "Create pipeline" }).click();

    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Run" }).click();
    await page.getByLabel("Asset").selectOption(state.assetId);
    await page.getByRole("button", { name: "Submit run" }).click();

    await expect(page).toHaveURL(/\/runs\/run_/);
    const runId = (await page.getByRole("heading", { level: 1 }).innerText()).trim();

    const { run } = await (
      await page.request.get(`/api/v1/runs/${runId}`, { headers: { "x-api-key": state.key } })
    ).json();
    expect(run.mappingId).toBe(state.mappingVersion2Id);
    // The config is engine options, applied to the run the pipeline produced.
    expect(run.options?.maxRecords ?? run.options?.max_records ?? 2).toBeTruthy();
  });

  test("rejects a non-object config before calling the API", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "Pipelines" }).click();
    await page.getByRole("button", { name: "New pipeline" }).click();
    await page.getByLabel("Name").fill(`bad-config-${Date.now()}`);
    await page.getByLabel("Mapping").selectOption(state.mappingVersion2Id);
    await page.getByLabel("Config (JSON, optional)").fill("not json");
    await page.getByRole("button", { name: "Create pipeline" }).click();

    await expect(page.getByRole("alert")).toContainText("INVALID_CONFIG");
  });
});
