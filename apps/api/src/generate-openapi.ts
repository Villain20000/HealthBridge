import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpenApiDocument, serializeOpenApiDocument } from "./openapi.js";

/**
 * Writes `docs/openapi.json` from the controllers (run from the repo root):
 *
 *   npx tsx apps/api/src/generate-openapi.ts          # regenerate
 *   npx tsx apps/api/src/generate-openapi.ts --check  # fail on drift (CI)
 *
 * The file is committed; CI diffs it against a fresh generation.
 */

const OUTPUT = resolve(process.cwd(), "docs/openapi.json");

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const generated = serializeOpenApiDocument(buildOpenApiDocument());

  if (checkOnly) {
    let committed: string;
    try {
      committed = readFileSync(OUTPUT, "utf-8");
    } catch {
      console.error(`OpenAPI drift: ${OUTPUT} does not exist. Run generate-openapi.ts to create it.`);
      process.exit(1);
    }
    if (committed !== generated) {
      console.error(
        `OpenAPI drift: ${OUTPUT} differs from a fresh generation. ` +
          `Run \`npx tsx apps/api/src/generate-openapi.ts\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log("OpenAPI document is current.");
    return;
  }

  writeFileSync(OUTPUT, generated);
  console.log(`Wrote ${OUTPUT}.`);
}

main();
