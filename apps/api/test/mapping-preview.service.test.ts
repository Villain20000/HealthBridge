import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Principal } from "@healthbridge/auth";
import { createMemoryRepositories } from "@healthbridge/persistence";
import { MemoryStorageDriver } from "@healthbridge/storage";
import { ApiError } from "../src/common/errors.js";
import { loadTestConfig } from "../src/config.js";
import { AuditService } from "../src/services/audit.service.js";
import { MappingPreviewService } from "../src/services/mapping-preview.service.js";
import { fixture, fixtureJson } from "./harness.js";

/**
 * The route guard enforces `mappings:write`; the service enforces the asset-read
 * half of the preview contract. Testing it directly proves the check without
 * inventing a role that lacks `assets:read` (every built-in role has it).
 */

describe("MappingPreviewService scope check", () => {
  it("rejects a principal without assets:read before touching the asset", async () => {
    const repos = createMemoryRepositories();
    try {
      const service = new MappingPreviewService({
        repos,
        storage: new MemoryStorageDriver(),
        audit: new AuditService(repos),
        config: loadTestConfig(),
      });
      const principal: Principal = {
        workspaceId: "ws_test",
        apiKeyId: "key_test",
        keyName: "mappings only",
        role: "editor",
        scopes: ["mappings:write"],
      };

      await assert.rejects(
        () => service.preview(principal, { spec: {}, assetId: "as_missing" }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.code, "FORBIDDEN");
          assert.equal(error.statusCode, 403);
          const details = error.options.details as { requiredScopes?: string[] };
          assert.deepEqual(details.requiredScopes, ["mappings:write", "assets:read"]);
          return true;
        },
      );
    } finally {
      await repos.close();
    }
  });
});

describe("MappingPreviewService preview audit", () => {
  it("returns 413 and writes no mapping.previewed event when the asset exceeds the input limit", async () => {
    const repos = createMemoryRepositories();
    try {
      const config = loadTestConfig();
      const service = new MappingPreviewService({
        repos,
        storage: new MemoryStorageDriver(),
        audit: new AuditService(repos),
        config,
      });
      await repos.assets.create({
        id: "as_oversized",
        workspaceId: "ws_test",
        // The size check runs before the storage read, so this key is never fetched.
        storageKey: "missing/object",
        checksum: "sha256:test",
        filename: "patients.csv",
        contentType: "text/csv",
        sizeBytes: config.limits.maxPreviewInputBytes + 1,
        domain: "healthcare",
        sourceFormat: "csv",
        createdAt: new Date().toISOString(),
      });
      const principal: Principal = {
        workspaceId: "ws_test",
        apiKeyId: "key_test",
        keyName: "editor",
        role: "editor",
        scopes: ["mappings:write", "assets:read"],
      };

      await assert.rejects(
        () =>
          service.preview(principal, {
            spec: fixtureJson<Record<string, unknown>>(
              "scenarios",
              "01-hospital-patient-migration",
              "mapping",
              "patient.json",
            ),
            assetId: "as_oversized",
          }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.code, "PAYLOAD_TOO_LARGE");
          assert.equal(error.statusCode, 413);
          return true;
        },
      );

      const audit = await repos.audit.list("ws_test");
      assert.equal(
        audit.items.some((event) => event.action === "mapping.previewed"),
        false,
        "a rejected preview must not be audited",
      );
    } finally {
      await repos.close();
    }
  });
});

describe("MappingPreviewService adapter selection", () => {
  it("ignores an unregistered adapter recorded in asset metadata", async () => {
    const repos = createMemoryRepositories();
    try {
      const storage = new MemoryStorageDriver();
      const bytes = fixture("scenarios", "01-hospital-patient-migration", "data", "patients.csv");
      const stored = await storage.put(bytes, { contentType: "text/csv" });
      await repos.assets.create({
        id: "as_meta",
        workspaceId: "ws_test",
        storageKey: stored.key,
        checksum: stored.checksum,
        filename: "patients.csv",
        contentType: "text/csv",
        sizeBytes: stored.sizeBytes,
        domain: "healthcare",
        sourceFormat: "csv",
        metadata: { adapterId: "removed-adapter" },
        createdAt: new Date().toISOString(),
      });

      const service = new MappingPreviewService({
        repos,
        storage,
        audit: new AuditService(repos),
        config: loadTestConfig(),
      });
      const principal: Principal = {
        workspaceId: "ws_test",
        apiKeyId: "key_test",
        keyName: "editor",
        role: "editor",
        scopes: ["mappings:write", "assets:read"],
      };

      const response = await service.preview(principal, {
        spec: fixtureJson<Record<string, unknown>>(
          "scenarios",
          "01-hospital-patient-migration",
          "mapping",
          "patient.json",
        ),
        assetId: "as_meta",
        maxRecords: 1,
      });

      assert.equal(response.preview.adapter.id, "csv-adapter");
      assert.equal(response.preview.adapter.format, "csv");
      assert.equal(response.preview.recordsProcessed, 1);
    } finally {
      await repos.close();
    }
  });
});
