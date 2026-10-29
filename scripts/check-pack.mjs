#!/usr/bin/env node
/**
 * Verify that every publishable workspace package would ship a usable tarball.
 *
 * Runs `npm pack --dry-run --json` per workspace (no tarball is written) and
 * requires at least one dist/ file plus package.json, README.md and LICENSE.
 */
import { spawnSync } from "node:child_process";
import { globSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const workspacePatterns = Array.isArray(rootManifest.workspaces)
  ? rootManifest.workspaces
  : (rootManifest.workspaces?.packages ?? []);
const requiredFiles = ["package.json", "README.md", "LICENSE"];

function discoverPackages() {
  const packages = [];
  const seen = new Set();

  for (const pattern of workspacePatterns) {
    for (const match of globSync(pattern, { cwd: root })) {
      const dir = path.resolve(root, match);
      if (!statSync(dir).isDirectory() || seen.has(dir)) continue;

      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      } catch {
        continue; // not a package directory
      }
      if (manifest.private) continue;

      seen.add(dir);
      packages.push({ dir, name: manifest.name });
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function runPack(name) {
  const isWindows = process.platform === "win32";
  // Windows needs a shell to resolve npm; pass one command string so Node does
  // not warn about concatenating args into a shell command.
  const command = isWindows ? `npm pack --dry-run --json --workspace "${name}"` : "npm";
  const args = isWindows ? [] : ["pack", "--dry-run", "--json", "--workspace", name];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: isWindows,
    timeout: 120_000,
  });

  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`npm pack exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }

  const output = (result.stdout ?? "").trim();
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1) {
    throw new Error(`could not parse npm pack JSON: ${output.slice(0, 200)}`);
  }

  const reports = JSON.parse(output.slice(start, end + 1));
  const report = reports.find((entry) => entry.name === name) ?? reports[0];
  if (!report || !Array.isArray(report.files)) {
    throw new Error("npm pack JSON did not include a files list");
  }
  return report.files.map((file) => String(file.path).replaceAll("\\", "/"));
}

const failures = [];
const packages = discoverPackages();

if (packages.length === 0) {
  console.error("check-pack: no publishable workspace packages found");
  process.exit(1);
}

console.log(`check-pack: ${packages.length} publishable workspace package(s)\n`);

for (const pkg of packages) {
  try {
    const files = runPack(pkg.name);
    const missing = requiredFiles.filter((required) => !files.includes(required));
    const distFiles = files.filter((file) => file.startsWith("dist/") || file.startsWith("dist\\"));

    if (distFiles.length === 0) missing.unshift("dist/ (no compiled files)");
    if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);

    console.log(`PASS ${pkg.name} (${files.length} files, ${distFiles.length} in dist/)`);
  } catch (error) {
    failures.push(pkg.name);
    console.log(`FAIL ${pkg.name}: ${error.message}`);
  }
}

console.log(`\nSummary: ${packages.length - failures.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`Failing packages: ${failures.join(", ")}`);
  process.exit(1);
}
