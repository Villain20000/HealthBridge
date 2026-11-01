import * as fs from "node:fs";
import * as path from "node:path";
import {
  HealthBridge,
  HealthBridgeError,
  type InputDescriptor,
  type MappingDefinition,
  ENGINE_VERSION,
  type RunBundle,
} from "@healthbridge/sdk";
import { exportTraceReport } from "@healthbridge/trace-protocol";
import { parse as parseYaml } from "yaml";
import {
  bridgeWithCsvDelimiterOverride,
  decodeBufferWithEncoding,
  resolveDelimiterFlag,
  resolveEncodingFlag,
} from "./overrides.js";
import { getCommandHelp } from "./help.js";
import { renderCompletion } from "./completions.js";

export const EXIT_CODES = {
  OK: 0,
  USAGE: 1,
  INPUT_INVALID: 2,
  VALIDATION_FAILED: 3,
  ADAPTER_ERROR: 4,
  INTERNAL: 5,
  CANCELLED: 6,
} as const;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const DEFAULT_PATIENT_MAPPING: MappingDefinition = {
  id: "patient-csv-to-fhir",
  name: "CSV Patient to FHIR R4 Patient",
  version: "1.1.0",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  targetResourceType: "Patient",
  sourceDomains: ["clinical"],
  rules: [
    {
      id: "r0",
      sourcePath: "__constant_resourceType",
      targetPath: "resourceType",
      transform: "default_value",
      defaultValue: "Patient",
      description: "Target-format constant; the source has no resourceType column",
    },
    { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true },
    { id: "r2", sourcePath: "first_name", targetPath: "name.0.given.0", transform: "trim" },
    { id: "r3", sourcePath: "last_name", targetPath: "name.0.family", transform: "uppercase" },
    { id: "r4", sourcePath: "gender", targetPath: "gender", transform: "format_gender_fhir" },
    { id: "r5", sourcePath: "birth_date", targetPath: "birthDate", transform: "parse_date_iso" },
  ],
};

interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=");
      if (inlineValue !== undefined) {
        flags[rawKey] = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[rawKey] = next;
          i++;
        } else {
          flags[rawKey] = true;
        }
      }
    } else {
      command.push(arg);
    }
  }

  return { command, flags };
}

function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagBool(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export function stdinInputDescriptor(
  text: string,
  filename = "stdin.csv",
): {
  id: string;
  filename: string;
  contentString: string;
} {
  return { id: "stdin", filename, contentString: text };
}

export async function readStdinText(
  stream: NodeJS.ReadableStream = process.stdin as NodeJS.ReadableStream,
  encoding?: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (encoding === undefined) return buffer.toString("utf-8");
  return decodeBufferWithEncoding(buffer, encoding);
}

/**
 * Build the transform/inspect input for a resolved file path. Without an
 * encoding override the path is passed through untouched so the engine's
 * auto-detection (BOM sniffing, windows-1252 fallback) applies; with an
 * override the bytes are decoded here and the engine receives plain text.
 */
function buildFileInput(
  filePath: string,
  encoding: string | undefined,
  io: CliIo,
): string | InputDescriptor | undefined {
  if (encoding === undefined) return filePath;
  try {
    return {
      id: `file-${path.basename(filePath)}`,
      filename: path.basename(filePath),
      contentString: decodeBufferWithEncoding(fs.readFileSync(filePath), encoding),
    };
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    return undefined;
  }
}

async function buildTransformInput(
  inputArg: string,
  flags: ParsedArgs["flags"],
  encoding: string | undefined,
  io: CliIo,
): Promise<string | InputDescriptor | undefined> {
  if (inputArg === "-") {
    try {
      const text = await readStdinText(process.stdin as NodeJS.ReadableStream, encoding);
      return stdinInputDescriptor(text, flagString(flags, "filename") ?? "stdin.csv");
    } catch (error) {
      io.err(`Error: ${(error as Error).message}`);
      return undefined;
    }
  }
  const filePath = requireFile(inputArg, io, "Input file");
  if (!filePath) return undefined;
  return buildFileInput(filePath, encoding, io);
}

function requireFile(filePath: string | undefined, io: CliIo, label = "Input file"): string | undefined {
  if (!filePath) {
    io.err(`Error: ${label} path is required`);
    return undefined;
  }
  if (!fs.existsSync(filePath)) {
    io.err(`Error: ${label} not found: ${filePath}`);
    return undefined;
  }
  return filePath;
}

function loadMapping(filePath: string, io: CliIo): MappingDefinition | undefined {
  if (!fs.existsSync(filePath)) {
    io.err(`Error: mapping file not found: ${filePath}`);
    return undefined;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    const parsed = /\.ya?ml$/i.test(filePath) ? parseYaml(raw) : JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rules)) {
      io.err(`Error: mapping file '${filePath}' has no 'rules' array`);
      return undefined;
    }
    return parsed as MappingDefinition;
  } catch (error) {
    io.err(`Error: could not parse mapping '${filePath}': ${(error as Error).message}`);
    return undefined;
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [render(headers), render(widths.map((w) => "-".repeat(w))), ...rows.map(render)].join("\n");
}

function seedPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateBrokenDates(records: number, seed: number): string {
  const random = seedPrng(seed);
  const firstNames = ["Jane", "John", "Maria", "Ahmed", "Yuki", "Olga", "Liam", "Chen"];
  const lastNames = ["Doe", "Smith", "García", "Khan", "Tanaka", "Petrova", "O'Brien", "Wei"];
  const brokenDates = [
    "",
    "31/02/1990",
    "1990-13-45",
    "03/04/1985",
    "not a date",
    "1985-04-12",
    "2024-02-30",
    "0000-00-00",
  ];
  const genders = ["M", "F", "male", "female", "X", "", "U", "Other"];

  const rows = ["patient_id,first_name,last_name,gender,birth_date,ssn"];
  for (let i = 0; i < records; i++) {
    const id = i % 11 === 10 ? "" : `P${String(1000 + i)}`;
    rows.push(
      [
        id,
        firstNames[Math.floor(random() * firstNames.length)],
        lastNames[Math.floor(random() * lastNames.length)],
        genders[Math.floor(random() * genders.length)],
        brokenDates[Math.floor(random() * brokenDates.length)],
        `999-${String(10 + (i % 89)).padStart(2, "0")}-${String(1000 + (i % 8999)).padStart(4, "0")}`,
      ].join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

async function runDoctor(flags: ParsedArgs["flags"], io: CliIo): Promise<number> {
  const bridge = new HealthBridge();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const adapters = await bridge.adapterHealth();
  const selfTest = await runSelfTest(bridge);

  const report = {
    engineVersion: ENGINE_VERSION,
    nodeVersion: process.version,
    nodeSupported: nodeMajor >= 20,
    platform: `${process.platform}/${process.arch}`,
    adapters,
    selfTest,
    workingDirectory: process.cwd(),
    status: nodeMajor >= 20 && selfTest.ok && adapters.every((a) => a.ok) ? "healthy" : "degraded",
  };

  if (flagBool(flags, "json")) {
    io.out(JSON.stringify(report, null, 2));
    return report.status === "healthy" ? EXIT_CODES.OK : EXIT_CODES.INTERNAL;
  }

  io.out(`HealthBridge OS ${ENGINE_VERSION} — environment check`);
  io.out(`  Node.js:        ${process.version} ${nodeMajor >= 20 ? "(supported)" : "(UNSUPPORTED, need >= 20)"}`);
  io.out(`  Platform:       ${report.platform}`);
  io.out(`  Working dir:    ${report.workingDirectory}`);
  io.out(`  Database:       not required (offline standalone mode)`);
  io.out("");
  io.out("Adapters:");
  for (const adapter of adapters) {
    io.out(
      `  ${adapter.ok ? "OK  " : "FAIL"} ${adapter.format} (${adapter.adapterId} v${adapter.version}) — ${adapter.details}`,
    );
  }
  io.out("");
  io.out(`Self-test (CSV → mapping → trace): ${selfTest.ok ? "passed" : "FAILED"} — ${selfTest.details}`);
  io.out(`Status: ${report.status === "healthy" ? "healthy" : "degraded"}`);

  return report.status === "healthy" ? EXIT_CODES.OK : EXIT_CODES.INTERNAL;
}

async function runSelfTest(bridge: HealthBridge): Promise<{ ok: boolean; details: string }> {
  try {
    const result = await bridge.transform({
      input: {
        id: "doctor-fixture",
        filename: "doctor.csv",
        contentString: "patient_id,first_name,last_name,gender,birth_date\nP1,Ada,Lovelace,F,1815-12-10",
      },
      mapping: DEFAULT_PATIENT_MAPPING,
    });
    const first = result.output[0] as Record<string, unknown> | undefined;
    const nameOk = Array.isArray(first?.name);
    // Sentinels that cannot appear in step names or issue codes.
    const tracesRedacted =
      !JSON.stringify(result.traces).includes("123-45-6789") && !JSON.stringify(result.traces).includes("Lovelace");
    const ok = result.recordsSucceeded === 1 && nameOk && tracesRedacted;
    return {
      ok,
      details: ok
        ? `1 record transformed in ${result.durationMs}ms, arrays valid, traces redacted`
        : `unexpected result: succeeded=${result.recordsSucceeded}, nameIsArray=${nameOk}, tracesRedacted=${tracesRedacted}`,
    };
  } catch (error) {
    return { ok: false, details: (error as Error).message };
  }
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const [primary, secondary] = command;
  if (flagBool(flags, "help")) {
    const topic = getCommandHelp(primary ?? "", secondary);
    if (topic) {
      io.out(topic);
      return EXIT_CODES.OK;
    }
  }
  const bridge = new HealthBridge();
  const json = flagBool(flags, "json");

  try {
    switch (primary) {
      case "doctor":
        return await runDoctor(flags, io);

      case "formats":
      case "adapters": {
        if (secondary === "inspect") {
          const filePath = requireFile(command[2], io, "File");
          if (!filePath) return EXIT_CODES.INPUT_INVALID;
          const candidates = await bridge.detect(filePath);
          const inspection = await bridge.inspect(filePath);
          if (json) {
            io.out(JSON.stringify({ candidates, inspection }, null, 2));
            return EXIT_CODES.OK;
          }
          io.out(`File: ${filePath}`);
          io.out(`Detected: ${inspection.format} (confidence ${candidates[0]?.confidence ?? "n/a"})`);
          if (candidates.length > 1) {
            io.out("Other candidates:");
            for (const candidate of candidates.slice(1)) io.out(`  - ${candidate.format} (${candidate.confidence})`);
          }
          io.out(
            `Records: ${inspection.recordCount ?? "unknown"}  Domain: ${inspection.domain}  Status: ${inspection.status ?? "n/a"}`,
          );
          for (const field of inspection.detectedSchema?.fields ?? []) {
            io.out(`  ${field.name.padEnd(24)} ${field.type}${field.nullable ? " (nullable)" : ""}`);
          }
          for (const warning of inspection.warnings ?? []) io.out(`  ! ${warning}`);
          return EXIT_CODES.OK;
        }

        const manifests = bridge.listFormats();
        if (json) {
          io.out(JSON.stringify(manifests, null, 2));
          return EXIT_CODES.OK;
        }
        io.out("Registered format adapters:");
        io.out(
          formatTable(
            ["FORMAT", "VERSION", "STATUS", "PARSE", "TO FHIR", "VALIDATE"],
            manifests.map((m) => [
              m.format,
              m.version,
              m.status ?? "n/a",
              m.capabilities.parseStructured ? "yes" : "metadata",
              m.capabilities.transformToFHIR ? "yes" : "no",
              String(m.capabilities.validateFormat),
            ]),
          ),
        );
        io.out("");
        io.out("Adapters not implemented yet are documented in ROADMAP.md — never listed here.");
        return EXIT_CODES.OK;
      }

      case "inspect": {
        const delimiter = resolveDelimiterFlag(flags["delimiter"]);
        if (!delimiter.ok) {
          io.err(delimiter.message);
          return EXIT_CODES.INPUT_INVALID;
        }
        const encoding = resolveEncodingFlag(flags["encoding"]);
        if (!encoding.ok) {
          io.err(encoding.message);
          return EXIT_CODES.INPUT_INVALID;
        }
        const filePath = requireFile(command[1], io, "Input file");
        if (!filePath) return EXIT_CODES.INPUT_INVALID;
        const inspectInput = buildFileInput(filePath, encoding.value, io);
        if (!inspectInput) return EXIT_CODES.INPUT_INVALID;
        const activeBridge = delimiter.value ? bridgeWithCsvDelimiterOverride(bridge, delimiter.value) : bridge;
        const inspection = await activeBridge.inspect(inspectInput, {
          adapterId: flagString(flags, "adapter"),
          maxRecords: flagString(flags, "max-records") ? Number(flagString(flags, "max-records")) : undefined,
        });
        if (json) {
          io.out(JSON.stringify(inspection, null, 2));
          return EXIT_CODES.OK;
        }
        io.out(`Format:       ${inspection.format} ${inspection.formatVersion ?? ""} (${inspection.status ?? "n/a"})`);
        io.out(`Domain:       ${inspection.domain}`);
        io.out(`Records:      ${inspection.recordCount ?? "unknown"}`);
        if (inspection.detectedSchema) {
          io.out("Schema:");
          io.out(
            formatTable(
              ["FIELD", "TYPE", "NULLABLE", "SAMPLE"],
              inspection.detectedSchema.fields.map((f) => [
                f.name,
                f.type,
                f.nullable ? "yes" : "no",
                (f.sampleValues ?? []).slice(0, 2).map(String).join(", "),
              ]),
            ),
          );
        }
        for (const warning of inspection.warnings ?? []) io.out(`warning: ${warning}`);
        return EXIT_CODES.OK;
      }

      case "transform": {
        const delimiter = resolveDelimiterFlag(flags["delimiter"]);
        if (!delimiter.ok) {
          io.err(delimiter.message);
          return EXIT_CODES.INPUT_INVALID;
        }
        const encoding = resolveEncodingFlag(flags["encoding"]);
        if (!encoding.ok) {
          io.err(encoding.message);
          return EXIT_CODES.INPUT_INVALID;
        }

        const mappingPath = flagString(flags, "mapping");
        const mapping = mappingPath ? loadMapping(mappingPath, io) : DEFAULT_PATIENT_MAPPING;
        if (!mapping) return EXIT_CODES.USAGE;

        const inputArg = command[1];
        if (!inputArg) {
          io.err("Error: Input file path is required (use - for stdin)");
          return EXIT_CODES.INPUT_INVALID;
        }
        const input = await buildTransformInput(inputArg, flags, encoding.value, io);
        if (!input) return EXIT_CODES.INPUT_INVALID;

        const activeBridge = delimiter.value ? bridgeWithCsvDelimiterOverride(bridge, delimiter.value) : bridge;
        const result = await activeBridge.transform({
          input,
          mapping,
          adapterId: flagString(flags, "adapter"),
          maxRecords: flagString(flags, "max-records") ? Number(flagString(flags, "max-records")) : undefined,
          importedAt: flagString(flags, "imported-at"),
        });

        const bundlePath = flagString(flags, "run-bundle");
        if (bundlePath) {
          const bundle = activeBridge.createRunBundle(result.runId);
          fs.writeFileSync(path.resolve(bundlePath), JSON.stringify(bundle, null, 2) + "\n", "utf-8");
          if (!json) io.err(`Run bundle: ${bundlePath} (input ${bundle.input.checksum ?? "unhashed"})`);
        }

        const outPath = flagString(flags, "out");
        const format = flagString(flags, "format") ?? "json";
        const rendered =
          format === "ndjson"
            ? result.output.map((record) => JSON.stringify(record)).join("\n")
            : JSON.stringify(outPath ? result.output : result, null, 2);

        if (outPath) {
          fs.writeFileSync(outPath, rendered, "utf-8");
          if (!json) io.out(`Wrote ${result.output.length} record(s) to ${outPath} (${format})`);
        } else if (!json && format !== "ndjson") {
          io.out(rendered);
        } else {
          io.out(rendered);
        }

        if (!json) {
          io.err(
            [
              `status=${result.status}`,
              `records=${result.recordsSucceeded}/${result.recordsProcessed} succeeded`,
              `coverage=${result.coverage.coveragePercentage}%`,
              `unmapped=${result.coverage.unmappedSourceFields.length}`,
              `rejected=${result.rejectedRecords.length}`,
              `valid=${result.validation?.isValid}`,
              `run=${result.runId}`,
            ].join(" "),
          );
        }

        const failOn = flagString(flags, "fail-on");
        if (result.status === "failed") return EXIT_CODES.ADAPTER_ERROR;
        if (failOn === "warning" && result.status === "completed_with_warnings") return EXIT_CODES.VALIDATION_FAILED;
        return EXIT_CODES.OK;
      }

      case "validate": {
        const filePath = requireFile(command[1], io, "Resource file");
        if (!filePath) return EXIT_CODES.INPUT_INVALID;
        const standard = flagString(flags, "standard") ?? "fhir-r4";
        if (standard !== "fhir-r4") {
          io.err(`Error: unsupported standard '${standard}'. Supported: fhir-r4`);
          return EXIT_CODES.USAGE;
        }
        let resource: Record<string, unknown>;
        try {
          resource = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        } catch (error) {
          io.err(`Error: could not parse '${filePath}': ${(error as Error).message}`);
          return EXIT_CODES.INPUT_INVALID;
        }

        const validation = bridge.validateFhir(resource);
        if (json) {
          io.out(JSON.stringify(validation, null, 2));
        } else {
          io.out(`${validation.isValid ? "VALID" : "INVALID"} — ${resource.resourceType ?? "unknown resource"}`);
          for (const issue of validation.issues) {
            io.out(`  [${issue.severity}] ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
          }
          io.out("Levels executed: structural. Not executed: profile, terminology, referential integrity.");
        }
        return validation.isValid ? EXIT_CODES.OK : EXIT_CODES.VALIDATION_FAILED;
      }

      case "reproduce": {
        const bundlePath = requireFile(command[1], io, "Run bundle");
        if (!bundlePath) return EXIT_CODES.INPUT_INVALID;

        let bundle: RunBundle;
        try {
          bundle = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as RunBundle;
        } catch (error) {
          io.err(`Error: could not parse run bundle '${bundlePath}': ${(error as Error).message}`);
          return EXIT_CODES.INPUT_INVALID;
        }
        if (bundle.bundleVersion !== "1") {
          io.err(`Error: unsupported run bundle version '${String(bundle.bundleVersion)}' (expected '1')`);
          return EXIT_CODES.USAGE;
        }

        const explicitInput = flagString(flags, "input");
        const inputPath = explicitInput
          ? explicitInput
          : bundle.input.filename
            ? path.join(path.dirname(path.resolve(bundlePath)), bundle.input.filename)
            : undefined;
        if (!inputPath || !fs.existsSync(inputPath)) {
          io.err(
            `Error: input payload not found${inputPath ? ` at '${inputPath}'` : ""}. ` +
              "Run bundles never embed patient data — pass --input <file>.",
          );
          return EXIT_CODES.INPUT_INVALID;
        }

        const outcome = await bridge.reproduce(bundle, inputPath);
        const inputMatches =
          bundle.input.checksum === undefined || bundle.input.checksum === outcome.result.inputChecksum;

        if (json) {
          io.out(
            JSON.stringify(
              {
                originalRunId: bundle.runId,
                replayedRunId: outcome.result.runId,
                matches: outcome.matches,
                inputChecksumMatches: inputMatches,
                expectedChecksum: outcome.expectedChecksum,
                actualChecksum: outcome.actualChecksum,
                status: outcome.result.status,
              },
              null,
              2,
            ),
          );
        } else {
          io.out(`Original run:    ${bundle.runId} (engine ${bundle.engineVersion}, bundle v${bundle.bundleVersion})`);
          io.out(`Replayed run:    ${outcome.result.runId}`);
          io.out(`Input checksum:  ${inputMatches ? "match" : "MISMATCH"}`);
          io.out(`Expected output: ${outcome.expectedChecksum ?? "(not recorded)"}`);
          io.out(
            `Actual output:   ${outcome.actualChecksum ?? "(none)"} ${outcome.matches ? "[match]" : "[MISMATCH]"}`,
          );
          io.out(
            outcome.matches
              ? "Reproduced: output is byte-identical to the recorded run."
              : "NOT reproduced: output differs. See docs/troubleshooting.md#non-reproducible-runs.",
          );
        }

        if (!inputMatches) return EXIT_CODES.INPUT_INVALID;
        return outcome.matches ? EXIT_CODES.OK : EXIT_CODES.VALIDATION_FAILED;
      }

      case "trace": {
        const filePath = requireFile(command[2] ?? command[1], io, "Trace file");
        if (!filePath) return EXIT_CODES.INPUT_INVALID;
        const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const traces = Array.isArray(payload) ? payload : (payload.events ?? payload.traces ?? []);
        if (json) {
          io.out(JSON.stringify(exportTraceReport(traces), null, 2));
          return EXIT_CODES.OK;
        }
        io.out(
          formatTable(
            ["#", "STAGE", "STEP", "STATUS", "REC", "MS"],
            traces.map((trace: Record<string, unknown>, index: number) => [
              String(index + 1),
              String(trace.stage ?? "-"),
              String(trace.stepName ?? "-"),
              String(trace.status ?? "-"),
              String(trace.recordIndex ?? "-"),
              String(trace.durationMs ?? "-"),
            ]),
          ),
        );
        return EXIT_CODES.OK;
      }

      case "init": {
        const target = flagString(flags, "dir") ?? process.cwd();
        const configPath = path.join(target, "healthbridge.config.json");
        const mappingDir = path.join(target, "mappings");
        if (fs.existsSync(configPath) && !flagBool(flags, "force")) {
          io.err(`Error: ${configPath} already exists (use --force to overwrite)`);
          return EXIT_CODES.USAGE;
        }
        fs.mkdirSync(mappingDir, { recursive: true });
        fs.writeFileSync(
          configPath,
          JSON.stringify(
            {
              engineVersion: ENGINE_VERSION,
              defaultAdapter: "csv-adapter",
              defaultMapping: "mappings/patient.json",
              debug: { enabled: true, payloadMode: "redacted" },
              telemetry: false,
            },
            null,
            2,
          ),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(mappingDir, "patient.json"),
          JSON.stringify(DEFAULT_PATIENT_MAPPING, null, 2),
          "utf-8",
        );
        io.out(`Initialised HealthBridge project in ${target}`);
        io.out("  healthbridge.config.json");
        io.out("  mappings/patient.json");
        return EXIT_CODES.OK;
      }

      case "demo": {
        if (secondary !== "generate") {
          io.err(
            "Usage: healthbridge demo generate --profile broken-dates [--seed 42] [--records 25] [--out file.csv]",
          );
          return EXIT_CODES.USAGE;
        }
        const profile = flagString(flags, "profile") ?? "broken-dates";
        if (profile !== "broken-dates") {
          io.err(`Error: unknown demo profile '${profile}'. Available: broken-dates`);
          return EXIT_CODES.USAGE;
        }
        const seed = Number(flagString(flags, "seed") ?? 42);
        const records = Number(flagString(flags, "records") ?? 25);
        const content = generateBrokenDates(records, seed);
        const outPath = flagString(flags, "out");
        if (outPath) {
          fs.writeFileSync(outPath, content, "utf-8");
          io.out(`Wrote ${records} synthetic record(s) (profile=${profile}, seed=${seed}) to ${outPath}`);
        } else {
          io.out(content);
        }
        return EXIT_CODES.OK;
      }

      case "plugins": {
        const manifests = bridge.listFormats();
        if (json) {
          io.out(JSON.stringify(manifests, null, 2));
          return EXIT_CODES.OK;
        }
        io.out("Built-in adapters:");
        for (const manifest of manifests) io.out(`  ${manifest.format} v${manifest.version} — ${manifest.description}`);
        io.out("");
        io.out("Third-party adapters are privileged code. Install only from trusted sources.");
        return EXIT_CODES.OK;
      }

      case "examples": {
        const dirs = ["examples", "datasets"].filter((dir) => fs.existsSync(dir));
        if (dirs.length === 0) {
          io.out("No examples directory found in the current working directory.");
          return EXIT_CODES.OK;
        }
        for (const dir of dirs) {
          io.out(`${dir}/`);
          for (const entry of fs.readdirSync(dir)) io.out(`  ${entry}`);
        }
        return EXIT_CODES.OK;
      }

      case "completions": {
        const script = command[1] ? renderCompletion(command[1]) : undefined;
        if (!script) {
          io.err(`Error: unsupported shell '${command[1] ?? "(missing)"}'. Usage: healthbridge completions <bash|zsh>`);
          return EXIT_CODES.USAGE;
        }
        io.out(script);
        return EXIT_CODES.OK;
      }

      case undefined:
      case "help": {
        io.out(HELP_TEXT);
        return primary === "help" ? EXIT_CODES.OK : EXIT_CODES.USAGE;
      }

      default:
        io.err(`Unknown command '${primary}'. Run 'healthbridge help'.`);
        return EXIT_CODES.USAGE;
    }
  } catch (error) {
    if (error instanceof HealthBridgeError) {
      io.err(`Error [${error.code}]: ${error.message}`);
      if (error.code === "INPUT_NOT_FOUND" || error.code === "INPUT_NOT_A_FILE") return EXIT_CODES.INPUT_INVALID;
      if (error.category === "adapter") return EXIT_CODES.ADAPTER_ERROR;
      if (error.category === "usage") return EXIT_CODES.USAGE;
      return EXIT_CODES.INTERNAL;
    }
    io.err(`Internal error: ${(error as Error).message}`);
    return EXIT_CODES.INTERNAL;
  }
}

const HELP_TEXT = `HealthBridge OS CLI ${ENGINE_VERSION}

Usage: healthbridge <command> [options]

Commands:
  doctor                         Probe the environment, adapters and a self-test
  init [--dir <path>]            Scaffold a project (config + starter mapping)
  formats list                   List registered adapters and capabilities
  formats inspect <file>         Show detection candidates and schema
  inspect <file>                 Inspect a medical dataset
  transform <file|->            Transform a dataset (default: FHIR R4 Patient; - reads stdin)
  validate <file>                Validate a FHIR R4 resource
  trace show <file>              Render a trace report
  demo generate                  Generate deterministic synthetic data
  plugins list                   List adapters (built-in + installed)
  examples list                  List bundled examples and datasets
  completions <bash|zsh>          Print a static shell completion script

Run 'healthbridge <command> --help' for per-command help
(transform, inspect, validate, formats, doctor, trace, reproduce, demo).

Common options:
  --mapping <file.json|yaml>     Mapping definition (default: built-in patient mapping)
  --adapter <id>                 Force a specific adapter
  --max-records <n>              Limit processed records
  --delimiter <d>                Override CSV delimiter: comma, semicolon, tab, pipe
                                 (auto-detection is the default; transform/inspect only)
  --encoding <enc>               Override input encoding: utf-8, utf-16le, windows-1252
                                 (auto-detection is the default; transform/inspect only)
  --out <file>                   Write output to a file
  --format json|ndjson           Output format (default: json)
  --fail-on warning              Exit non-zero on warnings
  --json                         Machine-readable output
  --standard fhir-r4             Standard for 'validate'

Exit codes:
  0 success · 1 usage · 2 invalid input · 3 validation failed
  4 adapter error · 5 internal error · 6 cancelled
`;
