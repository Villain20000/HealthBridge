#!/usr/bin/env node
/**
 * Production dependency gate.
 *
 * Fails on any high or critical advisory in the production dependency tree
 * (`npm audit --omit=dev`), except for explicitly documented, time-boxed
 * exceptions below. Moderate and lower advisories do not fail the gate but are
 * summarised so they stay visible.
 *
 * `--strict` ignores the exception list, so CI can prove the gate still fails
 * when a new high/critical advisory appears.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

/**
 * Package-level exceptions are deliberate: every advisory in the Angular 19
 * line is fixed by the same framework upgrade, so new 19.x advisories raise no
 * additional decision. The expiry forces that upgrade to be scheduled.
 */
const EXCEPTIONS = [
  {
    packages: ["@angular/common", "@angular/compiler", "@angular/core", "@angular/router"],
    reason:
      "Angular 19 is end-of-life and has no patched 19.x release. The console is a client-side SPA: " +
      "no SSR, hydration, HttpTransferCache or i18n runtime is shipped, and all templates are authored " +
      "in-repo. Remove this exception with the Angular 20 upgrade.",
    expires: "2027-01-31",
  },
];

const root = path.resolve(import.meta.dirname, "..");
const strict = process.argv.includes("--strict");

function runAudit() {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "npm audit --omit=dev --json" : "npm";
  const args = isWindows ? [] : ["audit", "--omit=dev", "--json"];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: isWindows,
    timeout: 120_000,
  });

  if (result.error) throw new Error(`could not run npm audit: ${result.error.message}`);

  const output = (result.stdout ?? "").trim();
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1) {
    const detail = (result.stderr || output || "no output").trim().slice(0, 400);
    throw new Error(`npm audit did not return JSON: ${detail}`);
  }

  const report = JSON.parse(output.slice(start, end + 1));
  if (report.error) {
    throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  }
  if (!report.vulnerabilities || !report.metadata?.vulnerabilities) {
    throw new Error("npm audit report is missing vulnerabilities metadata");
  }
  return report;
}

function advisoriesFor(entry) {
  const advisories = [];
  for (const via of entry.via ?? []) {
    if (typeof via === "object" && via.url) {
      advisories.push({ title: via.title ?? "advisory", url: via.url });
    }
  }
  return advisories;
}

function matchingException(pkg, severity) {
  if (severity === "critical") return undefined; // criticals are never waived
  return EXCEPTIONS.find((exception) => exception.packages.includes(pkg));
}

function isActive(exception, now) {
  return Date.parse(`${exception.expires}T23:59:59Z`) >= now;
}

let report;
try {
  report = runAudit();
} catch (error) {
  console.error(`audit-prod: ${error.message}`);
  process.exit(1);
}

const counts = report.metadata.vulnerabilities;
console.log(
  `audit-prod: production tree — ${counts.critical} critical, ${counts.high} high, ` +
    `${counts.moderate} moderate, ${counts.low} low (${counts.total} total)\n`,
);

const now = Date.now();
const blocked = [];
const waived = [];

for (const [name, entry] of Object.entries(report.vulnerabilities)) {
  if (entry.severity !== "high" && entry.severity !== "critical") continue;

  const advisories = advisoriesFor(entry);
  const candidate = strict ? undefined : matchingException(name, entry.severity);
  const exception = candidate && isActive(candidate, now) ? candidate : undefined;
  const label = `${entry.severity.toUpperCase()} ${name}`;

  if (exception) {
    waived.push({ name, exception });
    console.log(`${label}: covered by exception until ${exception.expires}`);
  } else {
    blocked.push({ name, severity: entry.severity, advisories });
    console.log(`${label}: NOT COVERED${candidate ? ` (exception expired ${candidate.expires})` : ""}`);
  }

  for (const advisory of advisories) console.log(`  - ${advisory.title}\n    ${advisory.url}`);
  if (advisories.length === 0) console.log("  - no advisory details reported by npm");
  console.log();
}

if (blocked.length > 0) {
  console.error(
    `audit-prod: FAIL — ${blocked.length} package(s) with unexcepted high/critical advisories: ` +
      blocked.map((item) => item.name).join(", "),
  );
  process.exit(1);
}

if (waived.length > 0) {
  const reasons = [...new Set(waived.map((item) => item.exception.reason))];
  console.log(`audit-prod: OK — ${waived.length} high package(s) covered by documented exceptions.`);
  for (const reason of reasons) console.log(`  ${reason}`);
} else {
  console.log("audit-prod: OK — no high or critical production advisories.");
}

if (counts.moderate > 0) {
  console.log(`audit-prod: ${counts.moderate} moderate advisory(ies) are reported but not gated.`);
}
