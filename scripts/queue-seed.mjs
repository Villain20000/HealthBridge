#!/usr/bin/env node
/**
 * Seeds a queued run plus its `run_jobs` row for the restart-recovery check.
 *
 * The API is stopped when this runs, so nothing can advance the run: it is what a
 * process that died between "insert the run" and "finish the job" leaves behind.
 * The row is cloned from a real completed run, so every column keeps a valid value
 * and the worker can re-execute it against the stored asset.
 *
 *   DATABASE_URL=mysql://... node scripts/queue-seed.mjs --from run_abc --workspace ws_1
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (key) args[key] = argv[index + 1];
  }
  return args;
}

const args = parseArgs(process.argv);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!args.from || !args.workspace) {
  console.error("usage: queue-seed.mjs --from <completed run id> --workspace <workspace id>");
  process.exit(1);
}

const mysql = require("mysql2/promise");
const parsed = new URL(url);
const connection = await mysql.createConnection({
  host: parsed.hostname,
  port: parsed.port ? Number(parsed.port) : 3306,
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database: parsed.pathname.replace(/^\//, ""),
});

try {
  const [sourceRows] = await connection.query("SELECT * FROM runs WHERE id = ?", [args.from]);
  const source = sourceRows[0];
  if (!source) throw new Error(`run ${args.from} not found`);

  const runId = `run_seed_${randomBytes(6).toString("hex")}`;
  const clone = { ...source };
  delete clone.id;
  clone.workspace_id = args.workspace;
  clone.status = "queued";
  clone.started_at = null;
  clone.finished_at = null;
  clone.cancelled_at = null;
  clone.records_processed = 0;
  clone.records_succeeded = 0;
  clone.records_failed = 0;
  clone.output_checksum = null;
  clone.error = null;
  clone.result = null;
  clone.idempotency_key = null;
  clone.request_checksum = null;

  const columns = Object.keys(clone);
  // mysql2 hands JSON columns back as objects; they must be serialised again on insert.
  const value = (column) => {
    const raw = clone[column];
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "object" && !Buffer.isBuffer(raw) && !(raw instanceof Date)) return JSON.stringify(raw);
    return raw;
  };
  await connection.query(
    `INSERT INTO runs (id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`,
    [runId, ...columns.map(value)],
  );
  await connection.execute(
    `INSERT INTO run_jobs (id, workspace_id, run_id, status, attempts, available_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, NOW(3), NOW(3), NOW(3))`,
    [runId, args.workspace, runId],
  );

  process.stdout.write(`${runId}\n`);
} finally {
  await connection.end();
}
