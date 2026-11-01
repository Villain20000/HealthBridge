/**
 * Lineage presentation logic.
 *
 * Pure and framework-free so it is unit-testable with `node:test` (see
 * `apps/web/test/lineage.test.ts`). It derives a read-only field-lineage graph from
 * already-stored rows — `StoredTrace[]` from `GET /runs/:id/traces`, the run's stored
 * `coverage` from `GET /runs/:id`, top-level fields of `GET /runs/:id/resources`, and the
 * run mapping version's declared rules — and never calls the API itself.
 *
 * Honesty rules, following `docs/planned/data-lineage.md`:
 * - every edge is either backed by at least one stored trace event (with the event seqs
 *   kept as evidence) or explicitly labelled as declared-only;
 * - unmapped source fields and rejected values are first-class `dropped` nodes, taken only
 *   from stored evidence (coverage reports, error-status trace events) — never guessed;
 * - malformed payloads degrade to an empty graph, never throw.
 */

export type LineageNodeKind = "source" | "transform" | "target" | "dropped";

export interface LineageNode {
  /** Stable identity, e.g. `src:family_name`, `xf:r3`, `tgt:name.0.family`. */
  id: string;
  kind: LineageNodeKind;
  /** Human label, e.g. the field path or `r3 (identity)`. */
  label: string;
  /** Why a dropped node exists; null for every other kind. */
  reason: string | null;
  /** Stored trace seqs that mention this node, ascending, unique. */
  evidence: number[];
}

export interface LineageEdge {
  /** Stable identity, e.g. `src:sex->xf:r5`. */
  id: string;
  from: string;
  to: string;
  /** Transform kind on rule edges; a stored-traces disclaimer otherwise. */
  label: string;
  /** True exactly when at least one stored trace event backs this edge. */
  observed: boolean;
  /** Stored trace seqs backing this edge, ascending, unique. */
  evidence: number[];
  /**
   * True when the stored run coverage lists the edge's source field as consumed by the
   * run's mapping. Weaker than `observed` (coverage names the field, not the rule), so it
   * is only set when exactly one declared rule reads that source field.
   */
  coverageBacked: boolean;
  /** Set only on declared-only edges, so they can never read as observed. */
  note: string | null;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  summary: {
    sources: number;
    transforms: number;
    targets: number;
    dropped: number;
    observedEdges: number;
    coverageBackedEdges: number;
    declaredOnlyEdges: number;
    traceEvents: number;
  };
}

/** Exact stored-traces wording rendered by the page; never a live-execution claim. */
export const STORED_LINEAGE_NOTICE =
  "Built client-side from stored traces and stored resources for this run — never a live execution.";

export const EMPTY_LINEAGE_MESSAGE =
  "This run stored no trace field pairs, mapping rules, or coverage fields to build lineage from.";

/** Label for an edge whose transform kind the stored traces did not record. */
export const UNRECORDED_TRANSFORM_LABEL = "transform not recorded in stored trace";

/** Chip tone per node kind, reusing the global `.chip` tones. */
export function nodeTone(kind: LineageNodeKind): "info" | "muted" | "ok" | "warn" {
  switch (kind) {
    case "source":
      return "info";
    case "transform":
      return "muted";
    case "target":
      return "ok";
    case "dropped":
      return "warn";
  }
}

