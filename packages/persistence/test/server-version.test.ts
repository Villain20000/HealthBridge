import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSupportedServerVersion } from "../src/index.js";

/**
 * The compatibility boundary is enforced at boot so a deployment finds out immediately
 * and with a reason, rather than halfway through the first migration with a collation
 * error that looks like a bug in the migration.
 */
describe("MySQL server version guard", () => {
  it("should accept the versions the schema is built for", () => {
    for (const version of ["8.0.36", "8.0.41-0ubuntu0.22.04.1", "8.4.0", "8.4.5", "9.1.2"]) {
      assert.doesNotThrow(() => assertSupportedServerVersion(version), version);
    }
  });

  it("should refuse MySQL 5.7 and name the feature that needs 8.0", () => {
    assert.throws(
      () => assertSupportedServerVersion("5.7.44"),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /MySQL 8\.0 or newer is required/);
        assert.match(message, /5\.7\.44/);
        assert.match(message, /SKIP LOCKED/);
        return true;
      },
    );
  });

  it("should refuse MariaDB and explain the two reasons", () => {
    assert.throws(
      () => assertSupportedServerVersion("11.8.9-MariaDB-ubu2404"),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /MariaDB is not supported/);
        assert.match(message, /utf8mb4_0900_ai_ci/);
        assert.match(message, /SKIP LOCKED/);
        return true;
      },
    );
  });

  it("should refuse a version string it cannot parse rather than guess", () => {
    assert.throws(() => assertSupportedServerVersion("unknown"), /MySQL 8\.0 or newer is required/);
    assert.throws(() => assertSupportedServerVersion(""), /MySQL 8\.0 or newer is required/);
  });
});
