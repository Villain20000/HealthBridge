import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fixture, startApi, type ApiClient, type TestApi } from "./harness.js";

/**
 * `GET /assets/:id/schema` — adapter inspect/schema summary for a stored asset.
 */

describe("asset schema", () => {
  let api: TestApi;
  let owner: ApiClient;

  before(async () => {
    api = await startApi();
    const bootstrap = await api
      .client()
      .request<{ workspace: { id: string }; apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
        body: { name: "Schema Clinic", slug: "schema-clinic" },
        headers: { "x-bootstrap-token": "test-bootstrap-token" },
      });
    assert.equal(bootstrap.status, 201, bootstrap.raw);
    owner = api.client(bootstrap.body.apiKey.key);
  });

  after(async () => {
    await api.close();
  });

  it("returns the detected field summary for a CSV asset", async () => {
    const bytes = fixture("scenarios", "01-hospital-patient-migration", "data", "patients.csv");
    const upload = await owner.request<{ asset: { id: string } }>("POST", "/api/v1/assets?filename=patients.csv", {
      raw: bytes,
      headers: { "content-type": "text/csv" },
    });
    assert.equal(upload.status, 201, upload.raw);

    const response = await owner.request<{
      assetId: string;
      format: string;
      domain: string;
      supported: boolean;
      adapterId: string | null;
      recordCount: number | null;
      confidence: number | null;
      schema: { fields: Array<{ name: string; type: string }> } | null;
      warnings: string[];
    }>("GET", `/api/v1/assets/${upload.body.asset.id}/schema`);
    assert.equal(response.status, 200, response.raw);
    assert.equal(response.body.assetId, upload.body.asset.id);
    assert.equal(response.body.format, "csv");
    assert.equal(response.body.supported, true);
    assert.equal(response.body.adapterId, "csv-adapter");
    assert.ok((response.body.recordCount ?? 0) > 0, "recordCount must be positive");
    assert.ok(response.body.schema, "a CSV asset must carry a detected schema");
    assert.ok(response.body.schema.fields.length > 0, "schema must list fields");
    for (const field of response.body.schema.fields) {
      assert.equal(typeof field.name, "string");
      assert.equal(typeof field.type, "string");
      assert.ok(!("sampleValues" in field), "field summaries must not leak sample values");
    }
    assert.ok(Array.isArray(response.body.warnings));
  });

  it("reports unsupported instead of failing when no adapter accepts the bytes", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x99]);
    const upload = await owner.request<{ asset: { id: string } }>("POST", "/api/v1/assets?filename=blob.bin", {
      raw: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(upload.status, 201, upload.raw);

    const response = await owner.request<{
      assetId: string;
      supported: boolean;
      adapterId: string | null;
      schema: unknown;
      warnings: string[];
    }>("GET", `/api/v1/assets/${upload.body.asset.id}/schema`);
    assert.equal(response.status, 200, response.raw);
    assert.equal(response.body.supported, false);
    assert.equal(response.body.schema, null);
    assert.equal(response.body.adapterId, null);
    assert.ok(response.body.warnings.length > 0, "the fallback must explain itself");
  });

  it("returns 404 for an unknown asset id", async () => {
    const response = await owner.request<{ error: { code: string } }>("GET", "/api/v1/assets/as_missing/schema");
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "NOT_FOUND");
  });

  it("requires authentication", async () => {
    const response = await api.client().request<{ error: { code: string } }>("GET", "/api/v1/assets/as_x/schema");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "UNAUTHENTICATED");
  });
});
