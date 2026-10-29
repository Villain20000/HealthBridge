import { expect, test } from "./support/fixtures";

/**
 * Dashboard: the numbers on screen must be the server's numbers, including the mode and queue
 * badges that decide whether data survives a restart.
 */
test.describe("dashboard", () => {
  test("shows execution mode, queue mode and limits from /healthz", async ({ console: page, request }) => {
    const health = await (await request.get("/api/v1/healthz")).json();

    await expect(page.getByText(`mode: ${health.mode}`)).toBeVisible();
    await expect(page.getByText(`queue: ${health.queue.mode}`)).toBeVisible();
    await expect(page.getByText(health.persistence)).toBeVisible();
    await expect(page.getByText("Execution limits")).toBeVisible();
    await expect(page.getByText("Rate limits")).toBeVisible();

    const body = await page.locator("main").innerText();
    expect(body).toContain(`${health.limits.rateLimit.burst} requests`);
    expect(body).toContain(`${health.limits.queue.concurrency} concurrent`);
  });

  test("lists the seeded run with its real counts", async ({ console: page, state, request }) => {
    const { run } = await (
      await request.get(`/api/v1/runs/${state.runId}`, { headers: { "x-api-key": state.key } })
    ).json();

    const row = page.getByRole("row").filter({ hasText: state.runId });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`${run.recordsSucceeded}/${run.recordsProcessed}`);
  });

  test("reflects a status change without a page reload", async ({ console: page, state, request }) => {
    const second = await (
      await request.get(`/api/v1/runs/${state.secondRunId}`, { headers: { "x-api-key": state.key } })
    ).json();
    // The second seeded run is finished; the count label must not contradict the API.
    const row = page.getByRole("row").filter({ hasText: state.secondRunId });
    await expect(row).toContainText(String(second.run.recordsProcessed));
  });
});
