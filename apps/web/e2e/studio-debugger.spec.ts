import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { clientNavigate, expect, test } from "./support/fixtures";
import type { SeedState } from "./support/fixtures";

/**
 * Stored-trace debugger.
 *
 * The first block reads one real seeded run through the API and asserts every count against the
 * stored rows. The second block serves a deterministic 5,000-event run through `page.route`, so
 * virtualisation, keyboard travel and large-list filtering are covered without a slow real run.
 * Neither block opens a live stream: the debugger must stay a stored-trace replay.
 */

type JsonRecord = Record<string, unknown>;

interface StoredTraceRow {
  seq: number;
  stage: string;
  stepName?: string;
  status?: string;
  durationMs?: number;
  payload?: unknown;
  createdAt?: string;
}

interface RealRunData {
  run: {
    id: string;
    mappingId: string;
    status: string;
    createdAt: string;
    result?: { resources?: unknown[] };
  };
  mapping: { id: string; version: unknown; spec?: unknown };
  traces: StoredTraceRow[];
}

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  completed: "Completed",
  completed_with_warnings: "Completed with warnings",
  failed: "Failed",
};

const TRACE_STAGE_ORDER = [
  "detect",
  "adapter-selection",
  "parse",
  "envelope",
  "mapping",
  "build",
  "validate",
  "export",
];

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function payloadOf(row: StoredTraceRow): JsonRecord {
  return asRecord(row.payload) ?? {};
}

/** Mirrors the debugger: the payload is the source of truth, the stored column is the fallback. */
function eventStage(row: StoredTraceRow): string {
  return nonEmptyString(payloadOf(row)["stage"]) ?? nonEmptyString(row.stage) ?? "unknown";
}

function eventStatus(row: StoredTraceRow): string {
  return nonEmptyString(payloadOf(row)["status"]) ?? nonEmptyString(row.status) ?? "unknown";
}

function eventStepName(row: StoredTraceRow): string {
  return nonEmptyString(payloadOf(row)["stepName"]) ?? (typeof row.stepName === "string" ? row.stepName : "");
}

