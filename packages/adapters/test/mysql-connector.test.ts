/**
 * Offline unit tests for the read-only MySQL source connector (fake driver)
 * plus a live-server suite gated behind `HEALTHBRIDGE_TEST_MYSQL_URL`,
 * following the same skip-when-unset pattern as
 * `packages/persistence/test/mysql.integration.test.ts`.
 *
 * The fake implements the connector's `MySqlRowSource` surface and records
 * every statement it was asked to run, so the refusal tests prove the
 * forbidden statement was never executed — not just that an issue was raised.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MYSQL_CONNECTOR_ID,
  MYSQL_INSPECT_SAMPLE_ROWS,
  MySqlSourceConnectorAdapter,
  assertReadOnlyStatement,
  buildTableSelect,
  checksumMysqlRow,
  checksumStatement,
  escapeMysqlIdentifier,
  eraseCommentsAndLiterals,
  redactConnectionSecrets,
  resolveMysqlSource,
} from "../src/mysql-connector.js";
import type { MySqlConnectConfig, MySqlRowSource } from "../src/mysql-connector.js";
import { runAdapterConformance } from "../src/kit.js";
import type { InputDescriptor, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

const SECRET = "s3cr3t-pw";

interface FakeOptions {
  rows?: Record<string, unknown>[];
  hang?: boolean;
  failWith?: Error;
  failConnectWith?: Error;
}

function createFakeDriver(fakeOptions: FakeOptions = {}) {
  const state = {
    executed: [] as Array<{ sql: string; params?: unknown[] }>,
    connectConfigs: [] as MySqlConnectConfig[],
    closed: 0,
  };
  async function* emitRows(rows: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
    for (const row of rows) yield row;
  }
  async function* hangForever(): AsyncIterable<Record<string, unknown>> {
    await new Promise(() => undefined);
    yield {};
  }
  const connect = async (config: MySqlConnectConfig): Promise<MySqlRowSource> => {
    state.connectConfigs.push(config);
    if (fakeOptions.failConnectWith) throw fakeOptions.failConnectWith;
    return {
      rows(sql: string, params?: unknown[]): AsyncIterable<Record<string, unknown>> {
        state.executed.push({ sql, params });
        if (fakeOptions.failWith) {
          throw fakeOptions.failWith;
        }
        if (fakeOptions.hang) return hangForever();
        return emitRows(fakeOptions.rows ?? []);
      },
      async close(): Promise<void> {
        state.closed += 1;
      },
    };
  };
  return { state, connect };
}

function contextWith(options: Record<string, unknown>, onIssue: (issue: ValidationIssue) => void): ParseContext {
  return { adapterId: MYSQL_CONNECTOR_ID, adapterVersion: "1.0.0", options, onIssue };
}

async function collect(adapter: MySqlSourceConnectorAdapter, input: InputDescriptor, context: ParseContext) {
  const envelopes = [];
  for await (const envelope of adapter.parse(input, context)) {
    envelopes.push(envelope);
  }
  return envelopes;
}

const READY_INPUT: InputDescriptor = { id: "mysql-in", uri: "mysql://reader@127.0.0.1:3306/clinic" };
const READY_OPTIONS = { sql: "SELECT id, name FROM patients", maxRows: 100, timeoutMs: 5_000 };

describe("MySQL connector statement gate", () => {
  it("allows the read-only statement kinds, case-insensitively", () => {
    assert.equal(assertReadOnlyStatement("SELECT id FROM patients"), "SELECT");
    assert.equal(assertReadOnlyStatement("  select 1"), "SELECT");
    assert.equal(assertReadOnlyStatement("SHOW TABLES"), "SHOW");
    assert.equal(assertReadOnlyStatement("DESCRIBE patients"), "DESCRIBE");
    assert.equal(assertReadOnlyStatement("DESC patients"), "DESCRIBE");
    assert.equal(assertReadOnlyStatement("EXPLAIN SELECT 1"), "EXPLAIN");
    assert.equal(assertReadOnlyStatement("WITH c AS (SELECT 1 AS x) SELECT * FROM c"), "WITH");
    assert.equal(assertReadOnlyStatement("/* audit */ SELECT 1;"), "SELECT");
    assert.equal(assertReadOnlyStatement("-- leading comment\nSELECT 1"), "SELECT");
  });

  it("refuses writes, DDL and admin statements with an explicit code", () => {
    const refused = [
      "INSERT INTO patients VALUES (1)",
      "insert into patients select * from other",
      "UPDATE patients SET name = 'x'",
      "DELETE FROM patients",
      "REPLACE INTO patients VALUES (1)",
      "DROP TABLE patients",
      "CREATE TABLE evil (id INT)",
      "ALTER TABLE patients ADD COLUMN x INT",
      "TRUNCATE TABLE patients",
      "GRANT ALL ON *.* TO 'x'",
      "SELECT * FROM patients INTO OUTFILE '/tmp/x'",
      "LOAD DATA INFILE '/tmp/x' INTO TABLE patients",
      "CALL refresh_materialized()",
      "SET @x = 1",
      "USE other_db",
      "WITH moved AS (DELETE FROM a RETURNING *) SELECT * FROM moved",
    ];
    for (const sql of refused) {
      assert.throws(
        () => assertReadOnlyStatement(sql),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "MYSQL_WRITE_REFUSED");
          assert.ok(!(error as Error).message.includes("INSERT INTO patients"));
          return true;
        },
        `expected refusal for: ${sql}`,
      );
    }
  });

  it("refuses stacked statements even when the first one reads", () => {
    for (const sql of ["SELECT 1; DROP TABLE patients", "SELECT 1;SELECT 2", "SHOW TABLES; DELETE FROM t"]) {
      assert.throws(
        () => assertReadOnlyStatement(sql),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "MYSQL_MULTIPLE_STATEMENTS_REFUSED");
          return true;
        },
      );
    }
  });

  it("is not fooled by keywords inside comments or string literals", () => {
    assert.equal(assertReadOnlyStatement("SELECT 'delete me', \"drop this\" FROM t"), "SELECT");
    assert.equal(assertReadOnlyStatement("/* DELETE */ SELECT 1 -- DROP"), "SELECT");
    assert.throws(
      () => assertReadOnlyStatement("-- just a comment\nDELETE FROM t"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "MYSQL_WRITE_REFUSED");
        return true;
      },
    );
  });

  it("erases literals so keyword scans see structure, not values", () => {
    assert.ok(!eraseCommentsAndLiterals("SELECT 'a; b' FROM t").includes("a; b"));
    assert.ok(eraseCommentsAndLiterals("SELECT 1 /* x */").trim().endsWith("SELECT 1"));
  });
});

