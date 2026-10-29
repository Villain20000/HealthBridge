import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Seeds the workspace once, after the API and console are up.
 *
 * Playwright runs this before any spec, so tests never race the server's boot or each
 * other's fixtures.
 */
export default async function globalSetup() {
  const script = join(import.meta.dirname, "seed.mjs");
  const output = execFileSync(process.execPath, [script], {
    cwd: join(import.meta.dirname, "..", "..", ".."),
    env: process.env,
    encoding: "utf8",
  });
  process.stdout.write(output);
}