function eventRecordIndex(row: StoredTraceRow): number | null {
  const value = payloadOf(row)["recordIndex"];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function eventRuleId(row: StoredTraceRow): string | null {
  return nonEmptyString(payloadOf(row)["ruleId"]);
}

function eventIssues(row: StoredTraceRow): JsonRecord[] {
  const value = payloadOf(row)["issues"];
  if (!Array.isArray(value)) return [];
  return value.filter((issue): issue is JsonRecord => asRecord(issue) !== null);
}

function hasBothSnippets(row: StoredTraceRow): boolean {
  const payload = payloadOf(row);
  return (
    Object.prototype.hasOwnProperty.call(payload, "inputSnippet") &&
    Object.prototype.hasOwnProperty.call(payload, "outputSnippet")
  );
}

/** The search haystack, matching `trace.logic.ts` (step name, declared paths, issue text). */
function haystack(row: StoredTraceRow): string {
  const payload = payloadOf(row);
  const parts = [
    eventStepName(row),
    nonEmptyString(payload["sourcePath"]) ?? "",
    nonEmptyString(payload["targetPath"]) ?? "",
  ];
  for (const issue of eventIssues(row)) {
    if (typeof issue["code"] === "string") parts.push(issue["code"]);
    if (typeof issue["message"] === "string") parts.push(issue["message"]);
  }
  return parts.join("\n").toLowerCase();
}

function matchesQuery(row: StoredTraceRow, query: string): boolean {
  return haystack(row).includes(query.trim().toLowerCase());
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

async function readRealRun(request: APIRequestContext, state: SeedState): Promise<RealRunData> {
  const headers = { "x-api-key": state.key };
  const runResponse = await request.get(`/api/v1/runs/${state.runId}`, { headers });
  expect(runResponse.ok(), await runResponse.text()).toBe(true);
  const run = ((await runResponse.json()) as { run: RealRunData["run"] }).run;

  const [tracesResponse, issuesResponse, mappingResponse] = await Promise.all([
    request.get(`/api/v1/runs/${state.runId}/traces`, { headers }),
    request.get(`/api/v1/runs/${state.runId}/issues`, { headers }),
    request.get(`/api/v1/mappings/${run.mappingId}`, { headers }),
  ]);
  expect(tracesResponse.ok(), await tracesResponse.text()).toBe(true);
  expect(issuesResponse.ok(), await issuesResponse.text()).toBe(true);
  expect(mappingResponse.ok(), await mappingResponse.text()).toBe(true);

  const traces = ((await tracesResponse.json()) as { traces: StoredTraceRow[]; count: number }).traces;
  const mapping = ((await mappingResponse.json()) as { mapping: RealRunData["mapping"] }).mapping;
  return { run, mapping, traces };
}

function showingLine(filtered: number, total: number): string {
  return `Showing ${filtered} of ${total} stored events.`;
}

async function openDebugger(page: Page, runId: string, query = ""): Promise<void> {
  // The page immediately writes its own view state (`?event=…`) into the URL, so assert the
  // path boundary rather than the exact pre-settle URL that `clientNavigate` would require.
  await pushClientRoute(page, `/studio/debugger/${runId}${query}`);
  await expect(page.getByRole("heading", { level: 1, name: runId })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/studio/debugger/${runId}(\\?.*)?$`));
}

/**
 * Dispatches an in-app navigation without asserting the transient URL. The debugger rewrites
 * its URL from known view state as soon as it settles, so an assertion on the pre-rewrite URL
 * (with an unknown key) would race the page; only the settled URL is meaningful.
 */
async function pushClientRoute(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** The Stage summary table is scoped so the diff tables cannot answer these assertions. */
function stageSummary(page: Page): Locator {
  return page.locator("section[aria-labelledby='dbg-stage-summary']");
}

async function expectStageCount(page: Page, stage: string, count: number): Promise<void> {
  const cell = stageSummary(page).getByRole("cell", { name: stage, exact: true });
  await expect(cell).toHaveCount(1);
  await expect(cell.locator("xpath=following-sibling::td[1]")).toHaveText(String(count));
}

test.describe("stored-trace debugger", () => {
  test("shows the stored run header, replay truth label and API-derived stage summary", async ({
    console: page,
    request,
    state,
  }) => {
    const data = await readRealRun(request, state);
    const run = data.run;
    const total = data.traces.length;
    const stageCounts = countBy(data.traces, eventStage);

    await openDebugger(page, state.runId);

    await expect(page.getByRole("heading", { level: 1, name: state.runId })).toHaveText(state.runId);
    await expect(page.getByText("Stored trace replay — not live execution.", { exact: false })).toBeVisible();

    const statusChip = page.locator(".page-header hb-status-chip");
    await expect(statusChip).toHaveText(STATUS_LABELS[run.status] ?? run.status);
    await expect(statusChip.locator(".chip")).toHaveAttribute(
      "aria-label",
      `Status: ${STATUS_LABELS[run.status] ?? run.status}`,
    );
    await expect(page.locator(".page-header")).toContainText(`mapping v${String(data.mapping.version)}`);

    await expect(page.locator(".summary-line")).toContainText(`All stored events: ${total}`);
    await expect(page.getByRole("heading", { name: "Stage summary" })).toBeVisible();
    for (const [stage, count] of stageCounts) {
      await expectStageCount(page, stage, count);
    }
  });

  test("reads the stored rows once: no event stream and no polling", async ({ console: page, request, state }) => {
    const data = await readRealRun(request, state);
    const total = data.traces.length;
    const runPaths: string[] = [];

    page.on("request", (requestEvent) => {
      const url = new URL(requestEvent.url());
      if (url.pathname.startsWith(`/api/v1/runs/${state.runId}`)) runPaths.push(url.pathname);
    });

    await openDebugger(page, state.runId);
    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toBeVisible();
    await expect(page.getByText(showingLine(total, total))).toBeVisible();

    // Give a would-be poller time to fire once; the stored-trace page must stay quiet.
    await page.waitForTimeout(600);

    expect(runPaths.filter((path) => path.endsWith("/events"))).toEqual([]);
    expect(runPaths.filter((path) => path === `/api/v1/runs/${state.runId}`)).toHaveLength(1);
    expect(runPaths.filter((path) => path.endsWith("/traces"))).toHaveLength(1);
    expect(runPaths.filter((path) => path.endsWith("/issues"))).toHaveLength(1);
  });

  test("renders every stored event, follows selection, and shows payload detail and the snippet diff", async ({
    console: page,
    request,
    state,
  }) => {
    const data = await readRealRun(request, state);
    const total = data.traces.length;
    expect(total, "the seeded run is small enough for a full render").toBeLessThan(200);

    await openDebugger(page, state.runId);
    const listbox = page.getByRole("listbox", { name: "Stored trace events" });
    const options = listbox.getByRole("option");
    await expect(options).toHaveCount(total);

    const ordered = [...data.traces].sort((left, right) => left.seq - right.seq);
    const first = ordered[0];
    const second = ordered[1];
    await expect(page.locator(`#hb-trace-option-${first.seq}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { level: 2, name: `Event ${first.seq}` })).toBeVisible();

    await page.locator(`#hb-trace-option-${second.seq}`).click();
    await expect(page.locator(`#hb-trace-option-${second.seq}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`#hb-trace-option-${first.seq}`)).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("heading", { level: 2, name: `Event ${second.seq}` })).toBeVisible();

    const detailRow = ordered.find((row) => hasBothSnippets(row) && eventRecordIndex(row) !== null);
    expect(detailRow, "the seed records an event with both snippets and a record index").toBeTruthy();
    const snippetEvent = detailRow as StoredTraceRow;
    const stage = eventStage(snippetEvent);
    const record = eventRecordIndex(snippetEvent);
    const stepName = eventStepName(snippetEvent);

    await page.locator(`#hb-trace-option-${snippetEvent.seq}`).click();
    await expect(page.locator(`#hb-trace-option-${snippetEvent.seq}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { level: 2, name: `Event ${snippetEvent.seq}` })).toBeVisible();

    const detail = page.locator("hb-event-detail");
    const definition = (term: string): Locator =>
      detail
        .locator("dt")
        .filter({ hasText: new RegExp(`^${term}$`) })
        .locator("xpath=following-sibling::dd[1]");
    await expect(definition("Stage")).toHaveText(stage);
    await expect(definition("Step")).toHaveText(stepName);
    await expect(definition("Record")).toHaveText(`record ${record} (0-based)`);
    await expect(
      detail.getByText("Declared from the run's mapping version. The trace does not record per-rule observed values.", {
        exact: true,
      }),
    ).toBeVisible();

    await expect(page.getByRole("heading", { name: "Input vs output snippet" })).toBeVisible();
    const snippetTable = page.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "Input snippet", exact: true }),
    });
    await expect(snippetTable).toBeVisible();
    await expect(snippetTable.getByRole("columnheader", { name: "Output snippet", exact: true })).toBeVisible();
  });

  test("honours an event and stage deep link, and drops unknown query keys", async ({
    console: page,
    request,
    state,
  }) => {
    const data = await readRealRun(request, state);
    const total = data.traces.length;
    const stageCounts = countBy(data.traces, eventStage);

    const event = data.traces.find((row) => eventStage(row) === "mapping") ?? data.traces[0];
    expect(event, "the seed stores at least one event").toBeTruthy();
    const chosen = event as StoredTraceRow;
    const stage = eventStage(chosen);
    const expected = stageCounts.get(stage) ?? 0;
    expect(expected).toBeGreaterThan(0);

    await openDebugger(page, state.runId, `?event=${chosen.seq}&stage=${encodeURIComponent(stage)}`);

    await expect(page.locator("#dbg-stage")).toHaveValue(stage);
    await expect(page.getByText(showingLine(expected, total))).toBeVisible();
    await expect(page.locator(`#hb-trace-option-${chosen.seq}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { level: 2, name: `Event ${chosen.seq}` })).toBeVisible();

    // The page rewrites its URL from known view state; an unknown key must not survive.
    await clientNavigate(page, "/studio");
    await pushClientRoute(page, `/studio/debugger/${state.runId}?event=${chosen.seq}&unused=1`);
    await expect(page.getByRole("heading", { level: 2, name: `Event ${chosen.seq}` })).toBeVisible();
    await expect(page).not.toHaveURL(/unused/);

    // A stage with no stored rows still filters (and must stay visible in the select).
    const absentStage = TRACE_STAGE_ORDER.find((candidate) => !stageCounts.has(candidate));
    expect(absentStage, "the seeded trace omits at least one declared stage").toBeDefined();
    const missingStage = absentStage as string;
    await clientNavigate(page, "/studio");
    await openDebugger(page, state.runId, `?stage=${missingStage}`);
    await expect(page.locator("#dbg-stage")).toHaveValue(missingStage);
    await expect(page.getByText(showingLine(0, total))).toBeVisible();
    await expect(page.getByText("No events match these filters")).toBeVisible();

    // The seeded run stores only `success` rows; an absent status must stay selected and empty.
    const statusCounts = countBy(data.traces, eventStatus);
    expect(statusCounts.has("warning"), "the seeded trace has no warning rows").toBe(false);
    await clientNavigate(page, "/studio");
    await openDebugger(page, state.runId, "?status=warning");
    await expect(page.locator("#dbg-status")).toHaveValue("warning");
    await expect(page.getByText(showingLine(0, total))).toBeVisible();
    await expect(page.getByText("No events match these filters")).toBeVisible();
  });

  test("filters by record, stage, status, rule and issues with API-derived counts", async ({
    console: page,
    request,
    state,
  }) => {
    const data = await readRealRun(request, state);
    const total = data.traces.length;
    const statusLine = (filtered: number): Locator => page.getByText(showingLine(filtered, total));
    const clear = page.getByRole("button", { name: "Clear filters" });
    const empty = page.getByText("No events match these filters");

    await openDebugger(page, state.runId);
    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toBeVisible();

    // Record index 0 must be treated as a value, not as "no filter".
    const recordZero = data.traces.filter((row) => eventRecordIndex(row) === 0).length;
    expect(recordZero).toBeGreaterThan(0);
    const recordInput = page.getByLabel("Record index (0-based)");
    await recordInput.fill("0");
    await recordInput.press("Tab");
    await expect(statusLine(recordZero)).toBeVisible();
    await clear.click();
    await expect(statusLine(total)).toBeVisible();

    const stageCounts = countBy(data.traces, eventStage);
    const stage = [...stageCounts.entries()].sort((left, right) => right[1] - left[1])[0][0];
    await page.locator("#dbg-stage").selectOption(stage);
    await expect(statusLine(stageCounts.get(stage) ?? 0)).toBeVisible();
    await clear.click();
    await expect(statusLine(total)).toBeVisible();

    const statusCounts = countBy(data.traces, eventStatus);
    const status = [...statusCounts.keys()].sort()[0];
    await page.locator("#dbg-status").selectOption(status);
    await expect(statusLine(statusCounts.get(status) ?? 0)).toBeVisible();
    await clear.click();
    await expect(statusLine(total)).toBeVisible();

    // The seeded success traces may record no rule ids; a declared rule then honestly matches zero.
    const recordedRuleIds = [...new Set(data.traces.map(eventRuleId).filter((id): id is string => id !== null))];
    const spec = asRecord(data.mapping.spec);
    const specRules = Array.isArray(spec?.["rules"]) ? (spec["rules"] as unknown[]) : [];
    const declaredRuleIds = specRules
      .map((rule) => asRecord(rule))
      .filter((rule): rule is JsonRecord => rule !== null)
      .map((rule) => nonEmptyString(rule["id"]))
      .filter((id): id is string => id !== null);
    const ruleId = recordedRuleIds[0] ?? declaredRuleIds[0];
    expect(ruleId, "the mapping declares a rule id").toBeTruthy();
    const ruleCount = data.traces.filter((row) => eventRuleId(row) === ruleId).length;
    await page.getByLabel("Rule id").fill(ruleId as string);
    await expect(statusLine(ruleCount)).toBeVisible();
    if (ruleCount === 0) await expect(empty).toBeVisible();
    await clear.click();
    await expect(statusLine(total)).toBeVisible();

    const withIssues = data.traces.filter((row) => eventIssues(row).length > 0).length;
    await page.getByLabel("Only events with issues").check();
    await expect(statusLine(withIssues)).toBeVisible();
    if (withIssues === 0) await expect(empty).toBeVisible();
    await clear.click();
    await expect(statusLine(total)).toBeVisible();
  });

  test("debounces search and clearing during the debounce window empties the field", async ({
    console: page,
    request,
    state,
  }) => {
    const data = await readRealRun(request, state);
    const total = data.traces.length;
    const statusLine = (filtered: number): Locator => page.getByText(showingLine(filtered, total));
    const search = page.getByLabel("Search steps, paths, codes and messages");
    const clear = page.getByRole("button", { name: "Clear filters" });

    const tokenCounts = new Map<string, number>();
    for (const row of data.traces) {
      const step = eventStepName(row);
      if (step.length === 0) continue;
      const count = data.traces.filter((candidate) => matchesQuery(candidate, step)).length;
      if (count > 0 && count < total) tokenCounts.set(step, count);
    }
    const token = [...tokenCounts.entries()][0];
    expect(token, "the seed has a step-name token that narrows the timeline").toBeTruthy();
    const [searchText, expected] = token as [string, number];

    // Frozen page timers make the debounce window deterministic: nothing fires until runFor.
    await page.clock.install();
    await openDebugger(page, state.runId);
    const listbox = page.getByRole("listbox", { name: "Stored trace events" });
    await expect(listbox).toBeVisible();

    await search.fill(searchText);
    await page.clock.runFor(300);
    await expect(statusLine(expected)).toBeVisible();

    // Clear once so the store's applied q is empty; the next clear is inside the debounce.
    await clear.click();
    await expect(search).toHaveValue("");
    await expect(statusLine(total)).toBeVisible();

    // Fresh text is still pending when Clear runs. The store's q never changed from "", so only
    // the local mirror can empty the field (the fix in debugger-filters.ts).
    await search.fill(searchText);
    await expect(statusLine(total)).toBeVisible();
    await clear.click();
    await page.clock.runFor(300);

    await expect(search).toHaveValue("");
    await expect(statusLine(total)).toBeVisible();
    await expect(listbox).toBeVisible();
  });

  test("moves with Previous/Next, disables at the ends, and jumps to the first match", async ({
    console: page,
    request,
    state,
  }) => {
    const data = await readRealRun(request, state);
    const total = data.traces.length;
    const ordered = [...data.traces].sort((left, right) => left.seq - right.seq);
    const first = ordered[0];
    const second = ordered[1];
    const last = ordered[ordered.length - 1];
    const previousButton = page.getByRole("button", { name: "Previous event" });
    const nextButton = page.getByRole("button", { name: "Next event" });

    await openDebugger(page, state.runId);
    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: `Event ${first.seq}` })).toBeVisible();
    await expect(previousButton).toBeDisabled();
    await expect(nextButton).toBeEnabled();

    await nextButton.click();
    await expect(page.getByRole("heading", { level: 2, name: `Event ${second.seq}` })).toBeVisible();
    await expect(page.locator(`#hb-trace-option-${second.seq}`)).toHaveAttribute("aria-selected", "true");

    await previousButton.click();
    await expect(page.getByRole("heading", { level: 2, name: `Event ${first.seq}` })).toBeVisible();

    await page.locator(`#hb-trace-option-${last.seq}`).click();
    await expect(page.getByRole("heading", { level: 2, name: `Event ${last.seq}` })).toBeVisible();
    await expect(nextButton).toBeDisabled();
    await expect(previousButton).toBeEnabled();

    // `q` deliberately does not re-clamp the selection; Jump is what moves it.
    const jumpToken = [...new Set(data.traces.map(eventStepName))]
      .filter((step) => step.length > 0)
      .map((step) => ({ step, count: data.traces.filter((row) => matchesQuery(row, step)).length }))
      .find(({ step, count }) => count > 0 && count < total && !matchesQuery(last, step));
    expect(jumpToken, "the seed has a query that excludes the last event").toBeTruthy();
    const { step: jumpText, count: jumpCount } = jumpToken as { step: string; count: number };

    await page.getByLabel("Search steps, paths, codes and messages").fill(jumpText);
    await expect(page.getByText(showingLine(jumpCount, total))).toBeVisible();
    await expect(page.getByRole("heading", { name: "No event selected" })).toBeVisible();

    // Mirror the app's seq sort instead of trusting the API's incidental row order.
    const firstMatch = ordered.find((row) => matchesQuery(row, jumpText));
    expect(firstMatch, "the query matches at least one stored event").toBeTruthy();
    await page.getByRole("button", { name: "Jump to first match" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: `Event ${(firstMatch as StoredTraceRow).seq}` }),
    ).toBeVisible();
  });

  test("downloads a stored-trace export that matches the applied filter", async ({ console: page, request, state }) => {
    const data = await readRealRun(request, state);
    const total = data.traces.length;
    // Mirror the app's seq sort instead of trusting the API's incidental row order.
    const ordered = [...data.traces].sort((left, right) => left.seq - right.seq);

    // A filter with exactly one match: prefer a stage that occurs once in the stored rows.
    const stageCounts = [...countBy(data.traces, eventStage).entries()];
    const recordCounts = new Map<string, number>();
    for (const row of data.traces) {
      const record = eventRecordIndex(row);
      if (record === null) continue;
      const key = String(record);
      recordCounts.set(key, (recordCounts.get(key) ?? 0) + 1);
    }
    const uniqueStage = stageCounts.find(([, count]) => count === 1);
    const uniqueRecord = [...recordCounts.entries()].find(([, count]) => count === 1);
    expect(uniqueStage ?? uniqueRecord, "the seed has a filter with exactly one match").toBeTruthy();

    await openDebugger(page, state.runId);
    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toBeVisible();

    const expectedFilter = {
      stage: null as string | null,
      status: null as string | null,
      record: null as number | null,
      rule: null as string | null,
      q: "",
      onlyIssues: false,
    };
    let expectedSeq: number;
    if (uniqueStage !== undefined) {
      const [stage, count] = uniqueStage;
      expect(count).toBe(1);
      expectedFilter.stage = stage;
      await page.locator("#dbg-stage").selectOption(stage);
      expectedSeq = (ordered.find((row) => eventStage(row) === stage) as StoredTraceRow).seq;
    } else {
      const [record, count] = uniqueRecord as [string, number];
      expect(count).toBe(1);
      expectedFilter.record = Number(record);
      const recordInput = page.getByLabel("Record index (0-based)");
      await recordInput.fill(record);
      await recordInput.press("Tab");
      expectedSeq = (ordered.find((row) => eventRecordIndex(row) === Number(record)) as StoredTraceRow).seq;
    }
    await expect(page.getByText(showingLine(1, total))).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download JSON" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`healthbridge-trace-${state.runId}.json`);

    const path = await download.path();
    expect(path).not.toBeNull();
    const payload = JSON.parse(readFileSync(path as string, "utf8")) as {
      source: string;
      live: boolean;
      runId: string;
      generatedAt: string;
      redaction: string;
      count: number;
      filter: Record<string, unknown>;
      traces: StoredTraceRow[];
    };
    expect(payload.source).toBe("stored-trace");
    expect(payload.live).toBe(false);
    expect(payload.runId).toBe(state.runId);
    expect(typeof payload.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(payload.generatedAt))).toBe(true);
    expect(payload.redaction).toBe("server-redacted");
    expect(payload.count).toBe(1);
    expect(payload.traces).toHaveLength(1);
    expect(payload.filter).toEqual(expectedFilter);
    expect(payload.traces[0].seq).toBe(expectedSeq);

    // The export must carry the stored row itself, not a re-serialised view model.
    const apiRow = data.traces.find((row) => row.seq === expectedSeq);
    expect(apiRow).toBeTruthy();
    expect(payload.traces[0]).toEqual(apiRow);
  });

  test("has no serious axe violations and no horizontal overflow at 390 px", async ({ console: page, state }) => {
    await openDebugger(page, state.runId);
    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    const blocking = results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
    expect(blocking, `violations: ${JSON.stringify(blocking.map((violation) => violation.id))}`).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await clientNavigate(page, "/studio");
    await openDebugger(page, state.runId);
    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toBeVisible();
    await expect(page.locator(".table-wrap").first()).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Deterministic 5,000-event fixture.
// ---------------------------------------------------------------------------------------------

const FIXTURE_RUN_ID = "run_fixture_5000";
const FIXTURE_MAPPING_ID = "map_fixture";
const FIXTURE_TOTAL = 5000;
const FIXTURE_CREATED_AT = "2026-01-01T00:00:00.000Z";
const STAGE_CYCLE = ["detect", "adapter-selection", "parse", "envelope", "mapping", "build", "validate", "export"];
const STATUS_RUN_ID = "run_fixture_status";
const STATUS_STAGES = ["success", "success", "warning", "warning", "error", "skipped"];

const FIXTURE_RESOURCES = [
  {
    resourceType: "Patient",
    id: "fixture-patient-a",
    name: [{ family: "Fixture Patient", given: ["Fixture"] }],
    active: true,
  },
  {
    resourceType: "Patient",
    id: "fixture-patient-b",
    name: [{ family: "Fixture Patient (changed)", given: ["Fixture"] }],
    active: true,
    gender: "female",
  },
];

const FIXTURE_MAPPING = {
  mapping: {
    id: FIXTURE_MAPPING_ID,
    name: "Fixture mapping",
    version: "1.0.0",
    targetFormat: "fhir-r4",
    targetResourceType: "Patient",
    createdAt: FIXTURE_CREATED_AT,
    spec: {
      rules: [
        { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true },
        {
          id: "r2",
          sourcePath: "sex",
          targetPath: "gender",
          transform: "format_gender_fhir",
          when: [{ path: "sex", op: "equals", value: "female" }],
        },
      ],
    },
  },
};

function buildFixtureTraces(): StoredTraceRow[] {
  const rows: StoredTraceRow[] = [];
  for (let index = 0; index < FIXTURE_TOTAL; index += 1) {
    const stage = STAGE_CYCLE[index % STAGE_CYCLE.length];
    const payload: JsonRecord = {
      protocolVersion: "1.2",
      runId: FIXTURE_RUN_ID,
      timestamp: FIXTURE_CREATED_AT,
      stepId: `step-${index}`,
      stepName: `Step ${index}`,
      stage,
      recordIndex: index,
      status: "success",
      durationMs: 1,
      redacted: false,
      inputSnippet: { index },
      outputSnippet: { index, doubled: index * 2 },
      issues:
        index % 100 === 0
          ? [
              {
                code: "FIXTURE_WARNING",
                severity: "warning",
                message: `Fixture warning ${index}`,
                recordIndex: index,
                path: "id",
              },
            ]
          : [],
      ruleId: index % 10 === 0 ? "r1" : index % 10 === 5 ? "unknown-rule" : undefined,
    };
    rows.push({
      seq: index,
      stage,
      stepName: `Step ${index}`,
      status: "success",
      durationMs: 1,
      createdAt: FIXTURE_CREATED_AT,
      payload,
    });
  }
  return rows;
}

const FIXTURE_TRACES = buildFixtureTraces();

/** A small mixed-status run: six stored rows whose statuses narrow the timeline. */
function buildStatusFixtureTraces(): StoredTraceRow[] {
  return STATUS_STAGES.map((status, index) => ({
    seq: index,
    stage: "mapping",
    stepName: `Status ${index}`,
    status,
    durationMs: 1,
    createdAt: FIXTURE_CREATED_AT,
    payload: {
      stage: "mapping",
      stepName: `Status ${index}`,
      status,
      recordIndex: index,
      issues: [],
      redacted: false,
    },
  }));
}

const STATUS_TRACES = buildStatusFixtureTraces();

function fixtureRun(id: string, status: string): unknown {
  return {
    run: {
      id,
      workspaceId: "ws_fixture",
      mappingId: FIXTURE_MAPPING_ID,
      status,
      engineVersion: "3.2.0",
      createdAt: FIXTURE_CREATED_AT,
      finishedAt: FIXTURE_CREATED_AT,
      result: { resources: FIXTURE_RESOURCES },
    },
  };
}

/** Registers the four reads the debugger makes for one fixture run. */
async function registerFixtureRoutes(page: Page, id: string, status: string, traces: StoredTraceRow[]): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route(`**/api/v1/runs/${id}/traces`, (route) => route.fulfill(json({ count: traces.length, traces })));
  await page.route(`**/api/v1/runs/${id}/issues`, (route) => route.fulfill(json({ issues: [], rejected: [] })));
  await page.route(`**/api/v1/runs/${id}`, (route) => route.fulfill(json(fixtureRun(id, status))));
  await page.route(`**/api/v1/mappings/${FIXTURE_MAPPING_ID}`, (route) => route.fulfill(json(FIXTURE_MAPPING)));
}

async function settledOptionCount(options: Locator): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await options.count();
    if (current > 0 && current === previous) return current;
    previous = current;
    await options.page().waitForTimeout(50);
  }
  return options.count();
}

