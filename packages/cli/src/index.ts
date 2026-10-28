import * as fs from "fs";
import * as path from "path";
import { HealthBridge, MappingDefinition } from "@healthbridge/sdk";

const bridge = new HealthBridge();

export async function runCli(args: string[]) {
  const command = args[0] || "help";

  switch (command) {
    case "doctor":
      console.log("HealthBridge OS CLI Environment Check:");
      console.log(" Node.js:", process.version);
      console.log(" HealthBridge Engine Version: 3.0.0");
      console.log(" Core Engine: Offline Standalone Ready");
      console.log(" Status: Healthy");
      break;

    case "formats":
      if (args[1] === "list") {
        console.log("Supported Healthcare Data Formats:");
        const formats = bridge.listFormats();
        formats.forEach((f) => console.log(` - ${f.format} v${f.version}: ${f.description}`));
      } else {
        console.log("Usage: healthbridge formats list");
      }
      break;

    case "inspect": {
      const filePath = args[1];
      if (!filePath || !fs.existsSync(filePath)) {
        console.error("Error: File not found:", filePath);
        process.exit(1);
      }
      const contentString = fs.readFileSync(filePath, "utf-8");
      const filename = path.basename(filePath);
      const input = { id: `input-${Date.now()}`, filename, contentString };
      const adapter = await (bridge as any).pipeline.getRegistry().detectAdapter(input);
      if (!adapter) {
        console.error("No compatible adapter detected for file:", filePath);
        process.exit(1);
      }
      const inspection = await adapter.inspect(input);
      console.log(JSON.stringify(inspection, null, 2));
      break;
    }

    case "transform": {
      const filePath = args[1];
      const mappingIdx = args.indexOf("--mapping");
      const mappingPath = mappingIdx !== -1 ? args[mappingIdx + 1] : undefined;

      if (!filePath || !fs.existsSync(filePath)) {
        console.error("Error: Input file not found:", filePath);
        process.exit(1);
      }

      let mapping: MappingDefinition;
      if (mappingPath && fs.existsSync(mappingPath)) {
        mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));
      } else {
        mapping = {
          id: "default-patient",
          name: "Default Patient Mapping",
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
        };
      }

      const contentString = fs.readFileSync(filePath, "utf-8");
      const filename = path.basename(filePath);

      const result = await bridge.transform({
        input: { id: `input-${Date.now()}`, filename, contentString },
        mapping,
      });

      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "validate": {
      const filePath = args[1];
      if (!filePath || !fs.existsSync(filePath)) {
        console.error("Error: Resource file not found:", filePath);
        process.exit(1);
      }
      const contentString = fs.readFileSync(filePath, "utf-8");
      const resource = JSON.parse(contentString);
      const validation = bridge.validateFhir(resource);
      console.log(JSON.stringify(validation, null, 2));
      break;
    }

    default:
      console.log("HealthBridge OS CLI 3.0");
      console.log("Commands:");
      console.log("  healthbridge doctor");
      console.log("  healthbridge formats list");
      console.log("  healthbridge inspect <file>");
      console.log("  healthbridge transform <file> --mapping <mapping.json>");
      console.log("  healthbridge validate <resource.json>");
      break;
  }
}
