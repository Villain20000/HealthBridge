#!/usr/bin/env node
import { runCli, EXIT_CODES } from "./index.js";

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("CLI execution error:", error instanceof Error ? error.message : error);
    process.exitCode = EXIT_CODES.INTERNAL;
  });
