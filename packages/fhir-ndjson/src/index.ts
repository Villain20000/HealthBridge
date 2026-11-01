import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  ParseContext,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { MedicalFormatAdapter, computeChecksum, createCanonicalEnvelope } from "@healthbridge/core";

/**
 * HL7 FHIR R4 NDJSON (line-delimited JSON) adapter.
 *
 * Split out of `FhirJsonFormatAdapter` (`@healthbridge/adapters`): this adapter
 * owns the NDJSON line-splitting/parsing path (one FHIR resource per line,
 * per-line `MALFORMED_NDJSON_LINE` issues), while `FhirJsonFormatAdapter` keeps
 * single-resource and Bundle JSON. Envelopes keep the `fhir-r4-json` source
 * format so downstream pipeline output is unchanged; only the provenance
 * adapter id differs (`fhir-r4-ndjson-adapter`).
 *
 * Depends only on `@healthbridge/shared-types` and `@healthbridge/core`.
 * Structural adapter only: profiles and terminology are not validated here.
 */

function decodeBuffer(buffer: Buffer): { text: string; encoding: string; warnings: string[] } {
  // Kept in sync with `decodeBuffer` in `@healthbridge/adapters` (csv.ts):
  // this package must not depend on the adapters package, so the decoder is
  // duplicated here. Same branches, same encodings, same warnings.
  const warnings: string[] = [];

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return {
      text: buffer.subarray(3).toString("utf-8"),
      encoding: "utf-8-bom",
      warnings,
    };
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: decodeWith("utf-16le", buffer.subarray(2), warnings), encoding: "utf-16le", warnings };
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeWith("utf-16be", buffer.subarray(2), warnings), encoding: "utf-16be", warnings };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding: "utf-8", warnings };
  } catch {
    warnings.push(
      "File is not valid UTF-8; decoded as windows-1252. Accented or non-Latin characters may need explicit encoding configuration.",
    );
    return {
      text: decodeWith("windows-1252", buffer, warnings),
      encoding: "windows-1252",
      warnings,
    };
  }
}

function decodeWith(encoding: string, buffer: Buffer, warnings: string[]): string {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    warnings.push(`Runtime cannot decode ${encoding}; falling back to utf-8 which may corrupt text.`);
    return buffer.toString("utf-8");
  }
}

function readText(input: InputDescriptor): { text: string; encoding: string; warnings: string[] } {
  if (input.contentString !== undefined) {
    return { text: input.contentString, encoding: "utf-8", warnings: [] };
  }
  if (input.buffer) return decodeBuffer(input.buffer);
  return { text: "", encoding: "utf-8", warnings: ["Input has neither contentString nor buffer"] };
}

function looksLikeNdjson(text: string): boolean {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  return lines.every((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));
}

export class FhirNdjsonFormatAdapter implements MedicalFormatAdapter {
  public id = "fhir-r4-ndjson-adapter";
  public version = "1.1.0";

  public getManifest(): CapabilityManifest {
    return {
      format: "fhir-r4-ndjson",
      version: "4.0.1",
      description: "HL7 FHIR R4 NDJSON (line-delimited JSON) adapter (structural inspection only)",
      extensions: [".ndjson"],
      mimeTypes: ["application/x-ndjson"],
      status: "partial",
      limitations: [
        "Structural adapter only: profiles and terminology are not validated here.",
        "FHIR R5 and STU3 payloads are not declared supported.",
      ],
      capabilities: {
        register: true,
        parseMetadata: true,
        parseStructured: true,
        preview: true,
        transformMetadataToFHIR: true,
        transformToFHIR: true,
        validateFormat: "adapter-required",
        exportOriginal: true,
      },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  public async score(input: InputDescriptor): Promise<number> {
    const name = (input.filename ?? "").toLowerCase();
    if (name.endsWith(".ndjson")) return 0.95;
    const text = input.contentString ?? "";
    if (looksLikeNdjson(text) && text.includes('"resourceType"')) return 0.9;
    return 0;
  }

  private extractResources(text: string): { resources: Array<Record<string, unknown>>; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    const trimmed = text.trim();
    if (trimmed === "") return { resources: [], issues };

    if (looksLikeNdjson(trimmed)) {
      const resources: Array<Record<string, unknown>> = [];
      const lines = trimmed.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.trim() === "") return;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") resources.push(parsed);
        } catch (error) {
          issues.push({
            code: "MALFORMED_NDJSON_LINE",
            severity: "warning",
            message: `NDJSON line ${index + 1} is not valid JSON: ${(error as Error).message}`,
            location: `line ${index + 1}`,
          });
        }
      });
      return { resources, issues };
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.resourceType === "Bundle" && Array.isArray(parsed.entry)) {
        const resources = parsed.entry
          .map((entry: Record<string, unknown>) => entry?.resource)
          .filter((resource: unknown): resource is Record<string, unknown> => Boolean(resource));
        if (resources.length !== parsed.entry.length) {
          issues.push({
            code: "BUNDLE_ENTRY_WITHOUT_RESOURCE",
            severity: "warning",
            message: "Some Bundle entries have no `resource` and were skipped",
          });
        }
        return { resources, issues };
      }
      if (parsed?.resourceType) return { resources: [parsed], issues };
      issues.push({
        code: "NOT_A_FHIR_RESOURCE",
        severity: "warning",
        message: "JSON payload has no `resourceType`; treat as generic JSON",
      });
      return { resources: [], issues };
    } catch (error) {
      issues.push({
        code: "MALFORMED_JSON",
        severity: "fatal",
        message: `Input is not valid FHIR JSON: ${(error as Error).message}`,
      });
      return { resources: [], issues };
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding } = readText(input);
    const { resources, issues } = this.extractResources(text);
    const typeCounts: Record<string, number> = {};
    for (const resource of resources) {
      const type = String(resource.resourceType ?? "unknown");
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }

    return {
      format: "fhir-r4-ndjson",
      formatVersion: "4.0.1",
      domain: "clinical",
      recordCount: resources.length,
      sampleRecords: resources.slice(0, 5),
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        `Encoding: ${encoding}`,
        ...Object.entries(typeCounts).map(([type, count]) => `${type}: ${count}`),
        ...issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding } = readText(input);
    const { resources, issues } = this.extractResources(text);
    const checksum = computeChecksum(input);

    for (const issue of issues) context.onIssue?.(issue);

    const limit = context.maxRecords ?? resources.length;
    for (let index = 0; index < Math.min(resources.length, limit); index++) {
      const resource = resources[index];
      yield createCanonicalEnvelope({
        id: typeof resource.id === "string" ? resource.id : `fhir-${index}`,
        domain: "clinical",
        sourceFormat: "fhir-r4-json",
        formatVersion: "4.0.1",
        content: { kind: "structured", data: resource },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: index,
        sourceLocation: `$[${index}]`,
        filename: input.filename,
        checksum,
        encoding,
        metadata: { resourceType: resource.resourceType },
      });
    }
  }
}
