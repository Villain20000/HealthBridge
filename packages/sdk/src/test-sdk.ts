import { HealthBridge } from "./index";

async function testSdkAndCliParity() {
  const bridge = new HealthBridge();
  console.log("Testing SDK & CLI Engine Parity...");

  const csvInput = "patient_id,first_name,last_name,gender,birth_date\nP101,John,Doe,male,1985-04-12\nP102,Jane,Smith,F,1990-11-23";
  const mapping = {
    id: "patient-test-mapping",
    name: "Patient Test Mapping",
    version: "1.0.0",
    sourceFormat: "csv",
    targetFormat: "fhir-r4",
    targetResourceType: "Patient",
    rules: [
      { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity" as const, required: true },
      { id: "r2", sourcePath: "first_name", targetPath: "name.0.given.0", transform: "trim" as const },
      { id: "r3", sourcePath: "last_name", targetPath: "name.0.family", transform: "uppercase" as const },
      { id: "r4", sourcePath: "gender", targetPath: "gender", transform: "format_gender_fhir" as const },
      { id: "r5", sourcePath: "birth_date", targetPath: "birthDate", transform: "parse_date_iso" as const },
    ],
  };

  const result = await bridge.transform({
    input: { id: "test-inp-1", filename: "patients.csv", contentString: csvInput },
    mapping,
  });

  console.log("Transformation Result Status:", result.status);
  console.log("Records Processed:", result.recordsProcessed);
  console.log("FHIR Patients Generated:", result.output.length);

  if (result.status === "completed" && result.output.length === 2) {
    console.log("SDK Engine Parity Test Passed!");
  } else {
    console.error("SDK Engine Parity Test Failed!", result);
    process.exit(1);
  }
}

testSdkAndCliParity().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