/** Guards for the untrusted stored payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanSeq(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

interface DeclaredRule {
  id: string;
  sourcePath: string;
  targetPath: string;
  transform: string | null;
}

function declaredRules(mappingSpec: unknown): DeclaredRule[] {
  if (!isRecord(mappingSpec)) return [];
  const raw = mappingSpec["rules"];
  if (!Array.isArray(raw)) return [];
  const rules: DeclaredRule[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = cleanPath(entry["id"]);
    const sourcePath = cleanPath(entry["sourcePath"]);
    const targetPath = cleanPath(entry["targetPath"]);
    if (id === null || sourcePath === null || targetPath === null || seen.has(id)) continue;
    seen.add(id);
    const transform = cleanPath(entry["transform"]);
    rules.push({ id, sourcePath, targetPath, transform });
  }
  return rules;
}

interface ObservedEvent {
  seq: number | null;
  ruleId: string | null;
  sourcePath: string | null;
  targetPath: string | null;
  status: string | null;
}

function observedEvents(traces: unknown): ObservedEvent[] {
  if (!Array.isArray(traces)) return [];
  const events: ObservedEvent[] = [];
  for (const row of traces) {
    if (!isRecord(row)) continue;
    const payload = isRecord(row["payload"]) ? row["payload"] : undefined;
    const pick = (key: string): unknown => payload?.[key] ?? row[key];
    events.push({
      seq: cleanSeq(row["seq"]),
      ruleId: cleanPath(pick("ruleId")),
      sourcePath: cleanPath(pick("sourcePath")),
      targetPath: cleanPath(pick("targetPath")),
      status: cleanPath(pick("status")),
    });
  }
  return events;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const path = cleanPath(entry);
    if (path !== null && !out.includes(path)) out.push(path);
  }
  return out;
}

function coverageFields(coverage: unknown): { unmapped: string[]; rejected: string[] } {
  if (!isRecord(coverage)) return { unmapped: [], rejected: [] };
  return {
    unmapped: stringList(coverage["unmappedSourceFields"]),
    rejected: stringList(coverage["rejectedFieldPaths"]),
  };
}

const MAX_RESOURCE_TARGET_FIELDS = 200;

/**
 * Top-level `resourceType.field` names observed in the stored resources. Only the first
 * level of each resource's data is read, capped so a huge run cannot blow up the graph;
 * anything unexpected yields no fields rather than a throw.
 */
export function targetFieldsFromResources(resources: unknown): string[] {
  try {
    const list = isRecord(resources) && Array.isArray(resources["resources"]) ? resources["resources"] : resources;
    if (!Array.isArray(list)) return [];
    const fields: string[] = [];
    for (const item of list) {
      if (fields.length >= MAX_RESOURCE_TARGET_FIELDS) break;
      if (!isRecord(item)) continue;
      const resourceType = cleanPath(item["resourceType"]) ?? "Resource";
      const data = isRecord(item["data"]) ? item["data"] : item;
      for (const key of Object.keys(data)) {
        if (key === "resourceType" || key === "id" || key === "data") continue;
        const field = `${resourceType}.${key}`;
        if (!fields.includes(field)) fields.push(field);
        if (fields.length >= MAX_RESOURCE_TARGET_FIELDS) break;
      }
    }
    return fields;
  } catch {
    return [];
  }
}

export interface LineageInput {
  traces: unknown;
  coverage?: unknown;
  mappingSpec?: unknown;
  resources?: unknown;
}

function pushUnique(target: number[], seq: number | null): void {
  if (seq === null || target.includes(seq)) return;
  target.push(seq);
}

/**
 * Builds the lineage graph. Never throws: any malformed input degrades to an empty graph
 * and the page renders its empty state instead of inventing lineage.
 */
export function buildLineageGraph(input: LineageInput): LineageGraph {
  try {
    return buildGraph(input);
  } catch {
    return emptyGraph(0);
  }
}

function emptyGraph(traceEvents: number): LineageGraph {
  return {
    nodes: [],
    edges: [],
    summary: {
      sources: 0,
      transforms: 0,
      targets: 0,
      dropped: 0,
      observedEdges: 0,
      coverageBackedEdges: 0,
      declaredOnlyEdges: 0,
      traceEvents,
    },
  };
}

