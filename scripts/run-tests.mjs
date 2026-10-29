import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Test runner.
 *
 * Two things must be true for every suite: path mapping for `@healthbridge/*`
 * (so tests exercise sources, not stale dist output) and decorator support (the
 * API is NestJS). Both live in tsconfig.tsx.json, which tsx only reads when it is
 * told to — hence this wrapper instead of a long, shell-specific one-liner.
 */

const configPath = resolve("tsconfig.tsx.json");
const patterns =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ["packages/*/test/*.test.ts", "scenarios/*/*.test.ts", "apps/*/test/*.test.ts"];

const files = patterns.flatMap((pattern) => globSync(pattern).map((file) => resolve(file)));

if (files.length === 0) {
  console.error("No test files matched:", patterns.join(", "));
  process.exit(1);
}

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, TSX_TSCONFIG_PATH: configPath },
});
child.on("exit", (code) => process.exit(code ?? 1));
