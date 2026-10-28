#!/usr/bin/env node
import { runCli } from "./index.js";

runCli(process.argv.slice(2)).catch((err) => {
  console.error("CLI Execution Error:", err);
  process.exit(1);
});