describe("MySQL connector detection", () => {
  const adapter = new MySqlSourceConnectorAdapter({ connect: createFakeDriver().connect });

  it("claims mysql:// and mysqlx:// URIs", async () => {
    assert.equal(await adapter.detect({ id: "a", uri: "mysql://reader@db:3306/clinic" }), true);
    assert.equal(await adapter.score({ id: "b", uri: "mysqlx://reader@db:33060/clinic" }), 0.85);
  });

  it("never claims file payloads", async () => {
    const payloads: InputDescriptor[] = [
      { id: "f1", filename: "dump.sql", contentString: "SELECT * FROM patients;" },
      { id: "f2", filename: "patients.csv", contentString: "id,name\n1,Jane\n" },
      { id: "f3", filename: "p.json", contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }) },
      { id: "f4", filename: "data.bin", buffer: Buffer.from([0, 1, 2, 3]) },
      { id: "f5", uri: "postgres://reader@db:5432/clinic" },
      { id: "f6", uri: "https://example.com/export.csv" },
      { id: "f7" },
    ];
    for (const input of payloads) {
      assert.equal(await adapter.detect(input), false, `must not claim ${input.id}`);
      assert.equal(await adapter.score(input), 0, `must score zero for ${input.id}`);
    }
  });

  it("never throws from score", async () => {
    assert.equal(await adapter.score({ id: "bad", uri: "://not a url" }), 0);
  });
});

