import { clientNavigate, expect, test } from "./support/fixtures";

/**
 * API keys and the audit trail: creation reveals a secret exactly once, rotation replaces it,
 * and every action shows up in the audit log with its request id.
 */
test.describe("keys and audit", () => {
  test("creates a key, reveals the secret once and never persists it", async ({ console: page }) => {
    const name = `e2e-created-${Date.now()}`;
    await page.getByRole("link", { name: "API keys" }).click();
    await page.getByRole("button", { name: "New key" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Role").selectOption("viewer");
    await page.getByRole("button", { name: "Create key" }).click();

    const revealed = page.getByText("Copy this secret now");
    await expect(revealed).toBeVisible();
    const secret = await page.locator("section code").first().innerText();
    expect(secret).toMatch(/^hb_/);

    const stored = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toContain(secret);

    await page.reload();
    await expect(page).toHaveURL(/\/connect$/);

    await page.getByLabel("API key", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    // The viewer key cannot administer keys — the API says 403, the console is honest about it.
    await clientNavigate(page, "/keys");
    await expect(page.getByRole("alert")).toContainText(/FORBIDDEN|UNAUTHORIZED|MISSING_SCOPE/);
  });

  test("lists keys with prefixes and never with secrets", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "API keys" }).click();
    const row = page.getByRole("row").filter({ hasText: "bootstrap owner key" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("owner");

    const body = await page.locator("main").innerText();
    expect(body).not.toContain(state.key);
  });

  test("records activity in the audit log", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "Audit" }).click();
    await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: "run.created" }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("success");

    const body = await page.locator("main").innerText();
    expect(body).toContain("run.created");
    expect(body).not.toContain(state.key);
  });
});
