import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { HealthBridge, PROVENANCE_EXTENSION_URL, TransformationResult, MappingDefinition } from "@healthbridge/sdk";

/**
 * Shared harness for the synthetic scenario lab.
 *
 * Every scenario runs through the same public SDK entry point the CLI uses, with
 * a fixed import timestamp so output is byte-reproducible. Expectations are
 * compared against a clinical projection (provenance extensions and `meta` are
 * asserted separately), so a provenance format change does not silently weaken
 * the clinical assertions.
 */

export const SCENARIO_IMPORTED_AT = "2024-01-01T00:00:00.000Z";
export const SCENARIOS_ROOT = path.resolve(__dirname);

export interface ScenarioRun {
  result: TransformationResult;
  bridge: HealthBridge;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

export function scenarioPath(scenario: string, ...parts: string[]): string {
  return path.join(SCENARIOS_ROOT, scenario, ...parts);
}

export async function runScenario(scenario: string, dataFile: string, mappingFile: string): Promise<ScenarioRun> {
  const bridge = new HealthBridge();
  const mapping = readJson<MappingDefinition>(scenarioPath(scenario, "mapping", mappingFile));
  const result = await bridge.transform({
    input: scenarioPath(scenario, "data", dataFile),
    mapping,
    importedAt: SCENARIO_IMPORTED_AT,
  });
  return { result, bridge };
}

/** Clinical projection: strip provenance/meta so expectations stay readable. */
export function projection(resource: unknown): unknown {
  if (Array.isArray(resource)) return resource.map(projection);
  if (!resource || typeof resource !== "object") return resource;
  const copy = JSON.parse(JSON.stringify(resource)) as Record<string, unknown>;
  if (Array.isArray(copy.extension)) {
    const kept = (copy.extension as Array<Record<string, unknown>>).filter(
      (ext) => ext.url !== PROVENANCE_EXTENSION_URL,
    );
    if (kept.length > 0) copy.extension = kept;
    else delete copy.extension;
  }
  delete copy.meta;
  return copy;
}

export function issueCodes(result: TransformationResult): string[] {
  const fromCoverage = result.coverage.issues.map((i) => i.code);
  const fromValidation = result.validation.issues.map((i) => i.code);
  const fromRejected = result.rejectedRecords.flatMap((r) => r.issues.map((i) => i.code));
  const fromAdapter = result.dataLoss.adapterNotes.map((note) => note.split(":")[0]);
  return Array.from(new Set([...fromCoverage, ...fromValidation, ...fromRejected, ...fromAdapter])).sort();
}

/** Assert the pipeline actually executed the stages it reports. */
export function assertPipelineStages(result: TransformationResult): void {
  const stages = new Set(result.traces.map((t) => t.stage));
  for (const stage of ["detect", "parse", "mapping", "build", "validate", "export"] as const) {
    assert.ok(stages.has(stage as never), `trace stage '${stage}' missing (got ${Array.from(stages).join(", ")})`);
  }
  assert.ok(
    result.validation.levels.some((l) => l.level === 1 && l.status === "executed"),
    "level 1 validation must be reported as executed",
  );
  assert.ok(result.validation.levels.some((l) => l.level === 3 && l.status === "executed"));
  assert.ok(result.validation.levels.some((l) => l.level === 4 && l.status === "skipped"));
}

/**
 * PHI guard: names, local identifiers and SSN-shaped values must not appear in
 * stored traces. The scenario data is synthetic, so any hit is a redaction bug.
 */
export function assertNoPhiInTraces(result: TransformationResult, forbidden: string[]): void {
  const serialised = JSON.stringify(result.traces);
  for (const value of forbidden) {
    assert.ok(!serialised.includes(value), `trace leaked sensitive value '${value}'`);
  }
  assert.ok(
    result.traces.every((t) => t.redacted === true),
    "traces must be marked redacted",
  );
}
