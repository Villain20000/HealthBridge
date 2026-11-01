import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli, EXIT_CODES } from "../src/index.js";
import {
  decodeBufferWithEncoding,
  parseDelimiterValue,
  parseEncodingValue,
  resolveDelimiterFlag,
  resolveEncodingFlag,
} from "../src/overrides.js";
import { getCommandHelp } from "../src/help.js";
import { renderCompletion } from "../src/completions.js";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "healthbridge-flags-"));
}

function writeTempFile(dir: string, name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("delimiter flag parsing", () => {
  test("accepts every documented spelling", () => {
    const cases: Array<[string, string]> = [
      [",", ","],
      ["comma", ","],
      [";", ";"],
      ["semicolon", ";"],
      ["tab", "\t"],
      ["\\t", "\t"],
      ["\t", "\t"],
      ["|", "|"],
      ["pipe", "|"],
      ["SEMICOLON", ";"],
    ];
    for (const [raw, expected] of cases) {
      const parsed = parseDelimiterValue(raw);
      assert.equal(parsed.ok, true, raw);
      if (parsed.ok) assert.equal(parsed.value, expected, raw);
    }
  });

  test("rejects anything outside the strict set", () => {
    for (const raw of ["", ":", ";;", "t", "space", "coma", "true"]) {
      const parsed = parseDelimiterValue(raw);
      assert.equal(parsed.ok, false, raw);
      if (!parsed.ok) assert.match(parsed.message, /Supported delimiters/);
    }
  });

  test("a bare --delimiter without a value is an error, not silent", () => {
    const parsed = resolveDelimiterFlag(true);
    assert.equal(parsed.ok, false);
  });

  test("absent flag resolves to no override", () => {
    assert.deepEqual(resolveDelimiterFlag(undefined), { ok: true, value: undefined });
  });
});

describe("encoding flag parsing", () => {
  test("accepts the documented encodings and common aliases", () => {
    const cases: Array<[string, string]> = [
      ["utf-8", "utf-8"],
      ["UTF-8", "utf-8"],
      ["utf8", "utf-8"],
      ["utf-16le", "utf-16le"],
      ["UTF-16LE", "utf-16le"],
      ["windows-1252", "windows-1252"],
      ["windows1252", "windows-1252"],
    ];
    for (const [raw, expected] of cases) {
      const parsed = parseEncodingValue(raw);
      assert.equal(parsed.ok, true, raw);
      if (parsed.ok) assert.equal(parsed.value, expected, raw);
    }
  });

  test("rejects anything outside the strict set", () => {
    for (const raw of ["", "latin1", "ascii", "utf-32", "utf16", "true"]) {
      const parsed = parseEncodingValue(raw);
      assert.equal(parsed.ok, false, raw);
      if (!parsed.ok) assert.match(parsed.message, /Supported encodings/);
    }
  });

  test("a bare --encoding without a value is an error, not silent", () => {
    assert.equal(resolveEncodingFlag(true).ok, false);
  });
});

describe("decodeBufferWithEncoding", () => {
  test("decodes windows-1252 bytes", () => {
    const bytes = Buffer.from("García", "latin1");
    assert.equal(decodeBufferWithEncoding(bytes, "windows-1252"), "García");
  });

  test("decodes utf-16le bytes without a BOM", () => {
    const bytes = Buffer.from("patient_id\nP1\n", "utf16le");
    assert.equal(decodeBufferWithEncoding(bytes, "utf-16le"), "patient_id\nP1\n");
  });

  test("throws actionable advice on undecodable bytes", () => {
    assert.throws(() => decodeBufferWithEncoding(Buffer.from([0xe9, 0x20]), "utf-8"), /not valid utf-8/);
  });

  test("strips a leading BOM so downstream parsers see clean text", () => {
    assert.equal(decodeBufferWithEncoding(Buffer.from("\uFEFFhi", "utf-8"), "utf-8"), "hi");
    assert.equal(decodeBufferWithEncoding(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), "utf-16le"), "hi");
  });
});

