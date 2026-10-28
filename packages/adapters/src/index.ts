import { CapabilityManifest, InputDescriptor, InspectionResult, MedicalDataEnvelope, ParseContext } from "@healthbridge/shared-types";
import { MedicalFormatAdapter, createCanonicalEnvelope } from "@healthbridge/core";

export class CsvFormatAdapter implements MedicalFormatAdapter {
  public id = "csv-adapter";
  public version = "1.0.0";

  public getManifest(): CapabilityManifest {
    return {
      format: "csv",
      version: "1.0.0",
      description: "Comma-Separated Values Medical Dataset Adapter",
      extensions: [".csv", ".txt"],
      mimeTypes: ["text/csv", "application/csv"],
      capabilities: { register: true, parseMetadata: true, parseStructured: true, preview: true, transformMetadataToFHIR: false, transformToFHIR: true, validateFormat: true, exportOriginal: true },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    if (input.filename?.endsWith(".csv") || input.mimeType === "text/csv") return true;
    if (input.contentString) {
      const lines = input.contentString.trim().split("\n");
      if (lines.length > 0 && lines[0].includes(",")) return true;
    }
    return false;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const text = input.contentString || input.buffer?.toString("utf-8") || "";
    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return { format: "csv", domain: "unknown", recordCount: 0, capabilities: this.getManifest().capabilities, warnings: ["Empty CSV file"] };

    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const records: Array<Record<string, unknown>> = [];
    for (let i = 1; i < Math.min(lines.length, 6); i++) {
      const values = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      const record: Record<string, unknown> = {};
      headers.forEach((h, idx) => { record[h] = values[idx] ?? ""; });
      records.push(record);
    }

    let domain: InspectionResult["domain"] = "clinical";
    const headerStr = headers.join(" ").toLowerCase();
    if (headerStr.includes("loinc") || headerStr.includes("lab") || headerStr.includes("specimen") || headerStr.includes("observation")) {
      domain = "laboratory";
    }

    return {
      format: "csv",
      domain,
      recordCount: lines.length - 1,
      detectedSchema: { fields: headers.map((name) => ({ name, type: "string", sampleValues: records.map((r) => r[name]), nullable: true })) },
      sampleRecords: records,
      capabilities: this.getManifest().capabilities,
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const text = input.contentString || input.buffer?.toString("utf-8") || "";
    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return;

    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    for (let i = 1; i < lines.length; i++) {
      if (context.maxRecords && i > context.maxRecords) break;
      const values = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      const data: Record<string, unknown> = {};
      headers.forEach((h, idx) => { data[h] = values[idx] ?? ""; });

      const envelope = createCanonicalEnvelope(
        `csv-rec-${i}`,
        headers.some((h) => h.toLowerCase().includes("lab") || h.toLowerCase().includes("loinc")) ? "laboratory" : "clinical",
        "csv",
        { kind: "structured", data },
        this.id,
        this.version,
        i - 1
      );
      yield envelope;
    }
  }
}

export class JsonFormatAdapter implements MedicalFormatAdapter {
  public id = "json-adapter";
  public version = "1.0.0";

  public getManifest(): CapabilityManifest {
    return {
      format: "json",
      version: "1.0.0",
      description: "Structured JSON Medical Asset Adapter",
      extensions: [".json"],
      mimeTypes: ["application/json"],
      capabilities: { register: true, parseMetadata: true, parseStructured: true, preview: true, transformMetadataToFHIR: true, transformToFHIR: true, validateFormat: true, exportOriginal: true },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    if (input.filename?.endsWith(".json") || input.mimeType === "application/json") return true;
    if (input.contentString) {
      const trimmed = input.contentString.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
    }
    return false;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const text = input.contentString || input.buffer?.toString("utf-8") || "{}";
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { format: "json", domain: "unknown", recordCount: 0, capabilities: this.getManifest().capabilities, warnings: ["Malformed JSON content"] }; }
    const isArray = Array.isArray(parsed);
    const records = isArray ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
    return { format: "json", domain: "clinical", recordCount: records.length, sampleRecords: records.slice(0, 5), capabilities: this.getManifest().capabilities };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const text = input.contentString || input.buffer?.toString("utf-8") || "{}";
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (let i = 0; i < records.length; i++) {
      if (context.maxRecords && i >= context.maxRecords) break;
      const rec = records[i] as Record<string, unknown>;
      const envelope = createCanonicalEnvelope(rec.id ? String(rec.id) : `json-rec-${i}`, "clinical", "json", { kind: "structured", data: rec }, this.id, this.version, i);
      yield envelope;
    }
  }
}

export class FhirJsonFormatAdapter implements MedicalFormatAdapter {
  public id = "fhir-r4-json-adapter";
  public version = "1.0.0";

  public getManifest(): CapabilityManifest {
    return {
      format: "fhir-r4-json",
      version: "4.0.1",
      description: "HL7 FHIR R4 JSON & NDJSON Resource Adapter",
      extensions: [".json", ".ndjson", ".fhir"],
      mimeTypes: ["application/fhir+json", "application/x-ndjson"],
      capabilities: { register: true, parseMetadata: true, parseStructured: true, preview: true, transformMetadataToFHIR: true, transformToFHIR: true, validateFormat: true, exportOriginal: true },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    if (input.filename?.endsWith(".fhir") || input.filename?.endsWith(".ndjson")) return true;
    if (input.contentString && input.contentString.includes('"resourceType"')) return true;
    return false;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const text = input.contentString || input.buffer?.toString("utf-8") || "";
    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    let records: Record<string, unknown>[] = [];
    if (lines.length > 0 && lines[0].includes('"resourceType"')) {
      records = lines.slice(0, 5).map((l) => JSON.parse(l));
    } else {
      try {
        const parsed = JSON.parse(text);
        if (parsed.resourceType === "Bundle" && Array.isArray(parsed.entry)) {
          records = parsed.entry.map((e: any) => e.resource).filter(Boolean);
        } else if (parsed.resourceType) {
          records = [parsed];
        }
      } catch {}
    }
    return { format: "fhir-r4-json", formatVersion: "4.0.1", domain: "clinical", recordCount: records.length, sampleRecords: records, capabilities: this.getManifest().capabilities };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const text = input.contentString || input.buffer?.toString("utf-8") || "";
    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    let index = 0;
    for (const line of lines) {
      if (context.maxRecords && index >= context.maxRecords) break;
      try {
        const parsed = JSON.parse(line);
        if (parsed.resourceType) {
          const envelope = createCanonicalEnvelope(parsed.id || `fhir-${index}`, "clinical", "fhir-r4-json", { kind: "structured", data: parsed }, this.id, this.version, index);
          yield envelope;
          index++;
        }
      } catch {}
    }
  }
}
