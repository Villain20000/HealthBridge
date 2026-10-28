import { Controller, Get, Post, Body, Param, NotFoundException } from "@nestjs/common";
import { HealthBridge, MappingDefinition } from "@healthbridge/sdk";

const bridge = new HealthBridge();

const assetsStore = new Map<string, any>();
const mappingsStore = new Map<string, MappingDefinition>();
const runsStore = new Map<string, any>();

mappingsStore.set("patient-csv-to-fhir", {
  id: "patient-csv-to-fhir",
  name: "CSV Patient to FHIR R4 Patient",
  version: "1.0.0",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  targetResourceType: "Patient",
  rules: [
    { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true },
    { id: "r2", sourcePath: "first_name", targetPath: "name.0.given.0", transform: "trim" },
    { id: "r3", sourcePath: "last_name", targetPath: "name.0.family", transform: "uppercase" },
    { id: "r4", sourcePath: "gender", targetPath: "gender", transform: "format_gender_fhir" },
    { id: "r5", sourcePath: "birth_date", targetPath: "birthDate", transform: "parse_date_iso" },
  ],
});

@Controller("api/v1")
export class ApiController {
  @Get("formats")
  getFormats() { return bridge.listFormats(); }

  @Get("stats")
  getStats() {
    return {
      totalAssets: assetsStore.size,
      totalMappings: mappingsStore.size,
      totalRuns: runsStore.size,
      successfulRuns: Array.from(runsStore.values()).filter((r) => r.status === "completed").length,
      failedRuns: Array.from(runsStore.values()).filter((r) => r.status === "failed").length,
      activeJobs: 0,
    };
  }

  @Get("assets")
  listAssets() { return Array.from(assetsStore.values()); }

  @Post("assets")
  createAsset(@Body() body: { filename: string; content: string; domain?: string }) {
    const id = `asset-${Date.now()}`;
    const asset = { id, filename: body.filename, content: body.content, domain: body.domain || "clinical", createdAt: new Date().toISOString(), sizeBytes: Buffer.byteLength(body.content || "") };
    assetsStore.set(id, asset);
    return asset;
  }

  @Get("assets/:id")
  getAsset(@Param("id") id: string) {
    const asset = assetsStore.get(id);
    if (!asset) throw new NotFoundException("Asset not found");
    return asset;
  }

  @Get("mappings")
  listMappings() { return Array.from(mappingsStore.values()); }

  @Post("mappings")
  createMapping(@Body() mapping: MappingDefinition) {
    mappingsStore.set(mapping.id, mapping);
    return mapping;
  }

  @Get("mappings/:id")
  getMapping(@Param("id") id: string) {
    const mapping = mappingsStore.get(id);
    if (!mapping) throw new NotFoundException("Mapping not found");
    return mapping;
  }

  @Post("pipelines/execute")
  async executePipeline(@Body() body: { assetId?: string; content?: string; filename?: string; mappingId: string }) {
    let contentString = body.content;
    let filename = body.filename || "payload.csv";
    if (body.assetId) {
      const asset = assetsStore.get(body.assetId);
      if (asset) { contentString = asset.content; filename = asset.filename; }
    }
    if (!contentString) {
      contentString = "patient_id,first_name,last_name,gender,birth_date\nP201,Alice,Smith,female,1992-08-15";
    }
    const mapping = mappingsStore.get(body.mappingId) || Array.from(mappingsStore.values())[0];
    const result = await bridge.transform({
      input: { id: `input-${Date.now()}`, filename, contentString },
      mapping,
    });
    runsStore.set(result.runId, result);
    return result;
  }

  @Get("runs")
  listRuns() { return Array.from(runsStore.values()); }

  @Get("runs/:id")
  getRun(@Param("id") id: string) {
    const run = runsStore.get(id);
    if (!run) throw new NotFoundException("Run not found");
    return run;
  }

  @Get("runs/:id/trace")
  getRunTrace(@Param("id") id: string) {
    const run = runsStore.get(id);
    if (!run) throw new NotFoundException("Run not found");
    return { runId: run.runId, traces: run.traces };
  }

  @Post("validation/fhir")
  validateFhir(@Body() resource: Record<string, unknown>) { return bridge.validateFhir(resource); }
}