describe("MySQL connector parse (fake driver)", () => {
  it("yields one envelope per row with checksum and provenance", async () => {
    const fake = createFakeDriver({
      rows: [
        { id: 1, name: "Jane" },
        { id: 2, name: "John" },
      ],
    });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(
      adapter,
      READY_INPUT,
      contextWith(READY_OPTIONS, (issue) => issues.push(issue)),
    );

    assert.equal(envelopes.length, 2);
    assert.deepEqual(issues, []);
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelopes[0].provenance.adapterId, MYSQL_CONNECTOR_ID);
    assert.equal(envelopes[0].provenance.recordIndex, 0);
    assert.equal(envelopes[0].provenance.sourceLocation, "row 1");
    assert.equal(envelopes[1].provenance.sourceLocation, "row 2");
    assert.equal(envelopes[0].source.format, "mysql");
    assert.deepEqual((envelopes[0].content as { data: unknown }).data, { id: 1, name: "Jane" });
    assert.equal(fake.state.executed.length, 1);
    assert.equal(fake.state.executed[0].sql, READY_OPTIONS.sql);
    assert.equal(fake.state.closed, 1);
  });

  it("streams within the row cap and reports truncation explicitly", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: index }));
    const fake = createFakeDriver({ rows });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(
      adapter,
      READY_INPUT,
      contextWith({ sql: "SELECT id FROM t", maxRows: 3, timeoutMs: 5_000 }, (issue) => issues.push(issue)),
    );

    assert.equal(envelopes.length, 3);
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ["MYSQL_ROW_CAP_TRUNCATED"],
    );
    assert.equal(issues[0].severity, "warning");
    assert.ok(issues[0].advice);
  });

  it("treats exactly-at-cap as complete, not truncated", async () => {
    const fake = createFakeDriver({ rows: [{ id: 1 }, { id: 2 }] });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(
      adapter,
      READY_INPUT,
      contextWith({ sql: "SELECT id FROM t", maxRows: 2, timeoutMs: 5_000 }, (issue) => issues.push(issue)),
    );
    assert.equal(envelopes.length, 2);
    assert.deepEqual(issues, []);
  });

  it("honours context.maxRecords as a cap with a truncation issue", async () => {
    const fake = createFakeDriver({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(adapter, READY_INPUT, {
      adapterId: MYSQL_CONNECTOR_ID,
      adapterVersion: "1.0.0",
      maxRecords: 2,
      options: { sql: "SELECT id FROM t", timeoutMs: 5_000 },
      onIssue: (issue) => issues.push(issue),
    });
    assert.equal(envelopes.length, 2);
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ["MYSQL_ROW_CAP_TRUNCATED"],
    );
  });

  it("refuses write statements before touching the driver", async () => {
    for (const sql of ["DELETE FROM patients", "SELECT 1; DROP TABLE patients", "INSERT INTO t VALUES (1)"]) {
      const fake = createFakeDriver({ rows: [{ id: 1 }] });
      const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
      const issues: ValidationIssue[] = [];
      const envelopes = await collect(
        adapter,
        READY_INPUT,
        contextWith({ sql, timeoutMs: 5_000 }, (issue) => issues.push(issue)),
      );
      assert.equal(envelopes.length, 0);
      assert.ok(
        issues.some(
          (issue) => issue.code === "MYSQL_WRITE_REFUSED" || issue.code === "MYSQL_MULTIPLE_STATEMENTS_REFUSED",
        ),
        `expected refusal issue for ${sql}`,
      );
      assert.equal(fake.state.executed.length, 0, "refused statements must never execute");
      assert.equal(fake.state.connectConfigs.length, 0, "refused statements must not even connect");
    }
  });

  it("reports missing configuration instead of guessing", async () => {
    const fake = createFakeDriver();
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(
      adapter,
      { id: "cfg" },
      contextWith({}, (issue) => issues.push(issue)),
    );
    assert.equal(envelopes.length, 0);
    assert.equal(issues[0].code, "MYSQL_CONFIG_MISSING");
    assert.equal(fake.state.connectConfigs.length, 0);
  });

  it("reports driver failures with sanitised messages", async () => {
    const fake = createFakeDriver({
      failWith: new Error(`Access denied for user 'reader'@'db' (using password: YES) password=${SECRET}`),
    });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(
      adapter,
      READY_INPUT,
      contextWith(READY_OPTIONS, (issue) => issues.push(issue)),
    );
    assert.equal(envelopes.length, 0);
    assert.equal(issues[0].code, "MYSQL_QUERY_FAILED");
    assert.ok(!issues[0].message.includes(SECRET));
    assert.equal(fake.state.closed, 1);
  });

  it("reports connection failures with sanitised messages", async () => {
    const fake = createFakeDriver({
      failConnectWith: new Error(`connect ECONNREFUSED mysql://reader:${SECRET}@db:3306/clinic`),
    });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(
      adapter,
      READY_INPUT,
      contextWith(READY_OPTIONS, (issue) => issues.push(issue)),
    );
    assert.equal(envelopes.length, 0);
    assert.equal(issues[0].code, "MYSQL_CONNECTION_FAILED");
    assert.ok(!issues[0].message.includes(SECRET));
  });

  it("cancels a hanging read at the deadline with MYSQL_QUERY_TIMEOUT", async () => {
    const fake = createFakeDriver({ hang: true });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(
      adapter,
      READY_INPUT,
      contextWith({ sql: "SELECT SLEEP(30)", timeoutMs: 50 }, (issue) => issues.push(issue)),
    );
    assert.equal(envelopes.length, 0);
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ["MYSQL_QUERY_TIMEOUT"],
    );
    assert.equal(fake.state.closed, 1);
  });

  it("keeps raw SQL, params and passwords out of every envelope and issue", async () => {
    const fake = createFakeDriver({ rows: [{ ssn: "123-45-6789" }] });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const sql = "SELECT ssn FROM patients WHERE ssn = '123-45-6789'";
    const envelopes = await collect(
      adapter,
      { id: "sec", uri: `mysql://reader:${SECRET}@127.0.0.1:3306/clinic` },
      contextWith({ sql, params: [SECRET], timeoutMs: 5_000, maxRows: 1 }, (issue) => issues.push(issue)),
    );
    assert.equal(envelopes.length, 1);
    const serialised = JSON.stringify({ envelopes, issues });
    assert.ok(!serialised.includes(SECRET), "no credential or param value may leak");
    assert.ok(!(envelopes[0].metadata as Record<string, unknown>)["sql"], "raw SQL is stored as a checksum, not text");
    assert.match(String((envelopes[0].metadata as Record<string, unknown>)["queryChecksum"]), /^sha256:[a-f0-9]{64}$/);
  });

  it("resolves the password from an environment secret ref", async () => {
    process.env.HB_CONNECTOR_TEST_PW = SECRET;
    try {
      const fake = createFakeDriver({ rows: [{ id: 1 }] });
      const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
      const issues: ValidationIssue[] = [];
      const envelopes = await collect(
        adapter,
        READY_INPUT,
        contextWith({ sql: "SELECT id FROM t", passwordEnv: "HB_CONNECTOR_TEST_PW", timeoutMs: 5_000 }, (issue) =>
          issues.push(issue),
        ),
      );
      assert.equal(envelopes.length, 1);
      assert.equal(fake.state.connectConfigs[0].password, SECRET);
      assert.ok(!JSON.stringify({ envelopes, issues }).includes(SECRET));
    } finally {
      delete process.env.HB_CONNECTOR_TEST_PW;
    }
  });

  it("accepts a table reference and builds an escaped SELECT", async () => {
    const fake = createFakeDriver({ rows: [{ id: 7 }] });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const issues: ValidationIssue[] = [];
    const envelopes = await collect(
      adapter,
      { id: "t", uri: "mysql://reader@127.0.0.1:3306/clinic" },
      contextWith({ table: "patients", timeoutMs: 5_000 }, (issue) => issues.push(issue)),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(fake.state.executed[0].sql, "SELECT * FROM `clinic`.`patients`");
    assert.deepEqual(issues, []);
  });

  it("normalises driver values to JSON-safe data and checksums", () => {
    const row = { blob: Buffer.from("hi"), big: 42n, when: new Date("2026-03-01T00:00:00.000Z"), nil: null };
    const checksum = checksumMysqlRow(row);
    assert.match(checksum, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      checksum,
      checksumMysqlRow({ when: new Date("2026-03-01T00:00:00.000Z"), nil: null, big: 42n, blob: Buffer.from("hi") }),
    );
    assert.equal(checksumStatement("SELECT  a\nFROM t"), checksumStatement("SELECT a FROM t"));
  });

  it("rejects hostile identifiers instead of interpolating them", () => {
    for (const throwing of [() => escapeMysqlIdentifier("a`b"), () => buildTableSelect("t; DROP TABLE t")]) {
      assert.throws(throwing, (error: unknown) => {
        assert.equal((error as { code?: string }).code, "MYSQL_INVALID_OPTION");
        return true;
      });
    }
    assert.equal(buildTableSelect("patients", "clinic"), "SELECT * FROM `clinic`.`patients`");
  });
});