describe("transform/inspect --delimiter", () => {
  // Both ',' and ';' split every line exactly once, so auto-detection ties
  // and picks ',' (first candidate). Forcing ';' must change the parse.
  const tieCsv = "patient_id;first_name;last_name;gender;birth_date,note\nP1;Ada;Lovelace;F;1815-12-10,hi\n";

  test("invalid values exit 2 with actionable advice", async () => {
    const dir = tempDir();
    const file = writeTempFile(dir, "tie.csv", tieCsv);
    for (const args of [
      ["transform", file, "--delimiter", ":"],
      ["transform", file, "--delimiter"],
      ["inspect", file, "--delimiter", "space"],
    ]) {
      const { io, err } = capture();
      assert.equal(await runCli(args, io), EXIT_CODES.INPUT_INVALID, args.join(" "));
      assert.match(err(), /--delimiter/);
      assert.match(err(), /Supported delimiters/);
    }
  });

  test("auto-detection ties on ',' while the override parses ';'", async () => {
    const dir = tempDir();
    const file = writeTempFile(dir, "tie.csv", tieCsv);

    const auto = capture();
    assert.equal(await runCli(["inspect", file, "--json"], auto.io), EXIT_CODES.OK);
    const autoFields = JSON.parse(auto.out()).detectedSchema.fields.map((f: { name: string }) => f.name);
    assert.deepEqual(autoFields, ["patient_id;first_name;last_name;gender;birth_date", "note"]);

    const forced = capture();
    assert.equal(await runCli(["transform", file, "--delimiter", ";", "--json"], forced.io), EXIT_CODES.OK);
    const result = JSON.parse(forced.out());
    assert.equal(result.recordsSucceeded, 1);
    assert.equal(result.output[0].id, "P1");
    assert.equal(result.output[0].gender, "female");
  });

  test("inspect records the active override without re-interpreting the schema", async () => {
    const dir = tempDir();
    const file = writeTempFile(dir, "tie.csv", tieCsv);
    const { io, out } = capture();
    assert.equal(await runCli(["inspect", file, "--delimiter", ";", "--json"], io), EXIT_CODES.OK);
    const inspection = JSON.parse(out());
    assert.ok((inspection.warnings as string[]).some((w) => w.includes("Delimiter override active")));
  });

  test("tab and pipe spellings reach the parser", async () => {
    const dir = tempDir();
    const pipeFile = writeTempFile(dir, "p.csv", "a|b\n1|2\n");
    const { io, out } = capture();
    assert.equal(await runCli(["inspect", pipeFile, "--delimiter", "pipe", "--json"], io), EXIT_CODES.OK);
    assert.ok(out().includes("Delimiter override active"));

    // ',' ties with '\t' (one consistent split each) and wins auto-detection,
    // so only the override yields a successful patient run.
    const tabFile = writeTempFile(
      dir,
      "t.csv",
      "patient_id\tfirst_name\tlast_name\tgender\tbirth_date,note\nP1\tAda\tLovelace\tF\t1815-12-10,hi\n",
    );
    const tabbed = capture();
    assert.equal(await runCli(["transform", tabFile, "--delimiter", "tab", "--json"], tabbed.io), EXIT_CODES.OK);
    const tabbedResult = JSON.parse(tabbed.out());
    assert.equal(tabbedResult.sourceFormat, "csv");
    assert.equal(tabbedResult.recordsSucceeded, 1);
    assert.equal(tabbedResult.output[0].id, "P1");
  });
});

