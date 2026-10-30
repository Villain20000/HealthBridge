/**
 * JSON inspection helpers for the Studio's payload views. Pure and dependency-free: the tree
 * needs stable, round-trippable paths and the diff needs a deterministic key order, while every
 * walk is depth-, breadth- and cycle-bounded so a hostile payload cannot hang the console.
 */

export interface JsonLeaf {
  path: string;
  value: unknown;
}

export interface JsonOptions {
  maxDepth?: number; // default 12
  maxArrayItems?: number; // default 200
  maxEntries?: number; // default 5000
  maxChanges?: number; // default 500; only diffJson uses it
}

export type JsonChangeKind = "added" | "removed" | "changed";

export interface JsonChange {
  path: string;
  kind: JsonChangeKind;
  left?: unknown;
  right?: unknown;
}

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ARRAY_ITEMS = 200;
const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_CHANGES = 500;

const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;
const CIRCULAR_MESSAGE = "Cannot serialise circular structure";

interface JsonLimits {
  maxDepth: number;
  maxArrayItems: number;
  maxEntries: number;
  maxChanges: number;
}

interface FlattenState extends JsonLimits {
  leaves: JsonLeaf[];
  truncated: boolean;
}

interface DiffState extends JsonLimits {
  changes: JsonChange[];
  unchanged: number;
  truncated: boolean;
  stopped: boolean;
  processed: number;
}

function resolveLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function resolveLimits(options?: JsonOptions): JsonLimits {
  return {
    maxDepth: resolveLimit(options?.maxDepth, DEFAULT_MAX_DEPTH),
    maxArrayItems: resolveLimit(options?.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS),
    maxEntries: resolveLimit(options?.maxEntries, DEFAULT_MAX_ENTRIES),
    maxChanges: resolveLimit(options?.maxChanges, DEFAULT_MAX_CHANGES),
  };
}

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function containerKind(value: unknown): "array" | "object" | "scalar" {
  if (!isContainer(value)) return "scalar";
  return Array.isArray(value) ? "array" : "object";
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function escapeKey(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
}

/** Builds the dotted path format consumed by `getByPath` (object keys escaped, indices raw). */
export function jsonPath(parent: string, segment: string | number): string {
  const encoded = typeof segment === "number" ? String(segment) : escapeKey(segment);
  return parent === "" ? encoded : `${parent}.${encoded}`;
}

function childKeyPath(path: string, key: string): string {
  return jsonPath(path, key);
}

function childIndexPath(path: string, index: number): string {
  return jsonPath(path, index);
}

function parsePath(path: string): string[] {
  const segments: string[] = [];
  let segment = "";
  for (let index = 0; index < path.length; index += 1) {
    const character = path[index];
    if (character === "\\" && index + 1 < path.length) {
      index += 1;
      segment += path[index];
    } else if (character === ".") {
      segments.push(segment);
      segment = "";
    } else {
      segment += character;
    }
  }
  segments.push(segment);
  return segments;
}

function stringifyPrimitive(value: string | number): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/**
 * `getByPath` walks the dotted path format emitted by `flattenJson` and `diffJson`, so a leaf
 * selected in the tree can always be located again in the original payload.
 */
export function getByPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current: unknown = value;
  for (const segment of parsePath(path)) {
    if (!isContainer(current)) return undefined;
    if (Array.isArray(current)) {
      if (!CANONICAL_INDEX.test(segment) || !hasOwn(current, segment)) return undefined;
      current = current[Number(segment)];
    } else {
      if (!hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/**
 * Deterministic JSON used for equality and stable export: sorted keys, no `toJSON` hooks, and
 * `null` for values JSON cannot represent. Circular structures are rejected instead of hung on.
 */
export function canonicalJson(value: unknown): string {
  return serialiseJson(value, new Set<object>());
}

function serialiseJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) return "null";
      return Object.is(value, -0) ? "0" : stringifyPrimitive(value);
    case "string":
      return stringifyPrimitive(value);
    case "bigint":
      throw new TypeError("Cannot serialise BigInt");
    case "object":
      return serialiseContainer(value, ancestors);
    default:
      return "null";
  }
}

function serialiseContainer(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new TypeError(CIRCULAR_MESSAGE);
  ancestors.add(value);
  let output: string;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    const parts: string[] = [];
    for (let index = 0; index < items.length; index += 1) {
      parts.push(serialiseJson(items[index], ancestors));
    }
    output = `[${parts.join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      const kind = typeof entry;
      if (kind === "undefined" || kind === "function" || kind === "symbol") continue;
      parts.push(`${stringifyPrimitive(key)}:${serialiseJson(entry, ancestors)}`);
    }
    output = `{${parts.join(",")}}`;
  }
  ancestors.delete(value);
  return output;
}

/**
 * Flattens a payload into leaf paths for the JSON tree's virtual list. `truncated` is the UI's
 * signal that hidden data exists, so every cap and cycle records it rather than silently
 * dropping rows.
 */
export function flattenJson(value: unknown, options?: JsonOptions): { leaves: JsonLeaf[]; truncated: boolean } {
  const state: FlattenState = { ...resolveLimits(options), leaves: [], truncated: false };
  flattenValue(value, 0, "", new Set<object>(), state);
  return { leaves: state.leaves, truncated: state.truncated };
}

function pushLeaf(path: string, value: unknown, state: FlattenState): boolean {
  if (state.leaves.length >= state.maxEntries) {
    state.truncated = true;
    return false;
  }
  state.leaves.push({ path, value });
  return true;
}

function flattenValue(
  value: unknown,
  depth: number,
  path: string,
  ancestors: Set<object>,
  state: FlattenState,
): boolean {
  if (!isContainer(value)) return pushLeaf(path, value, state);
  if (ancestors.has(value)) {
    state.truncated = true;
    return true;
  }
  const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
  if (empty) return pushLeaf(path, value, state);
  if (depth >= state.maxDepth) {
    state.truncated = true;
    return true;
  }
  ancestors.add(value);
  let keepGoing = true;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (items.length > state.maxArrayItems) state.truncated = true;
    const limit = Math.min(items.length, state.maxArrayItems);
    for (let index = 0; index < limit && keepGoing; index += 1) {
      keepGoing = flattenValue(items[index], depth + 1, childIndexPath(path, index), ancestors, state);
    }
  } else {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!keepGoing) break;
      keepGoing = flattenValue(record[key], depth + 1, childKeyPath(path, key), ancestors, state);
    }
  }
  ancestors.delete(value);
  return keepGoing;
}

/**
 * Structural diff for the Studio's side-by-side view. It compares both sides in lockstep and
 * stops on the same caps as flattening, so even enormous payloads produce a bounded, ordered
 * change list instead of locking the UI.
 */
export function diffJson(
  left: unknown,
  right: unknown,
  options?: JsonOptions,
): { changes: JsonChange[]; truncated: boolean; unchanged: number } {
  const state: DiffState = {
    ...resolveLimits(options),
    changes: [],
    unchanged: 0,
    truncated: false,
    stopped: false,
    processed: 0,
  };
  compareJson(left, right, "", 0, new Set<object>(), new Set<object>(), state);
  return { changes: state.changes, truncated: state.truncated, unchanged: state.unchanged };
}

function enterComparedPath(state: DiffState): boolean {
  if (state.processed >= state.maxEntries) {
    state.truncated = true;
    state.stopped = true;
    return false;
  }
  state.processed += 1;
  return true;
}

function recordChange(state: DiffState, change: JsonChange): void {
  if (state.changes.length >= state.maxChanges) {
    state.truncated = true;
    state.stopped = true;
    return;
  }
  state.changes.push(change);
}

function scalarsEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return left === right || (Number.isNaN(left) && Number.isNaN(right));
  }
  return Object.is(left, right);
}

function compareCanonical(left: unknown, right: unknown, path: string, state: DiffState): void {
  let leftJson: string;
  let rightJson: string;
  try {
    leftJson = canonicalJson(left);
    rightJson = canonicalJson(right);
  } catch (error) {
    if (error instanceof TypeError) {
      state.truncated = true;
      return;
    }
    throw error;
  }
  if (leftJson === rightJson) {
    state.unchanged += 1;
  } else {
    recordChange(state, { path, kind: "changed", left, right });
  }
}

function compareJson(
  left: unknown,
  right: unknown,
  path: string,
  depth: number,
  leftAncestors: Set<object>,
  rightAncestors: Set<object>,
  state: DiffState,
): void {
  if (state.stopped) return;
  if (!enterComparedPath(state)) return;
  if (depth >= state.maxDepth) {
    compareCanonical(left, right, path, state);
    return;
  }
  if (isContainer(left) && leftAncestors.has(left)) {
    state.truncated = true;
    return;
  }
  if (isContainer(right) && rightAncestors.has(right)) {
    state.truncated = true;
    return;
  }
  const kind = containerKind(left);
  if (kind !== containerKind(right)) {
    recordChange(state, { path, kind: "changed", left, right });
    return;
  }
  if (kind === "scalar") {
    if (scalarsEqual(left, right)) state.unchanged += 1;
    else recordChange(state, { path, kind: "changed", left, right });
    return;
  }
  if (kind === "array") {
    compareArrays(left as unknown[], right as unknown[], path, depth, leftAncestors, rightAncestors, state);
    return;
  }
  compareObjects(
    left as Record<string, unknown>,
    right as Record<string, unknown>,
    path,
    depth,
    leftAncestors,
    rightAncestors,
    state,
  );
}

function compareArrays(
  left: unknown[],
  right: unknown[],
  path: string,
  depth: number,
  leftAncestors: Set<object>,
  rightAncestors: Set<object>,
  state: DiffState,
): void {
  const span = Math.max(left.length, right.length);
  if (span > state.maxArrayItems) state.truncated = true;
  const limit = Math.min(span, state.maxArrayItems);
  if (limit === 0) {
    if (span === 0) state.unchanged += 1;
    return;
  }
  leftAncestors.add(left);
  rightAncestors.add(right);
  for (let index = 0; index < limit; index += 1) {
    if (state.stopped) break;
    if (index >= right.length) {
      if (!enterComparedPath(state)) break;
      recordChange(state, { path: childIndexPath(path, index), kind: "removed", left: left[index] });
    } else if (index >= left.length) {
      if (!enterComparedPath(state)) break;
      recordChange(state, { path: childIndexPath(path, index), kind: "added", right: right[index] });
    } else {
      compareJson(
        left[index],
        right[index],
        childIndexPath(path, index),
        depth + 1,
        leftAncestors,
        rightAncestors,
        state,
      );
    }
  }
  leftAncestors.delete(left);
  rightAncestors.delete(right);
}

function compareObjects(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  path: string,
  depth: number,
  leftAncestors: Set<object>,
  rightAncestors: Set<object>,
  state: DiffState,
): void {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length === 0 && rightKeys.length === 0) {
    state.unchanged += 1;
    return;
  }
  leftAncestors.add(left);
  rightAncestors.add(right);
  for (const key of leftKeys) {
    if (state.stopped) break;
    if (hasOwn(right, key)) {
      compareJson(left[key], right[key], childKeyPath(path, key), depth + 1, leftAncestors, rightAncestors, state);
    } else {
      if (!enterComparedPath(state)) break;
      recordChange(state, { path: childKeyPath(path, key), kind: "removed", left: left[key] });
    }
  }
  if (!state.stopped) {
    for (const key of rightKeys) {
      if (hasOwn(left, key)) continue;
      if (!enterComparedPath(state)) break;
      recordChange(state, { path: childKeyPath(path, key), kind: "added", right: right[key] });
    }
  }
  leftAncestors.delete(left);
  rightAncestors.delete(right);
}