function buildGraph(input: LineageInput): LineageGraph {
  const events = observedEvents(input.traces);
  const rules = declaredRules(input.mappingSpec);
  const coverage = coverageFields(input.coverage);
  const resourceFields = targetFieldsFromResources(input.resources);

  const nodes = new Map<string, LineageNode>();
  const ensureNode = (id: string, kind: LineageNodeKind, label: string, reason: string | null): LineageNode => {
    const existing = nodes.get(id);
    if (existing) {
      if (existing.reason === null && reason !== null) existing.reason = reason;
      return existing;
    }
    const node: LineageNode = { id, kind, label, reason, evidence: [] };
    nodes.set(id, node);
    return node;
  };

  const byRuleId = new Map<string, DeclaredRule>();
  for (const rule of rules) byRuleId.set(rule.id, rule);

  // Declared skeleton: source field -> transform rule -> target field.
  for (const rule of rules) {
    ensureNode(`src:${rule.sourcePath}`, "source", rule.sourcePath, null);
    ensureNode(
      `xf:${rule.id}`,
      "transform",
      rule.transform === null ? `${rule.id} (transform not recorded)` : `${rule.id} (${rule.transform})`,
      null,
    );
    ensureNode(`tgt:${rule.targetPath}`, "target", rule.targetPath, null);
  }

  // Observed rule ids that the run's mapping version does not declare still get a
  // transform node, so the graph never silently drops stored evidence.
  for (const event of events) {
    if (event.ruleId !== null && !byRuleId.has(event.ruleId)) {
      ensureNode(`xf:${event.ruleId}`, "transform", `${event.ruleId} (not in run mapping version)`, null);
    }
    if (event.sourcePath !== null) {
      const node = ensureNode(`src:${event.sourcePath}`, "source", event.sourcePath, null);
      pushUnique(node.evidence, event.seq);
    }
    if (event.targetPath !== null) {
      const node = ensureNode(`tgt:${event.targetPath}`, "target", event.targetPath, null);
      pushUnique(node.evidence, event.seq);
    }
  }

  // Stored resources contribute target fields observed in the run output.
  for (const field of resourceFields) {
    ensureNode(`tgt:${field}`, "target", field, null);
  }

  // Dropped values are first-class nodes, only from stored evidence.
  for (const path of coverage.unmapped) {
    ensureNode(
      `dropped:${path}`,
      "dropped",
      path,
      "Unmapped — no rule in the run mapping version consumed this field.",
    );
  }
  for (const path of coverage.rejected) {
    ensureNode(
      `dropped:${path}`,
      "dropped",
      path,
      "Rejected — a transform consumed this field but rejected its value.",
    );
  }
  for (const event of events) {
    if (event.status === "error" && event.sourcePath !== null && event.targetPath === null) {
      const node = ensureNode(
        `dropped:${event.sourcePath}`,
        "dropped",
        event.sourcePath,
        "Recorded with an error status and no target field in the stored trace.",
      );
      pushUnique(node.evidence, event.seq);
    }
  }

  const edges = new Map<string, LineageEdge>();
  const ensureEdge = (id: string, from: string, to: string, label: string): LineageEdge => {
    const existing = edges.get(id);
    if (existing) return existing;
    const edge: LineageEdge = { id, from, to, label, observed: false, evidence: [], coverageBacked: false, note: null };
    edges.set(id, edge);
    return edge;
  };

  // Stored coverage names consumed source fields, not rules: it only backs a rule edge when
  // exactly one declared rule reads that source field, so shared sources stay declared-only.
  const coverageMapped = new Set(stringList(isRecord(input.coverage) ? input.coverage["mappedFieldPaths"] : undefined));
  const readersBySource = new Map<string, number>();
  for (const rule of rules) readersBySource.set(rule.sourcePath, (readersBySource.get(rule.sourcePath) ?? 0) + 1);

  // Evidence index: which stored events back which (source, target, rule) triple.
  const evidenceByRule = new Map<string, number[]>();
  const evidenceByPair = new Map<string, number[]>();
  for (const event of events) {
    if (event.seq === null) continue;
    if (event.ruleId !== null) {
      const list = evidenceByRule.get(event.ruleId) ?? [];
      if (!list.includes(event.seq)) list.push(event.seq);
      evidenceByRule.set(event.ruleId, list);
    }
    if (event.sourcePath !== null && event.targetPath !== null) {
      const key = `${event.sourcePath} ${event.targetPath} ${event.ruleId ?? ""}`;
      const list = evidenceByPair.get(key) ?? [];
      if (!list.includes(event.seq)) list.push(event.seq);
      evidenceByPair.set(key, list);
    }
  }

  const ruleObserved = (rule: DeclaredRule): number[] => {
    const seqs = new Set<number>();
    for (const seq of evidenceByRule.get(rule.id) ?? []) seqs.add(seq);
    for (const [key, list] of evidenceByPair) {
      const [source, target] = key.split(" ");
      if (source === rule.sourcePath && target === rule.targetPath) {
        for (const seq of list) seqs.add(seq);
      }
    }
    return [...seqs].sort((a, b) => a - b);
  };

  // Declared edges: stored trace events first, stored run coverage second, and an explicit
  // declared-only label when neither backs the edge.
  for (const rule of rules) {
    const seqs = ruleObserved(rule);
    const backed =
      seqs.length === 0 && coverageMapped.has(rule.sourcePath) && readersBySource.get(rule.sourcePath) === 1;
    const readEdge = ensureEdge(
      `src:${rule.sourcePath}->xf:${rule.id}`,
      `src:${rule.sourcePath}`,
      `xf:${rule.id}`,
      "reads",
    );
    const writeEdge = ensureEdge(
      `xf:${rule.id}->tgt:${rule.targetPath}`,
      `xf:${rule.id}`,
      `tgt:${rule.targetPath}`,
      rule.transform ?? UNRECORDED_TRANSFORM_LABEL,
    );
    if (seqs.length > 0) {
      for (const edge of [readEdge, writeEdge]) {
        edge.observed = true;
        for (const seq of seqs) pushUnique(edge.evidence, seq);
      }
    } else if (backed) {
      for (const edge of [readEdge, writeEdge]) edge.coverageBacked = true;
    } else {
      for (const edge of [readEdge, writeEdge]) {
        edge.observed = false;
        edge.note = "Declared in the run's mapping version; no stored trace event observed it.";
      }
    }
  }

  // Observed pairs with no declared rule: direct edges backed by stored traces.
  for (const [key, seqs] of evidenceByPair) {
    const [source, target, ruleId] = key.split(" ");
    const declared = ruleId !== "" ? byRuleId.get(ruleId) : undefined;
    if (declared && declared.sourcePath === source && declared.targetPath === target) continue;
    if (ruleId === "") {
      const matching = rules.filter((rule) => rule.sourcePath === source && rule.targetPath === target);
      if (matching.length === 1 && matching[0] !== undefined) continue;
    }
    if (source === undefined || target === undefined || source === "" || target === "") continue;
    const edge = ensureEdge(
      `src:${source}->tgt:${target}`,
      `src:${source}`,
      `tgt:${target}`,
      UNRECORDED_TRANSFORM_LABEL,
    );
    edge.observed = true;
    for (const seq of seqs) pushUnique(edge.evidence, seq);
  }

  // Chronological evidence order per node.
  for (const node of nodes.values()) node.evidence.sort((a, b) => a - b);

  const nodeList = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edgeList = [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let observedEdges = 0;
  let coverageBackedEdges = 0;
  for (const edge of edgeList) {
    if (edge.observed) observedEdges += 1;
    else if (edge.coverageBacked) coverageBackedEdges += 1;
  }

  return {
    nodes: nodeList,
    edges: edgeList,
    summary: {
      sources: nodeList.filter((node) => node.kind === "source").length,
      transforms: nodeList.filter((node) => node.kind === "transform").length,
      targets: nodeList.filter((node) => node.kind === "target").length,
      dropped: nodeList.filter((node) => node.kind === "dropped").length,
      observedEdges,
      coverageBackedEdges,
      declaredOnlyEdges: edgeList.length - observedEdges - coverageBackedEdges,
      traceEvents: events.length,
    },
  };
}

/**
 * Backing label for one edge, shared by the page and pinned here: stored trace seqs first,
 * stored run coverage second, and the declared-only disclaimer otherwise — never a bare
 * "observed" claim without evidence.
 */
export function edgeBackingLabel(edge: LineageEdge): string {
  if (!isRecord(edge)) return "Declared in the run's mapping version; no stored trace event observed it.";
  if (edge.observed) return `stored trace seq ${edge.evidence.join(", ")}`;
  if (edge.coverageBacked) return "stored run coverage: source field consumed by the run's mapping";
  if (typeof edge.note === "string" && edge.note.length > 0) return edge.note;
  return "Declared in the run's mapping version; no stored trace event observed it.";
}

/** Nodes of one kind, in graph order, for the column layout. */
export function nodesOfKind(graph: LineageGraph, kind: LineageNodeKind): LineageNode[] {
  if (!isRecord(graph) || !Array.isArray((graph as { nodes?: unknown }).nodes)) return [];
  return (graph as LineageGraph).nodes.filter((node) => node.kind === kind);
}
