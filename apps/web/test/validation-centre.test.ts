import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ValidationIssue } from "@healthbridge/shared-types";
import {
  SKIPPED_VERDICT,
  executedLevels,
  issueKey,
  issuesForLevel,
  levelTone,
  normaliseLevels,
  normaliseReportIssues,
  partitionIssues,
  severityTone,
  skippedLevels,
  skippedNotice,
  summariseLevels,
  verdictLabel,
  type PartitionedIssues,
} from "../src/app/features/validation-centre/validation-centre.logic";

/**
 * Validation Centre presentation logic. Every claim the page makes about a level — which
 * ran, which validator produced it, why the rest did not — flows through here, so the
 * parsing is pinned against malformed payloads and the skipped wording is pinned verbatim:
 * a skipped level must never read as a pass.
 */

function issue(overrides: Partial<ValidationIssue> = {}): ValidationIssue {
  return {
    code: "INVALID_DATE_FORMAT",
    severity: "error",
    message: "birthDate 'not-a-date' is not a valid date",
    recordIndex: 3,
    path: "birthDate",
    ...overrides,
  };
}

describe("normaliseLevels", () => {
  it("passes through a full engine report in level order", () => {
    const levels = normaliseLevels({
      levels: [
        { level: 3, name: "target-structural", status: "executed", validator: "fhir-r4-validator" },
        { level: 1, name: "source-structural", status: "executed", validator: "csv" },
        { level: 2, name: "mapping-definition", status: "executed", validator: "mapping-engine" },
        { level: 4, name: "profile", status: "skipped", reason: "requires an external validator" },
        { level: 5, name: "terminology", status: "skipped", reason: "requires licensed code systems" },
        { level: 6, name: "referential-integrity", status: "skipped", reason: "lands with Bundles" },
      ],
    });
    assert.equal(levels.length, 6);
    assert.deepEqual(
      levels.map((level) => level.level),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(levels[2]?.validator, "fhir-r4-validator");
    assert.equal(levels[2]?.reason, null);
    assert.equal(levels[4]?.status, "skipped");
    assert.equal(levels[4]?.validator, null);
    assert.equal(levels[4]?.reason, "requires licensed code systems");
  });

  it("returns an empty list when the report is missing or malformed", () => {
    assert.deepEqual(normaliseLevels(undefined), []);
    assert.deepEqual(normaliseLevels(null), []);
    assert.deepEqual(normaliseLevels({}), []);
    assert.deepEqual(normaliseLevels({ levels: "executed" }), []);
    assert.deepEqual(normaliseLevels({ levels: [{ level: 9, name: "nope", status: "executed" }] }), []);
    assert.deepEqual(normaliseLevels({ levels: [{ name: "no-level", status: "executed" }] }), []);
  });

  it("drops duplicates and out-of-range entries, keeping the first per level", () => {
    const levels = normaliseLevels({
      levels: [
        { level: 1, name: "source-structural", status: "executed", validator: "csv" },
        { level: 1, name: "impostor", status: "skipped", reason: "x" },
        "junk",
        { level: 0, name: "zero", status: "executed" },
        { level: 2, name: "  ", status: "executed", validator: "mapping-engine" },
      ],
    });
    assert.equal(levels.length, 2);
    assert.equal(levels[0]?.name, "source-structural");
    assert.equal(levels[1]?.name, "level-2");
  });

  it("treats any non-executed status as skipped so nothing renders as a silent pass", () => {
    const [level] = normaliseLevels({
      levels: [{ level: 4, name: "profile", status: "partial", validator: "hapi" }],
    });
    assert.equal(level?.status, "skipped");
    assert.equal(level?.validator, null);
    assert.ok(level?.reason);
  });
});

describe("skipped wording", () => {
  it("pins the exact verdict phrase", () => {
    assert.equal(SKIPPED_VERDICT, "Not run, never passed");
  });

  it("names the level and carries the stored reason", () => {
    const notice = skippedNotice({ level: 5, name: "terminology", reason: "requires licensed code systems" });
    assert.match(notice, /Level 5 \(terminology\)/);
    assert.match(notice, /not run/i);
    assert.match(notice, /never passed/i);
    assert.match(notice, /requires licensed code systems/);
  });

  it("still reads as not-run without a stored reason", () => {
    const notice = skippedNotice({ level: 4, name: "profile", reason: null });
    assert.match(notice, /not run/i);
    assert.match(notice, /never passed/i);
  });
});

describe("verdict, tones and summaries", () => {
  it("never reports valid on an ambiguous payload", () => {
    assert.equal(verdictLabel(true), "valid");
    assert.equal(verdictLabel(false), "invalid");
    assert.equal(verdictLabel(undefined), "unknown");
    assert.equal(verdictLabel("yes"), "unknown");
  });

  it("keeps skipped levels muted, never alarming", () => {
    assert.equal(levelTone("executed"), "ok");
    assert.equal(levelTone("skipped"), "muted");
  });

  it("mirrors the run-detail severity mapping", () => {
    assert.equal(severityTone("fatal"), "danger");
    assert.equal(severityTone("error"), "danger");
    assert.equal(severityTone("warning"), "warn");
    assert.equal(severityTone("information"), "info");
    assert.equal(severityTone("anything-else"), "info");
  });

  it("counts executed and skipped levels", () => {
    const levels = normaliseLevels({
      levels: [
        { level: 1, name: "a", status: "executed" },
        { level: 4, name: "b", status: "skipped", reason: "r" },
      ],
    });
    assert.deepEqual(summariseLevels(levels), { total: 2, executed: 1, skipped: 1 });
    assert.equal(executedLevels(levels).length, 1);
    assert.equal(skippedLevels(levels).length, 1);
  });
});

describe("normaliseReportIssues", () => {
  it("passes the report issue channel through and rejects junk", () => {
    const first = issue();
    assert.deepEqual(normaliseReportIssues({ issues: [first, null, 42] }), [first]);
    assert.deepEqual(normaliseReportIssues({}), []);
    assert.deepEqual(normaliseReportIssues(undefined), []);
  });
});

describe("partitionIssues", () => {
  it("splits the level-3 channel from earlier findings", () => {
    const level3 = issue({ code: "TARGET_INVALID" });
    const earlier = issue({ code: "PARSE_FAILED", recordIndex: 0 });
    const partitioned = partitionIssues([earlier, level3], [level3]);
    assert.deepEqual(partitioned.levelIssues, [level3]);
    assert.deepEqual(partitioned.earlierIssues, [earlier]);
  });

  it("is multiset-aware when the same issue repeats", () => {
    const repeated = issue();
    const partitioned = partitionIssues([repeated, { ...repeated }], [repeated]);
    assert.equal(partitioned.levelIssues.length, 1);
    assert.equal(partitioned.earlierIssues.length, 1);
  });

  it("keeps everything earlier when the report channel is empty", () => {
    const partitioned = partitionIssues([issue()], []);
    assert.deepEqual(partitioned.levelIssues, []);
    assert.equal(partitioned.earlierIssues.length, 1);
  });

  it("builds a stable key from every locating field", () => {
    const base = issue();
    assert.equal(issueKey(base), issueKey({ ...base }));
    assert.notEqual(issueKey(base), issueKey({ ...base, recordIndex: 4 }));
    assert.notEqual(issueKey(base), issueKey({ ...base, code: "OTHER" }));
  });
});

describe("issuesForLevel", () => {
  const partitioned: PartitionedIssues = {
    levelIssues: [issue({ code: "TARGET_INVALID" })],
    earlierIssues: [issue({ code: "PARSE_FAILED" })],
  };

  it("gives level 3 the report channel and levels 1-2 the shared earlier list", () => {
    assert.deepEqual(issuesForLevel({ level: 3, status: "executed" }, partitioned), partitioned.levelIssues);
    assert.deepEqual(issuesForLevel({ level: 1, status: "executed" }, partitioned), partitioned.earlierIssues);
    assert.deepEqual(issuesForLevel({ level: 2, status: "executed" }, partitioned), partitioned.earlierIssues);
  });

  it("gives skipped levels no list — the verdict wording stands in", () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      assert.deepEqual(issuesForLevel({ level, status: "skipped" }, partitioned), []);
    }
  });
});
