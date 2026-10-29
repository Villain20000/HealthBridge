import { clientNavigate, expect, signIn, test } from "./support/fixtures";

/**
 * SSE through the reverse proxy.
 *
 * The direct request proves the proxy forwards `text/event-stream` without buffering; the
 * browser tests prove the console sends the key in a header, reacts to frames, and closes the
 * stream when the run settles.
 */
test.describe("live progress", () => {
  test("the proxy streams event frames without buffering", async ({ request, state }) => {
    const submitted = await request.post("/api/v1/runs", {
      headers: { "x-api-key": state.key, "idempotency-key": `sse-${Date.now()}` },
      data: { assetId: state.assetId, mappingId: state.mappingId },
    });
    expect(submitted.ok()).toBe(true);
    const { run } = await submitted.json();

    const started = Date.now();
    const response = await request.get(`/api/v1/runs/${run.id}/events`, { headers: { "x-api-key": state.key } });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/event-stream");
    expect(response.headers()["cache-control"]).toBe("no-store, no-transform");

    const body = await response.text();
    expect(body).toMatch(/event:/);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test("shows live status for a running run and settles on the terminal state", async ({ page, state, request }) => {
    const submitted = await request.post("/api/v1/runs", {
      headers: { "x-api-key": state.key, "idempotency-key": `live-${Date.now()}` },
      data: { assetId: state.assetId, mappingId: state.mappingId },
    });
    const { run } = await submitted.json();

    await signIn(page, state.key);
    await clientNavigate(page, `/runs/${run.id}`);

    await expect(page.getByText(/live \(SSE\)|connecting…|reconnecting…|not streaming/)).toBeVisible();
    await expect(
      page
        .locator("main")
        .getByText(/^(Completed|Completed with warnings|Failed|Cancelled)$/)
        .first(),
    ).toBeVisible({
      timeout: 30_000,
    });

    const finalStatus = await (
      await request.get(`/api/v1/runs/${run.id}`, { headers: { "x-api-key": state.key } })
    ).json();
    expect(["completed", "completed_with_warnings", "failed", "cancelled"]).toContain(finalStatus.run.status);
  });

  test("streams with the API key in a header, not in the URL, and stops at a terminal frame", async ({
    page,
    state,
  }) => {
    const submitted = await page.request.post("/api/v1/runs", {
      headers: { "x-api-key": state.key, "idempotency-key": `sse-headers-${Date.now()}` },
      data: { assetId: state.assetId, mappingId: state.mappingId },
    });
    const { run } = await submitted.json();
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    const running = {
      id: run.id,
      status: "running",
      recordsProcessed: 1,
      recordsSucceeded: 1,
      recordsFailed: 0,
      engineVersion: "test",
      mappingId: "mp",
      assetId: "as",
      createdAt: new Date().toISOString(),
    };
    const completed = { ...running, status: "completed", finishedAt: new Date().toISOString() };

    // One handler for the run and its stream: a single route avoids relying on which of two
    // overlapping patterns Playwright picks first.
    await page.route(`**/api/v1/runs/${run.id}**`, async (route) => {
      if (route.request().url().includes("/events")) {
        seen.push({ url: route.request().url(), headers: route.request().headers() });
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
          body: `id: 1\nevent: status\ndata: ${JSON.stringify({ run: running })}\n\nid: 2\nevent: done\ndata: ${JSON.stringify({ run: completed })}\n\n`,
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: running }) });
    });

    await signIn(page, state.key);
    await clientNavigate(page, `/runs/${run.id}`);

    await expect(page.locator("main").getByText("Completed", { exact: true }).first()).toBeVisible();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.headers["x-api-key"]).toBe(state.key);
    expect(seen[0]!.headers["accept"]).toContain("text/event-stream");
    expect(seen[0]!.url).not.toContain(state.key);
    await expect(page.getByText("not streaming")).toBeVisible();
  });
});
