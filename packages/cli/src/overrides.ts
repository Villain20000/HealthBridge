/**
 * CLI input-override helpers (`--delimiter` / `--encoding`).
 *
 * Scope: these helpers live entirely in the CLI package. The engine's CSV
 * adapter already honours a `delimiter` entry in the parse-context options,
 * but the SDK `transform`/`inspect` signatures do not expose it — so the CLI
 * forces the delimiter with a thin same-id adapter wrapper instead of
 * rewriting user bytes. Encoding overrides are applied honestly by decoding
 * the file/stdin bytes to text *before* handing them to the engine (the
 * engine only ever sees the decoded string); auto-detection stays the
 * default whenever the flags are omitted.
 */

import { HealthBridge, type InputDescriptor, type MedicalFormatAdapter, type ParseContext } from "@healthbridge/sdk";

const DELIMITER_ENTRIES: Array<{ names: string[]; value: string }> = [
  { names: [",", "comma"], value: "," },
  { names: [";", "semicolon"], value: ";" },
  { names: ["tab", "\\t", "\t"], value: "\t" },
  { names: ["|", "pipe"], value: "|" },
];

export const DELIMITER_ADVICE =
  "Supported delimiters: ',' (comma), ';' (semicolon), 'tab' (\\t), '|' (pipe). " +
  "Example: healthbridge transform data.csv --delimiter ';'. " +
  "Delimiter auto-detection remains the default when --delimiter is omitted.";

const ENCODING_ENTRIES: Array<{ names: string[]; value: string }> = [
  { names: ["utf-8", "utf8"], value: "utf-8" },
  { names: ["utf-16le", "utf16le"], value: "utf-16le" },
  { names: ["windows-1252", "windows1252", "cp1252"], value: "windows-1252" },
];

export const ENCODING_ADVICE =
  "Supported encodings: utf-8, utf-16le, windows-1252. " +
  "Example: healthbridge transform data.csv --encoding windows-1252. " +
  "Encoding auto-detection (BOM sniffing with a windows-1252 fallback) " +
  "remains the default when --encoding is omitted.";

export type FlagResolution = { ok: true; value?: string } | { ok: false; message: string };

export function parseDelimiterValue(raw: string): FlagResolution {
  const needle = raw.toLowerCase();
  for (const entry of DELIMITER_ENTRIES) {
    if (entry.names.includes(needle)) return { ok: true, value: entry.value };
  }
  return { ok: false, message: `Error: invalid --delimiter '${raw}'. ${DELIMITER_ADVICE}` };
}

export function resolveDelimiterFlag(value: string | boolean | undefined): FlagResolution {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, message: `Error: --delimiter requires a value. ${DELIMITER_ADVICE}` };
  }
  return parseDelimiterValue(value);
}

export function parseEncodingValue(raw: string): FlagResolution {
  const needle = raw.trim().toLowerCase().replace(/_/g, "-");
  for (const entry of ENCODING_ENTRIES) {
    if (entry.names.includes(needle)) return { ok: true, value: entry.value };
  }
  return { ok: false, message: `Error: invalid --encoding '${raw}'. ${ENCODING_ADVICE}` };
}

export function resolveEncodingFlag(value: string | boolean | undefined): FlagResolution {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, message: `Error: --encoding requires a value. ${ENCODING_ADVICE}` };
  }
  return parseEncodingValue(value);
}

/**
 * Decode raw input bytes with an explicit encoding. Throws an `Error` with
 * actionable advice when the bytes are not valid in that encoding. A single
 * leading BOM is stripped so decoded text parses cleanly downstream.
 */
export function decodeBufferWithEncoding(buffer: Buffer, encoding: string): string {
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    throw new Error(
      `Input bytes are not valid ${encoding}. Pass the correct --encoding or omit it to use auto-detection. ${ENCODING_ADVICE}`,
    );
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function displayDelimiter(delimiter: string): string {
  return delimiter === "\t" ? "\\t" : delimiter;
}

/**
 * Wrap an adapter so `parse` runs with a forced CSV delimiter. Identity,
 * version, detection and health all delegate to the wrapped adapter; only
 * the parse-context options gain the override. `inspect` still reports the
 * auto-detected schema (it has no parse context) and appends a note saying
 * the override is active, so nothing it prints is silently re-interpreted.
 */
export function withForcedCsvDelimiter(base: MedicalFormatAdapter, delimiter: string): MedicalFormatAdapter {
  const label = displayDelimiter(delimiter);
  const wrapped: MedicalFormatAdapter = {
    id: base.id,
    version: base.version,
    getManifest: () => base.getManifest(),
    detect: (input: InputDescriptor) => base.detect(input),
    inspect: async (input: InputDescriptor) => {
      const result = await base.inspect(input);
      return {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          `Delimiter override active (--delimiter '${label}'): transform parses with '${label}'; the schema above reflects auto-detection.`,
        ],
      };
    },
    parse: (input: InputDescriptor, context: ParseContext) =>
      base.parse(input, { ...context, options: { ...(context.options ?? {}), delimiter } }),
  };
  if (base.score) {
    const score = base.score.bind(base);
    wrapped.score = (input: InputDescriptor) => score(input);
  }
  if (base.health) {
    const health = base.health.bind(base);
    wrapped.health = () => health();
  }
  return wrapped;
}

/**
 * Return a bridge whose `csv-adapter` parses with the forced delimiter.
 * Every other adapter instance is reused untouched.
 */
export function bridgeWithCsvDelimiterOverride(bridge: HealthBridge, delimiter: string): HealthBridge {
  const adapters = bridge
    .listAdapters()
    .map((adapter) => (adapter.id === "csv-adapter" ? withForcedCsvDelimiter(adapter, delimiter) : adapter));
  return new HealthBridge({ adapters });
}