test.describe("stored-trace debugger · 5,000-event fixture", () => {
  test("virtualises the timeline: bounded DOM, full set size and a truthful count", async ({ console: page }) => {
    await registerFixtureRoutes(page, FIXTURE_RUN_ID, "completed", FIXTURE_TRACES);
    await openDebugger(page, FIXTURE_RUN_ID);

    const listbox = page.getByRole("listbox", { name: "Stored trace events" });
    const options = listbox.getByRole("option");
    await expect(page.getByText(`Showing ${FIXTURE_TOTAL} of ${FIXTURE_TOTAL} stored events.`)).toBeVisible();
    await expect(listbox).toBeVisible();

    const rendered = await settledOptionCount(options);
    expect(rendered).toBeGreaterThanOrEqual(1);
    expect(rendered).toBeLessThan(200);
    await expect(options).toHaveCount(rendered);
    await expect(options.first()).toHaveAttribute("aria-setsize", String(FIXTURE_TOTAL));

    const sizes = await options.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-setsize")),
    );
    expect(sizes).toEqual(new Array(rendered).fill(String(FIXTURE_TOTAL)));
  });

  test("keyboard End/Home/PageDown drives the virtualised selection", async ({ console: page }) => {
    await registerFixtureRoutes(page, FIXTURE_RUN_ID, "completed", FIXTURE_TRACES);
    await openDebugger(page, FIXTURE_RUN_ID);

    const listbox = page.getByRole("listbox", { name: "Stored trace events" });
    await expect(listbox).toBeVisible();
    await listbox.focus();
    await expect(listbox).toBeFocused();

    await page.keyboard.press("End");
    await expect(page.getByRole("heading", { level: 2, name: "Event 4999" })).toBeVisible();
    await expect(page.locator("#hb-trace-option-4999")).toBeVisible();
    await expect(listbox).toHaveAttribute("aria-activedescendant", "hb-trace-option-4999");

    await page.keyboard.press("Home");
    await expect(page.getByRole("heading", { level: 2, name: "Event 0" })).toBeVisible();
    await expect(listbox).toHaveAttribute("aria-activedescendant", "hb-trace-option-0");

    await page.keyboard.press("PageDown");
    await expect(page.getByRole("heading", { level: 2, name: "Event 10" })).toBeVisible();
  });

  test("deep links into the long list and scrolls the selection into view", async ({ console: page }) => {
    await registerFixtureRoutes(page, FIXTURE_RUN_ID, "completed", FIXTURE_TRACES);
    await openDebugger(page, FIXTURE_RUN_ID, "?event=2500&stage=mapping");

    await expect(page.getByRole("heading", { level: 2, name: "Event 2500" })).toBeVisible();
    await expect(page.locator("#hb-trace-option-2500")).toBeVisible();
    const mappingCount = FIXTURE_TRACES.filter((row) => payloadOf(row)["stage"] === "mapping").length;
    expect(mappingCount).toBe(625);
    await expect(page.getByText(`Showing ${mappingCount} of ${FIXTURE_TOTAL} stored events.`)).toBeVisible();
    await expect(page.locator("#dbg-stage")).toHaveValue("mapping");
  });

  test("filtering to zero and clearing restores the selected event without a dangling active descendant", async ({
    console: page,
  }) => {
    await registerFixtureRoutes(page, FIXTURE_RUN_ID, "completed", FIXTURE_TRACES);
    await openDebugger(page, FIXTURE_RUN_ID, "?event=4999");

    const listbox = page.getByRole("listbox", { name: "Stored trace events" });
    await expect(page.getByRole("heading", { level: 2, name: "Event 4999" })).toBeVisible();
    await expect(page.locator("#hb-trace-option-4999")).toBeVisible();

    await page.getByLabel("Search steps, paths, codes and messages").fill("no-such-step-xyz");
    await expect(page.getByText("No events match these filters")).toBeVisible();

    // Watch the listbox while the clear re-renders the window: the active descendant must never
    // point at an option that is not in the DOM.
    await page.evaluate(() => {
      const dangling: string[] = [];
      (window as Window & { __dangling?: string[] }).__dangling = dangling;
      const observer = new MutationObserver(() => {
        const list = document.querySelector('[role="listbox"][aria-label="Stored trace events"]');
        const active = list?.getAttribute("aria-activedescendant");
        if (active && document.getElementById(active) === null) dangling.push(active);
      });
      observer.observe(document.body, { subtree: true, attributes: true, childList: true });
      (window as Window & { __observer?: MutationObserver }).__observer = observer;
    });

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText(`Showing ${FIXTURE_TOTAL} of ${FIXTURE_TOTAL} stored events.`)).toBeVisible();
    await expect(listbox).toBeVisible();
    await expect(page.locator("#hb-trace-option-4999")).toBeVisible();
    await expect(listbox).toHaveAttribute("aria-activedescendant", "hb-trace-option-4999");

    const dangling = await page.evaluate(() => {
      const state = window as Window & { __dangling?: string[]; __observer?: MutationObserver };
      state.__observer?.disconnect();
      return state.__dangling ?? [];
    });
    expect(dangling).toEqual([]);
  });

  test("joins declared rule provenance and filters by rule id", async ({ console: page }) => {
    await registerFixtureRoutes(page, FIXTURE_RUN_ID, "completed", FIXTURE_TRACES);
    await openDebugger(page, FIXTURE_RUN_ID);

    const listbox = page.getByRole("listbox", { name: "Stored trace events" });
    await expect(listbox).toBeVisible();
    await page.locator("#hb-trace-option-0").click();

    const provenance = page.locator("hb-provenance");
    await expect(page.getByRole("heading", { level: 2, name: "Event 0" })).toBeVisible();
    await expect(provenance.getByText("Joined by rule id", { exact: true })).toBeVisible();
    const provenanceValue = (term: string): Locator =>
      provenance
        .locator("dt")
        .filter({ hasText: new RegExp(`^${term}$`) })
        .locator("xpath=following-sibling::dd[1]");
    await expect(provenanceValue("Source path")).toHaveText("patient_id");
    await expect(provenanceValue("Target path")).toHaveText("id");
    await expect(
      provenance.getByText(
        "Declared from the run's mapping version. The trace does not record per-rule observed values.",
        { exact: true },
      ),
    ).toBeVisible();

    // r2's `when` condition is declared with the mapping but never evaluated: the trace records
    // no observed values, and the joined rule (r1) prints `Conditions: None`.
    await expect(provenance.getByText("Conditions", { exact: true })).toBeVisible();
    await expect(provenance.getByText("None", { exact: true })).toBeVisible();
    await expect(provenance.getByText(/sex\s+equals/)).toHaveCount(0);

    await page.getByLabel("Rule id").fill("r1");
    await expect(page.getByText(`Showing 500 of ${FIXTURE_TOTAL} stored events.`)).toBeVisible();

    await page.getByLabel("Rule id").fill("unknown-rule");
    await expect(page.getByText(`Showing 500 of ${FIXTURE_TOTAL} stored events.`)).toBeVisible();
    await expect(provenance.getByText("Rule id not in mapping version", { exact: true })).toBeVisible();
    await expect(page.locator("#hb-trace-option-5")).toHaveAttribute("aria-selected", "true");
  });

  test("filters by issues and by record index", async ({ console: page }) => {
    await registerFixtureRoutes(page, FIXTURE_RUN_ID, "completed", FIXTURE_TRACES);
    await openDebugger(page, FIXTURE_RUN_ID);

    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toBeVisible();
    await page.getByLabel("Only events with issues").check();
    await expect(page.getByText(`Showing 50 of ${FIXTURE_TOTAL} stored events.`)).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText(`Showing ${FIXTURE_TOTAL} of ${FIXTURE_TOTAL} stored events.`)).toBeVisible();

    const recordInput = page.getByLabel("Record index (0-based)");
    await recordInput.fill("0");
    await recordInput.press("Tab");
    await expect(page.getByText(`Showing 1 of ${FIXTURE_TOTAL} stored events.`)).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Event 0" })).toBeVisible();
  });

  test("filters by status with a mixed-status fixture and narrowing counts", async ({ console: page }) => {
    const total = STATUS_TRACES.length;
    await registerFixtureRoutes(page, STATUS_RUN_ID, "completed", STATUS_TRACES);
    await openDebugger(page, STATUS_RUN_ID);

    // The options are the distinct stored statuses (plus the placeholder), not a fixed list.
    const expectedStatuses = [...new Set(STATUS_STAGES)].sort();
    await expect(page.locator("#dbg-status option")).toHaveText(["All statuses", ...expectedStatuses]);
    await expect(page.getByText(showingLine(total, total))).toBeVisible();

    // Each count is strictly below the total: removing status filtering cannot pass these.
    await page.locator("#dbg-status").selectOption("warning");
    await expect(page.getByText(showingLine(2, total))).toBeVisible();
    await page.locator("#dbg-status").selectOption("error");
    await expect(page.getByText(showingLine(1, total))).toBeVisible();
    await page.locator("#dbg-status").selectOption("success");
    await expect(page.getByText(showingLine(2, total))).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText(showingLine(total, total))).toBeVisible();
  });

  test("compares the two synthetic resources by array position, not expectation versus actual", async ({
    console: page,
  }) => {
    await registerFixtureRoutes(page, FIXTURE_RUN_ID, "completed", FIXTURE_TRACES);
    await openDebugger(page, FIXTURE_RUN_ID);

    await expect(page.getByRole("heading", { level: 2, name: "Event 0" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Resource and snippet diff" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Resource A", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Resource B", exact: true })).toBeVisible();
    await expect(page.getByText(/positions are array positions/)).toBeVisible();
    await expect(page.getByText(/not an expected-versus-actual diff/)).toBeVisible();

    const resourceTable = page.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "Resource A", exact: true }),
    });
    await expect(resourceTable).toBeVisible();
    await expect(
      resourceTable
        .getByRole("row")
        .filter({ hasText: /Added|Changed/ })
        .first(),
    ).toBeVisible();
  });

  test("describes unavailable traces truthfully and never opens an event stream", async ({ console: page }) => {
    const runningId = "run_fixture_running";
    const emptyId = "run_fixture_empty";
    await registerFixtureRoutes(page, runningId, "running", []);
    await registerFixtureRoutes(page, emptyId, "completed", []);

    const requested: string[] = [];
    page.on("request", (requestEvent) => requested.push(new URL(requestEvent.url()).pathname));

    await openDebugger(page, runningId);
    await expect(
      page.getByText(
        "Trace rows are written when the run settles; this run is running. Open run detail for live progress.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Trace filters" })).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(requested.filter((path) => path.endsWith("/events"))).toEqual([]);

    await clientNavigate(page, "/studio");
    await openDebugger(page, emptyId);
    await expect(page.getByText("This run settled without storing any trace rows.", { exact: true })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Stored trace events" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Trace filters" })).toHaveCount(0);
    expect(requested.filter((path) => path.endsWith("/events"))).toEqual([]);
  });
});