describe("MySQL connector inspect (fake driver)", () => {
  it("reports schema, samples and honest warnings without a record count", async () => {
    const fake = createFakeDriver({
      rows: [
        { id: 1, name: "Jane", active: true },
        { id: 2, name: "John", active: false },
      ],
    });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const inspection = await adapter.inspect({
      id: "insp",
      uri: "mysql://reader@127.0.0.1:3306/clinic?query=SELECT%20id%2C%20name%20FROM%20patients",
    });
    assert.equal(inspection.format, "mysql");
    assert.equal(inspection.status, "partial");
    assert.equal(inspection.recordCount, undefined);
    assert.ok((inspection.detectedSchema?.fields.length ?? 0) >= 3);
    assert.equal(inspection.sampleRecords?.length, 2);
    assert.ok(inspection.warnings?.some((warning) => warning.includes("recordCount is omitted")));
    assert.ok(inspection.warnings?.some((warning) => warning.includes("row cap")));
  });

  it("caps inspection reads at the sample size", async () => {
    const rows = Array.from({ length: MYSQL_INSPECT_SAMPLE_ROWS + 10 }, (_, index) => ({ id: index }));
    const fake = createFakeDriver({ rows });
    const adapter = new MySqlSourceConnectorAdapter({ connect: fake.connect });
    const inspection = await adapter.inspect({
      id: "insp-cap",
      uri: "mysql://reader@127.0.0.1:3306/clinic?query=SELECT%20id%20FROM%20t",
    });
    assert.equal(inspection.sampleRecords?.length, MYSQL_INSPECT_SAMPLE_ROWS);
  });

  it("describes refusal and connection failure as warnings instead of throwing", async () => {
    const adapter = new MySqlSourceConnectorAdapter({ connect: createFakeDriver().connect });
    const refused = await adapter.inspect({
      id: "insp-bad",
      uri: "mysql://reader@127.0.0.1:3306/clinic?query=DELETE%20FROM%20t",
    });
    assert.ok(refused.warnings?.some((warning) => warning.includes("MYSQL_WRITE_REFUSED")));

    const failing = new MySqlSourceConnectorAdapter({
      connect: createFakeDriver({ failConnectWith: new Error("connect ECONNREFUSED 127.0.0.1:3306 (using password: YES)") })
        .connect,
    });
    const failed = await failing.inspect({
      id: "insp-down",
      uri: "mysql://reader@127.0.0.1:3306/clinic?query=SELECT%201",
    });
    assert.ok(failed.warnings?.some((warning) => warning.includes("MYSQL_CONNECTION_FAILED")));
    assert.ok(!(failed.warnings ?? []).join(" ").includes(SECRET));
  });
});

