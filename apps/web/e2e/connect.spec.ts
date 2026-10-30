import { expect, readState, signIn, test } from "./support/fixtures";

/**
 * Connection and key handling — the part of the console with the sharpest edge: the key must
 * never be persisted, and every failure must be explainable.
 */
test.describe("connect", () => {
  const state = readState();

  test("keeps the API key out of browser storage and out of the URL", async ({ page }) => {
    await signIn(page, state.key);

    expect(page.url()).not.toContain(state.key);
    const storage = await page.evaluate(() => ({
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
      cookies: document.cookie,
    }));
    expect(storage.local).not.toContain(state.key);
    expect(storage.session).not.toContain(state.key);
    expect(storage.cookies).not.toContain(state.key);

    // The shell may show a masked prefix, never the secret.
    const body = await page.locator("body").innerText();
    expect(body).toContain(state.key.slice(0, 6));
    expect(body).not.toContain(state.key);
  });

  test("drops the session when the tab reloads", async ({ page }) => {
    await signIn(page, state.key);
    await page.reload();
    await expect(page).toHaveURL(/\/connect\?returnUrl=/);
    await expect(page.getByRole("heading", { name: "Connect to HealthBridge" })).toBeVisible();
  });

  test("disconnects explicitly and returns to the connect screen", async ({ page }) => {
    await signIn(page, state.key);
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page).toHaveURL(/\/connect$/);
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  });

  test("explains a malformed key before blaming the server", async ({ page }) => {
    await page.goto("/connect");
    await page.getByLabel("API key", { exact: true }).fill("not-a-key");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("MALFORMED_KEY");
    await expect(alert).toContainText("request");
    await expect(page).toHaveURL(/\/connect$/);
  });

  test("shows UNAUTHORIZED and the request id for a well-formed but unknown key", async ({ page }) => {
    await page.goto("/connect");
    await page.getByLabel("API key", { exact: true }).fill(`hb_${"A".repeat(43)}`);
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText(/UNAUTHORIZED|MALFORMED_KEY/);
    await expect(alert).toContainText("request");
    await expect(page).toHaveURL(/\/connect$/);
  });

  test("a revoked key cannot open a session", async ({ page, request }) => {
    const revoked = await request.delete(`/api/v1/keys/${state.viewerKeyId}`, { headers: { "x-api-key": state.key } });
    expect(revoked.ok()).toBe(true);

    await page.goto("/connect");
    await page.getByLabel("API key", { exact: true }).fill(state.viewerKey);
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect(page.getByRole("alert")).toContainText(/REVOKED_KEY|UNAUTHORIZED/);
    await expect(page).toHaveURL(/\/connect$/);
  });

  test("ends the session and explains itself when the key is revoked mid-session", async ({ page, request }) => {
    // A dedicated key becomes this session's credential, so revoking it disturbs nothing else.
    const created = await request.post("/api/v1/keys", {
      headers: { "x-api-key": state.key, "idempotency-key": `revoke-me-${Date.now()}` },
      data: { name: `throwaway-${Date.now()}`, role: "viewer" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const createdKey = (await created.json()) as { key: string; apiKey: { id: string } };

    await signIn(page, createdKey.key);
    const revoke = await request.delete(`/api/v1/keys/${createdKey.apiKey.id}`, {
      headers: { "x-api-key": state.key },
    });
    expect(revoke.ok()).toBe(true);

    // The next call fails with 401; the console drops the session and returns to /connect.
    await page.getByRole("link", { name: "Runs" }).click();
    await expect(page).toHaveURL(/\/connect\?returnUrl=/);
    await expect(page.getByText(/the API key was rejected/i)).toBeVisible();
  });
});
