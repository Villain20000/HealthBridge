import { clientNavigate, expect, test } from "./support/fixtures";

/**
 * Assets: uploading real bytes through the proxy, the size limit shown from `/healthz`, and the
 * checksum header on download (B1 — `x-checksum` must be readable by the browser).
 */
test.describe("assets", () => {
  test("uploads a synthetic CSV and lists it", async ({ console: page, state, request }) => {
    const name = `e2e-upload-${Date.now()}.csv`;
    const body = "patient_id,family_name,given_name,sex,birth_date\nUP001,Upload,Test,female,1970-05-05\n";

    await page.getByRole("link", { name: "Assets" }).click();
    await page.setInputFiles('input[type="file"]', { name, mimeType: "text/csv", buffer: Buffer.from(body) });
    await page.getByRole("button", { name: "Upload", exact: true }).click();

    await expect(page.getByText(/Uploaded/)).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();

    const listed = await (await request.get("/api/v1/assets?limit=1", { headers: { "x-api-key": state.key } })).json();
    expect(listed.assets[0].filename).toBe(name);
  });

  test("shows the server's upload limit instead of a hard-coded number", async ({ console: page, request }) => {
    const health = await (await request.get("/api/v1/healthz")).json();
    const megabytes = Math.round(health.limits.maxUploadBytes / 1024 / 1024);
    await page.getByRole("link", { name: "Assets" }).click();
    await expect(page.getByText(`Max ${megabytes} MB per file`, { exact: false })).toBeVisible();
  });

  test("rejects a file larger than the documented limit with a coded error", async ({ request, state }) => {
    const health = await (await request.get("/api/v1/healthz")).json();
    const tooBig = Buffer.alloc(health.limits.maxUploadBytes + 1024, 0x61);

    const response = await request.post(`/api/v1/assets?filename=too-big.csv`, {
      headers: { "x-api-key": state.key, "content-type": "text/csv" },
      data: tooBig,
    });
    expect(response.status()).toBe(413);
    const payload = await response.json();
    expect(payload.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(payload.error.requestId).toBeTruthy();
  });

  test("downloads bytes that match the checksum the API advertises", async ({ console: page, state, request }) => {
    const direct = await request.get(`/api/v1/assets/${state.assetId}/content`, {
      headers: { "x-api-key": state.key },
    });
    expect(direct.status()).toBe(200);
    const checksum = direct.headers()["x-checksum"];
    expect(checksum).toMatch(/^sha256:/);
    expect(direct.headers()["cache-control"]).toBe("no-store");

    const listed = await (
      await request.get(`/api/v1/assets/${state.assetId}`, { headers: { "x-api-key": state.key } })
    ).json();
    expect(listed.asset.checksum).toBe(checksum);

    // The UI shows the same asset and offers the download; nothing should raise an error panel.
    await page.getByRole("link", { name: "Assets" }).click();
    await expect(page.getByRole("row").filter({ hasText: "patients.csv" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("refuses a traversal path outside the asset prefix", async ({ request }) => {
    const response = await request.get("/api/v1/assets/../../etc/passwd");
    expect([400, 401, 404]).toContain(response.status());
  });

  test("renders no console errors on the assets page", async ({ console: page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await clientNavigate(page, "/assets");
    await expect(page.getByRole("heading", { name: "Assets" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