describe("MySQL connector misc", () => {
  it("exposes a partial manifest that claims no file surface", async () => {
    const adapter = new MySqlSourceConnectorAdapter({ connect: createFakeDriver().connect });
    const manifest = adapter.getManifest();
    assert.equal(manifest.format, "mysql");
    assert.equal(manifest.status, "partial");
    assert.deepEqual(manifest.extensions, []);
    assert.deepEqual(manifest.mimeTypes, []);
    assert.ok(manifest.limitations.length >= 3);
  });

  it("satisfies the shared adapter conformance contract", async () => {
    const adapter = new MySqlSourceConnectorAdapter({ connect: createFakeDriver().connect });
    const failures = await runAdapterConformance(adapter);
    assert.deepEqual(failures, []);
  });

  it("reports healthy without a default connection and never throws", async () => {
    const saved = process.env.HEALTHBRIDGE_MYSQL_URL;
    delete process.env.HEALTHBRIDGE_MYSQL_URL;
    try {
      const adapter = new MySqlSourceConnectorAdapter({ connect: createFakeDriver().connect });
      const result = await adapter.health();
      assert.equal(result.ok, true);
      assert.ok(result.details.includes("HEALTHBRIDGE_MYSQL_URL"));
    } finally {
      if (saved !== undefined) process.env.HEALTHBRIDGE_MYSQL_URL = saved;
    }
  });

  it("redacts credentials embedded in connection strings and driver errors", () => {
    assert.equal(
      redactConnectionSecrets(`mysql://reader:${SECRET}@db:3306/clinic`),
      "mysql://reader:***@db:3306/clinic",
    );
    const scrubbed = redactConnectionSecrets(
      `Access denied for user 'r' (using password: YES) password=${SECRET}`,
    );
    assert.ok(!scrubbed.includes(SECRET));
    assert.ok(scrubbed.includes("password=***"));
    assert.ok(scrubbed.includes("password: ***"));
  });

  it("resolves options over URI parts and validates option shapes", () => {
    const resolved = resolveMysqlSource(
      { id: "r", uri: "mysql://uri-user@uri-host:3307/uri_db?maxRows=10" },
      { user: "opt-user", sql: "SELECT 1", password: SECRET },
    );
    assert.equal(resolved.host, "uri-host");
    assert.equal(resolved.port, 3307);
    assert.equal(resolved.user, "opt-user");
    assert.equal(resolved.password, SECRET);
    assert.equal(resolved.maxRows, 10);
    assert.equal(resolved.origin, "mysql://uri-host:3307/uri_db");
    assert.ok(!resolved.origin.includes(SECRET));

    assert.throws(() => resolveMysqlSource({ id: "x" }, { sql: "SELECT 1" }), /host/);
    assert.throws(
      () => resolveMysqlSource({ id: "x", uri: "mysql://u@h/db" }, { sql: "SELECT 1", params: "nope" }),
      /params/,
    );
    assert.throws(
      () => resolveMysqlSource({ id: "x", uri: "mysql://u@h/db" }, { sql: "SELECT 1", maxRows: 0 }),
      /maxRows/,
    );
  });
});