describe("transform/inspect --encoding", () => {
  test("invalid values exit 2 with actionable advice", async () => {
    const dir = tempDir();
    const file = writeTempFile(dir, "a.csv", "a\n1\n");
    for (const args of [
      ["transform", file, "--encoding", "latin1"],
      ["transform", file, "--encoding"],
      ["inspect", file, "--encoding", "ascii"],
    ]) {
      const { io, err } = capture();
      assert.equal(await runCli(args, io), EXIT_CODES.INPUT_INVALID, args.join(" "));
      assert.match(err(), /--encoding/);
      assert.match(err(), /Supported encodings/);
    }
  });

  test("utf-16le without a BOM parses with the override", async () => {
    const dir = tempDir();
    const bytes = Buffer.from("patient_id,first_name\nP1,Ada\n", "utf16le");
    const file = writeTempFile(dir, "u.csv", bytes);
    const { io, out } = capture();
    assert.equal(await runCli(["inspect", file, "--encoding", "utf-16le", "--json"], io), EXIT_CODES.OK);
    const fields = JSON.parse(out()).detectedSchema.fields.map((f: { name: string }) => f.name);
    assert.deepEqual(fields, ["patient_id", "first_name"]);
  });

  test("windows-1252 bytes survive the override", async () => {
    const dir = tempDir();
    const file = writeTempFile(
      dir,
      "w.csv",
      Buffer.concat([
        Buffer.from("patient_id,first_name\nP1,", "utf-8"),
        Buffer.from("García", "latin1"),
        Buffer.from("\n", "utf-8"),
      ]),
    );
    const { io, out } = capture();
    assert.equal(await runCli(["transform", file, "--encoding", "windows-1252", "--json"], io), EXIT_CODES.OK);
    const result = JSON.parse(out());
    assert.equal(result.recordsSucceeded, 1);
    assert.equal(result.output[0].name[0].given[0], "García");
  });

  test("bytes that are invalid in the claimed encoding exit 2", async () => {
    const dir = tempDir();
    const file = writeTempFile(dir, "bad.csv", Buffer.from([0xe9, 0x20]));
    const { io, err } = capture();
    assert.equal(await runCli(["transform", file, "--encoding", "utf-8"], io), EXIT_CODES.INPUT_INVALID);
    assert.match(err(), /not valid utf-8/);
  });
});

describe("completions", () => {
  test("bash script lists commands and flags without runtime execution", async () => {
    const { io, out } = capture();
    assert.equal(await runCli(["completions", "bash"], io), EXIT_CODES.OK);
    const script = out();
    for (const token of ["transform", "inspect", "validate", "doctor", "--delimiter", "--encoding"]) {
      assert.ok(script.includes(token), token);
    }
    assert.ok(!script.includes("$(healthbridge"), "must not execute the CLI");
  });

  test("zsh script lists commands via static _arguments", async () => {
    const { io, out } = capture();
    assert.equal(await runCli(["completions", "zsh"], io), EXIT_CODES.OK);
    const script = out();
    assert.ok(script.includes("_arguments"));
    assert.ok(script.includes("transform"));
    assert.ok(!script.includes("$(healthbridge"), "must not execute the CLI");
  });

  test("renderCompletion rejects unknown shells", () => {
    assert.equal(renderCompletion("fish"), undefined);
    assert.equal(renderCompletion(""), undefined);
  });

  test("unsupported or missing shell exits 1 with usage advice", async () => {
    for (const args of [["completions", "fish"], ["completions"]]) {
      const { io, err } = capture();
      assert.equal(await runCli(args, io), EXIT_CODES.USAGE, args.join(" "));
      assert.match(err(), /bash\|zsh/);
    }
  });
});

describe("per-command help", () => {
  const pages: Array<[string[], string]> = [
    [["transform", "--help"], "--mapping"],
    [["inspect", "--help"], "--adapter"],
    [["validate", "--help"], "fhir-r4"],
    [["formats", "--help"], "capabilities"],
    [["doctor", "--help"], "self-test"],
    [["trace", "--help"], "timeline"],
    [["reproduce", "--help"], "bundle"],
    [["demo", "--help"], "broken-dates"],
    [["formats", "list", "--help"], "capabilities"],
  ];

  for (const [args, token] of pages) {
    test(`${args.join(" ")} exits 0 and documents the command`, async () => {
      const { io, out } = capture();
      assert.equal(await runCli(args, io), EXIT_CODES.OK);
      assert.ok(out().includes(token), token);
    });
  }

  test("transform --help does not require an input file", async () => {
    const { io } = capture();
    assert.equal(await runCli(["transform", "--help"], io), EXIT_CODES.OK);
  });

  test("getCommandHelp returns undefined for unknown commands", () => {
    assert.equal(getCommandHelp("nope"), undefined);
    assert.equal(getCommandHelp(""), undefined);
  });

  test("global help advertises per-command help and the new surface", async () => {
    const { io, out } = capture();
    assert.equal(await runCli(["help"], io), EXIT_CODES.OK);
    assert.ok(out().includes("--delimiter"));
    assert.ok(out().includes("--encoding"));
    assert.ok(out().includes("completions"));
    assert.ok(out().includes("--help"));
  });
});
