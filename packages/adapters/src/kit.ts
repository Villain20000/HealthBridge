import type { CapabilityStatus, InputDescriptor, MedicalDataEnvelope } from "@healthbridge/shared-types";
import type { MedicalFormatAdapter } from "@healthbridge/core";

export const ALLOWED_ADAPTER_STATUSES: readonly CapabilityStatus[] = [
  "supported",
  "partial",
  "metadata-only",
  "adapter-required",
  "planned",
  "unsupported",
];

export class UnsafeXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeXmlError";
  }
}

/**
 * Prerequisite for every XML-based adapter (generic XML, CDA): entity expansion
 * and external entities are refused before any XML parser runs, so a malicious
 * `<!ENTITY>` payload can never reach the parser. XXE is a P0 security gate.
 */
export function assertSafeXml(text: string): void {
  const head = text.slice(0, 4096);
  if (/<!DOCTYPE/i.test(head) || /<!ENTITY/i.test(text.slice(0, 65536))) {
    throw new UnsafeXmlError("XML with DOCTYPE or ENTITY declarations is refused (XXE guard)");
  }
  if (/<!\[CDATA\[/.test(text) && text.length > 1024 * 1024) {
    throw new UnsafeXmlError("Oversized CDATA section refused");
  }
}

/**
 * Shared contract every adapter must satisfy before it can be listed as
 * anything stronger than `planned`. Returns failure messages; empty means pass.
 */
export async function runAdapterConformance(adapter: MedicalFormatAdapter): Promise<string[]> {
  const failures: string[] = [];
  const manifest = adapter.getManifest();

  if (!manifest.format) failures.push("manifest.format must be non-empty");
  if (!/^\d+\.\d+\.\d+/.test(adapter.version)) {
    failures.push(`adapter.version '${adapter.version}' must be semver`);
  }
  if (manifest.status === undefined) {
    failures.push("manifest.status must be explicit (never undefined)");
  } else if (!ALLOWED_ADAPTER_STATUSES.includes(manifest.status)) {
    failures.push(`manifest.status '${String(manifest.status)}' is not in the shared vocabulary`);
  }
  if (manifest.status !== "planned" && manifest.capabilities.transformToFHIR === undefined) {
    failures.push("manifest.capabilities.transformToFHIR must be explicit");
  }

  const samples: InputDescriptor[] = [
    { id: "kit-sample-csv", filename: "kit.csv", contentString: "patient_id,first_name\nP1,Jane\n" },
    {
      id: "kit-sample-json",
      filename: "kit.json",
      contentString: JSON.stringify([{ patient_id: "P1", first_name: "Jane" }]),
    },
    {
      id: "kit-sample-fhir",
      filename: "kit.fhir.json",
      contentString: JSON.stringify({ resourceType: "Patient", id: "kit-p1" }),
    },
  ];
  for (const sample of samples) {
    try {
      await adapter.detect(sample);
    } catch (error) {
      failures.push(`detect threw instead of returning false: ${(error as Error).message}`);
    }
  }

  if (manifest.status === "supported" || manifest.status === "partial") {
    let sample: InputDescriptor | undefined;
    for (const candidate of samples) {
      try {
        if (await adapter.detect(candidate)) {
          sample = candidate;
          break;
        }
      } catch {
        continue;
      }
    }
    if (sample) {
      const context = {
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        onIssue: () => undefined,
      };
      try {
        const envelopes: MedicalDataEnvelope[] = [];
        for await (const envelope of adapter.parse(sample, context)) {
          envelopes.push(envelope);
          if (envelopes.length >= 2) break;
        }
        if (envelopes.length === 0) failures.push(`parse produced no envelopes for '${sample.filename}'`);
        for (const envelope of envelopes) {
          if (!envelope.source.checksum) failures.push("envelope is missing its SHA-256 checksum");
        }
      } catch (error) {
        failures.push(`parse threw on a valid sample: ${(error as Error).message}`);
      }
      try {
        const inspection = await adapter.inspect(sample);
        if (!inspection || typeof inspection !== "object") failures.push("inspect did not return a result object");
      } catch (error) {
        failures.push(`inspect threw on a valid sample: ${(error as Error).message}`);
      }
    }
  }

  if (adapter.health) {
    try {
      const result = await adapter.health();
      if (typeof result.ok !== "boolean" || typeof result.details !== "string") {
        failures.push("health() must return { ok: boolean, details: string }");
      }
    } catch (error) {
      failures.push(`health() threw: ${(error as Error).message}`);
    }
  }

  return failures;
}
