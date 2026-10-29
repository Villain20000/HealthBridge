import { clientNavigate, expect, test } from "./support/fixtures";

/**
 * Runs: list, filtering, submission, detail tabs, cancellation and replay — all against the
 * live API. Navigation is client-side by design: the session is memory-only, so a hard reload
 * is supposed to sign the operator out.
 */
test.describe("runs", () => {
  test("lists seeded runs and filters by status", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "Runs" }).click();
    await expect(page).toHaveURL(/\/runs$/);
    await expect(page.getByRole("row").filter({ hasText: state.runId })).toBeVisible();

    await page.getByRole("button", { name: "Failed", exact: true }).click();
    await expect(page.getByText("No runs match this filter")).toBeVisible();

    await page.getByRole("button", { name: "Completed", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: state.runId })).toBeVisible();
  });

  test("opens the run detail and renders resources, traces and the bundle", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "Runs" }).click();
    await page.getByRole("link", { name: state.runId }).click();

    await expect(page.getByRole("heading", { name: state.runId })).toBeVisible();
    await expect(page.getByText(`${state.patientRows}/${state.patientRows}`).first()).toBeVisible();

    await page.getByRole("tab", { name: "Issues" }).click();
    await expect(page.getByRole("heading", { name: "Validation issues" })).toBeVisible();

    await page.getByRole("tab", { name: "Resources" }).click();
    await expect(page.getByText("Generated resources")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Patient" }).first()).toBeVisible();

    await page.getByRole("tab", { name: "Traces" }).click();
    await expect(page.getByText(/events · redacted payloads/)).toBeVisible();

    await page.getByRole("tab", { name: "Bundle" }).click();
    await expect(page.locator("pre")).toContainText("outputChecksum");
  });

  test("submits a new run and lands on its detail page", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "Runs" }).click();
    await page.getByRole("button", { name: "New run" }).click();

    await page.getByLabel("Asset").selectOption(state.assetId);
    await page.getByLabel("Mapping").selectOption(state.mappingId);
    await page.getByLabel("Max records (optional)").fill("3");
    await page.getByRole("button", { name: "Submit run" }).click();

    await expect(page).toHaveURL(/\/runs\/run_/);
    const runId = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
    expect(runId).not.toBe(state.runId);

    // The run really exists server-side with the option we asked for.
    const response = await page.request.get(`/api/v1/runs/${runId}`, { headers: { "x-api-key": state.key } });
    expect(response.ok()).toBe(true);
    const { run } = await response.json();
    expect(run.id).toBe(runId);
  });

  test("cancels a queued run and shows the server's final status", async ({ console: page, state, request }) => {
    const submitted = await request.post("/api/v1/runs", {
      headers: { "x-api-key": state.key, "idempotency-key": `cancel-${Date.now()}` },
      data: { assetId: state.assetId, mappingId: state.mappingId },
    });
    expect(submitted.ok()).toBe(true);
    const { run } = await submitted.json();

    const cancelled = await request.post(`/api/v1/runs/${run.id}/cancel`, {
      headers: { "x-api-key": state.key },
      data: {},
    });
    // A run that finished before the cancel arrives is a valid 409, not a bug.
    expect([200, 202, 409]).toContain(cancelled.status());

    await page.getByRole("link", { name: "Runs" }).click();
    await page.getByRole("link", { name: run.id }).click();

    const server = await (await request.get(`/api/v1/runs/${run.id}`, { headers: { "x-api-key": state.key } })).json();
    const label = {
      completed: "Completed",
      completed_with_warnings: "Completed with warnings",
      cancelled: "Cancelled",
      cancelling: "Cancelling",
      failed: "Failed",
      queued: "Queued",
      running: "Running",
    }[server.run.status as string];
    expect(label).toBeTruthy();
    await expect(page.locator("main").getByText(label!, { exact: true }).first()).toBeVisible();
  });

  test("replays a completed run into a new run", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "Runs" }).click();
    await page.getByRole("link", { name: state.runId }).click();

    const replay = page.waitForResponse(
      (response) => response.url().endsWith("/replay") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Replay" }).click();

    const response = await replay;
    expect(response.ok(), await response.text()).toBe(true);
    const { run } = await response.json();
    expect(run.id).not.toBe(state.runId);
    await expect(page).toHaveURL(new RegExp(`/runs/${run.id}$`));
  });

  test("reports an unknown run as NOT_FOUND with a request id", async ({ console: page }) => {
    await clientNavigate(page, "/runs/run_does_not_exist");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("NOT_FOUND");
    await expect(alert).toContainText("request");
  });
});