/**
 * Live MySQL connector tests.
 *
 * Skipped unless HEALTHBRIDGE_TEST_MYSQL_URL is set, because a database is an
 * external dependency the default suite must not require — the same rule as
 * `packages/persistence/test/mysql.integration.test.ts`:
 *
 *   docker run -d --name hb-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -e MYSQL_DATABASE=healthbridge_test -p 33061:3306 mysql:8.4
 *
 *   HEALTHBRIDGE_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:33061/healthbridge_test \
 *     node scripts/run-tests.mjs "packages/adapters/test/mysql-connector.test.ts"
 */
const LIVE_URL = process.env.HEALTHBRIDGE_TEST_MYSQL_URL;
const LIVE_ENABLED = Boolean(LIVE_URL);

describe(
  "MySQL connector (live server)",
  { skip: LIVE_ENABLED ? false : "HEALTHBRIDGE_TEST_MYSQL_URL is not set" },
  () => {
    it("streams table rows into envelopes with checksum and provenance", async () => {
      const mysql = await import("mysql2");
      const url = new URL(LIVE_URL!);
      const setup = mysql.createConnection({
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      });
      const table = `hb_connector_probe_${Date.now().toString(36)}`;
      const query = (sql: string, values: unknown[] = []) =>
        new Promise<void>((resolve, reject) => {
          setup.query(sql, values, (error) => (error ? reject(error) : resolve()));
        });
      await query(
        `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, name VARCHAR(64), score INT NULL, created DATETIME(3) NULL)`,
      );
      try {
        await query(`INSERT INTO \`${table}\` (id, name, score, created) VALUES ?`, [
          [
            [1, "Ada", 95, new Date("2026-02-01T10:00:00.000Z")],
            [2, "Bob", null, null],
            [3, "Cid", 71, new Date("2026-02-03T10:00:00.000Z")],
          ],
        ]);

        const adapter = new MySqlSourceConnectorAdapter();
        const issues: ValidationIssue[] = [];
        const input: InputDescriptor = { id: "live", uri: LIVE_URL! };
        const envelopes = [];
        for await (const envelope of adapter.parse(
          input,
          contextWith(
            { sql: `SELECT id, name, score, created FROM \`${table}\` ORDER BY id`, maxRows: 100, timeoutMs: 15_000 },
            (issue) => issues.push(issue),
          ),
        )) {
          envelopes.push(envelope);
        }

        assert.equal(envelopes.length, 3);
        assert.deepEqual(issues, []);
        assert.deepEqual((envelopes[0].content as { data: Record<string, unknown> }).data, {
          id: 1,
          name: "Ada",
          score: 95,
          created: "2026-02-01T10:00:00.000Z",
        });
        assert.equal((envelopes[1].content as { data: Record<string, unknown> }).data["score"], null);
        assert.match(String(envelopes[2].source.checksum), /^sha256:[a-f0-9]{64}$/);
        assert.equal(envelopes[2].provenance.sourceLocation, "row 3");
        assert.equal(envelopes[0].source.format, "mysql");
        const serialised = JSON.stringify({ envelopes, issues });
        assert.ok(!serialised.includes(decodeURIComponent(url.password)));

        const inspection = await adapter.inspect({
          id: "live-inspect",
          uri: `${LIVE_URL!}?query=${encodeURIComponent(`SELECT id, name FROM \`${table}\` ORDER BY id`)}`,
        });
        assert.equal(inspection.format, "mysql");
        assert.ok((inspection.sampleRecords?.length ?? 0) >= 1);
        assert.ok((inspection.detectedSchema?.fields.map((field) => field.name) ?? []).includes("name"));
      } finally {
        await query(`DROP TABLE IF EXISTS \`${table}\``);
        setup.destroy();
      }
    });
  },
);
