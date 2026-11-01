import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli, EXIT_CODES, parseArgs } from "../src/index.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "healthbridge-cli-"));
}

const repoRoot = path.resolve(process.cwd());
const patientsCsv = path.join(repoRoot, "datasets", "synthetic-patients.csv");

describe("CLI argument parsing", () => {
  test("parses commands, values and boolean flags", () => {
    const parsed = parseArgs(["transform", "input.csv", "--mapping", "m.json", "--json"]);
    assert.deepEqual(parsed.command, ["transform", "input.csv"]);
    assert.equal(parsed.flags.mapping, "m.json");
    assert.equal(parsed.flags.json, true);
  });

  test("supports --flag=value syntax", () => {
    const parsed = parseArgs(["inspect", "a.csv", "--max-records=10"]);
    assert.equal(parsed.flags["max-records"], "10");
  });
});

describe("healthbridge doctor", () => {
  test("reports real adapter health and a passing self-test", async () => {
    const { io, out } = capture();
    const code = await runCli(["doctor", "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    const report = JSON.parse(out());
    assert.equal(report.status, "healthy");
    assert.equal(report.adapters.length, 4);
    assert.ok(report.adapters.every((a: { ok: boolean }) => a.ok));
    assert.equal(report.selfTest.ok, true);
    assert.ok(report.nodeSupported);
  });

  test("human output names the adapters", async () => {
    const { io, out } = capture();
    await runCli(["doctor"], io);
    assert.match(out(), /csv-adapter/);
    assert.match(out(), /Self-test/);
  });
});

describe("formats", () => {
  test("lists adapters as JSON with honest status", async () => {
    const { io, out } = capture();
    const code = await runCli(["formats", "list", "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    const manifests = JSON.parse(out());
    const formats = manifests.map((m: { format: string }) => m.format).sort();
    assert.deepEqual(formats, ["csv", "fhir-r4-json", "fhir-r4-ndjson", "json"]);
    assert.ok(manifests.every((m: { status?: string }) => Boolean(m.status)));
  });

  test("inspects a file for format candidates", async () => {
    const { io, out } = capture();
    const code = await runCli(["formats", "inspect", patientsCsv, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    const payload = JSON.parse(out());
    assert.equal(payload.candidates[0].adapterId, "csv-adapter");
    assert.ok(payload.inspection.recordCount >= 2);
  });
});

describe("inspect and transform", () => {
  test("inspect prints a schema summary", async () => {
    const { io, out } = capture();
    const code = await runCli(["inspect", patientsCsv], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.match(out(), /Format:\s+csv/);
    assert.match(out(), /patient_id/);
  });

  test("transform emits array-shaped FHIR output and a summary line", async () => {
    const { io, out, err } = capture();
    const code = await runCli(["transform", patientsCsv], io);
    assert.equal(code, EXIT_CODES.OK);
    const result = JSON.parse(out());
    assert.equal(result.recordsSucceeded, result.recordsProcessed);
    const patient = result.output[0];
    assert.equal(patient.resourceType, "Patient");
    assert.ok(Array.isArray(patient.name));
    assert.ok(Array.isArray(patient.name[0].given));
    assert.match(err(), /coverage=\d+%/);
  });

  test("transform can write NDJSON to a file", async () => {
    const dir = tempDir();
    const outFile = path.join(dir, "patients.ndjson");
    const { io } = capture();
    const code = await runCli(["transform", patientsCsv, "--out", outFile, "--format", "ndjson", "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    const lines = fs.readFileSync(outFile, "utf-8").trim().split("\n");
    assert.ok(lines.length >= 2);
    assert.equal(JSON.parse(lines[0]).resourceType, "Patient");
  });

  test("transform accepts a YAML mapping", async () => {
    const dir = tempDir();
    const mappingFile = path.join(dir, "mapping.yaml");
    fs.writeFileSync(
      mappingFile,
      [
        "id: yaml-patient",
        "name: YAML patient mapping",
        "version: 1.0.0",
        "sourceFormat: csv",
        "targetFormat: fhir-r4",
        "rules:",
        "  - id: r0",
        "    sourcePath: patient_id",
        "    targetPath: resourceType",
        "    transform: identity",
        "    defaultValue: Patient",
        "  - id: r1",
        "    sourcePath: patient_id",
        "    targetPath: id",
        "    transform: identity",
        "    required: true",
      ].join("\n"),
      "utf-8",
    );
    const { io, out } = capture();
    const code = await runCli(["transform", patientsCsv, "--mapping", mappingFile, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    const result = JSON.parse(out());
    assert.equal(result.output[0].id, "P101");
  });

  test("missing input file exits with the documented code", async () => {
    const { io, err } = capture();
    const code = await runCli(["transform", "does-not-exist.csv"], io);
    assert.equal(code, EXIT_CODES.INPUT_INVALID);
    assert.match(err(), /not found/i);
  });
});

describe("validate", () => {
  test("valid FHIR Patient exits 0", async () => {
    const dir = tempDir();
    const file = path.join(dir, "patient.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ resourceType: "Patient", id: "p1", gender: "female", birthDate: "1990-11-23" }),
    );
    const { io, out } = capture();
    const code = await runCli(["validate", file, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(JSON.parse(out()).isValid, true);
  });

  test("invalid FHIR Patient exits 3 and reports issues", async () => {
    const dir = tempDir();
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ resourceType: "Patient", gender: "nope", birthDate: "23/11/1990" }));
    const { io, out } = capture();
    const code = await runCli(["validate", file, "--json"], io);
    assert.equal(code, EXIT_CODES.VALIDATION_FAILED);
    const validation = JSON.parse(out());
    assert.equal(validation.isValid, false);
    assert.ok(validation.issues.length >= 2);
    assert.equal(validation.operationOutcome.resourceType, "OperationOutcome");
  });

  test("rejects an unsupported standard", async () => {
    const dir = tempDir();
    const file = path.join(dir, "patient.json");
    fs.writeFileSync(file, JSON.stringify({ resourceType: "Patient" }));
    const { io } = capture();
    const code = await runCli(["validate", file, "--standard", "hl7v2"], io);
    assert.equal(code, EXIT_CODES.USAGE);
  });
});

describe("trace, init, demo, plugins, examples", () => {
  test("trace show renders a timeline from a run export", async () => {
    const dir = tempDir();
    const resultFile = path.join(dir, "run.json");
    const transformCapture = capture();
    await runCli(["transform", patientsCsv, "--json"], transformCapture.io);
    fs.writeFileSync(resultFile, transformCapture.out(), "utf-8");

    const { io, out } = capture();
    const code = await runCli(["trace", "show", resultFile], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.match(out(), /parse/);
    assert.match(out(), /mapping/);
  });

  test("init scaffolds a project and refuses to overwrite", async () => {
    const dir = tempDir();
    const first = capture();
    assert.equal(await runCli(["init", "--dir", dir], first.io), EXIT_CODES.OK);
    assert.ok(fs.existsSync(path.join(dir, "healthbridge.config.json")));
    assert.ok(fs.existsSync(path.join(dir, "mappings", "patient.json")));

    const second = capture();
    assert.equal(await runCli(["init", "--dir", dir], second.io), EXIT_CODES.USAGE);
  });

  test("demo generate is deterministic for a given seed", async () => {
    const dir = tempDir();
    const a = path.join(dir, "a.csv");
    const b = path.join(dir, "b.csv");
    await runCli(
      ["demo", "generate", "--profile", "broken-dates", "--seed", "7", "--records", "5", "--out", a],
      capture().io,
    );
    await runCli(
      ["demo", "generate", "--profile", "broken-dates", "--seed", "7", "--records", "5", "--out", b],
      capture().io,
    );
    assert.equal(fs.readFileSync(a, "utf-8"), fs.readFileSync(b, "utf-8"));
    assert.equal(fs.readFileSync(a, "utf-8").trim().split("\n").length, 6);
  });

  test("unknown command exits with usage code", async () => {
    const { io, err } = capture();
    assert.equal(await runCli(["nope"], io), EXIT_CODES.USAGE);
    assert.match(err(), /Unknown command/);
  });

  test("plugins and examples list run without a project", async () => {
    assert.equal(await runCli(["plugins", "list"], capture().io), EXIT_CODES.OK);
    assert.equal(await runCli(["examples", "list"], capture().io), EXIT_CODES.OK);
  });
});
