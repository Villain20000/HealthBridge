import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoPhiInTraces,
  assertPipelineStages,
  issueCodes,
  projection,
  readJson,
  runScenario,
  scenarioPath,
} from "../harness";

const SCENARIO = "04-international-formats";

describe("Scenario 4 — international healthcare formats", () => {
  test("handles a semicolon-delimited, Windows-1252-era style feed without manual conversion", async () => {
    const { result, bridge } = await runScenario(SCENARIO, "patients-intl.csv", "patient.json");
    const expected = readJson<unknown[]>(scenarioPath(SCENARIO, "expected", "resources.json"));

    const candidates = await bridge.detect(scenarioPath(SCENARIO, "data", "patients-intl.csv"));
    assert.equal(candidates[0]?.adapterId, "csv-adapter");
    assert.ok((candidates[0]?.confidence ?? 0) >= 0.9);

    assert.equal(result.status, "completed");
    assert.deepEqual(projection(result.output), expected);
    assertPipelineStages(result);
  });

  test("parses DD.MM.YYYY dates with an explicit format instead of guessing", async () => {
    const { result } = await runScenario(SCENARIO, "patients-intl.csv", "patient.json");
    const dates = result.output.map((r) => (r as Record<string, unknown>).birthDate);
    assert.deepEqual(dates, ["1990-02-17", "1985-11-03", "1978-06-30"]);
  });

  test("maps local gender codes through explicit aliases", async () => {
    const { result } = await runScenario(SCENARIO, "patients-intl.csv", "patient.json");
    assert.deepEqual(
      result.output.map((r) => (r as Record<string, unknown>).gender),
      ["female", "male", "female"],
    );
    assert.deepEqual(issueCodes(result), [], "no unmapped-code warnings are expected for declared aliases");
  });

  test("preserves multilingual text and decimal-comma numerics", async () => {
    const { result } = await runScenario(SCENARIO, "patients-intl.csv", "patient.json");
    const families = result.output.map((r) => (r as Record<string, any>).name[0].family as string);
    assert.deepEqual(families, ["Müller", "Ñúñez", "李"]);
    const weights = result.output.map(
      (r) =>
        ((r as Record<string, any>).extension ?? []).find((e: any) => e.url.endsWith("source-weight-kg"))?.valueDecimal,
    );
    assert.deepEqual(weights, [72.5, 80.1, 55]);
    assertNoPhiInTraces(result, ["Müller", "Jürgen", "Ñúñez", "李"]);
  });
});
