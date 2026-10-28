import { HealthBridge } from "@healthbridge/sdk";
import * as fs from "fs";
import * as path from "path";

async function runExample() {
  const bridge = new HealthBridge();
  const csvPath = path.join(__dirname, "../../datasets/synthetic-patients.csv");
  const mappingPath = path.join(__dirname, "./patient-mapping.json");

  const contentString = fs.readFileSync(csvPath, "utf-8");
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));

  console.log("Running HealthBridge SDK Transformation Example...");
  const result = await bridge.transform({
    input: { id: "ex-1", filename: "synthetic-patients.csv", contentString },
    mapping,
  });

  console.log("Status:", result.status);
  console.log("Transformed Output (FHIR R4 Patient Resources):");
  console.log(JSON.stringify(result.output, null, 2));
}

runExample().catch(console.error);
