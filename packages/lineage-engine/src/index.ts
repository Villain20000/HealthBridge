import type {
  DeclaredLineage,
  LineageEdge,
  LineageGraph,
  LineageNode,
  MappingDefinition,
  MappingRule,
} from "@healthbridge/shared-types";

export type { DeclaredLineage, LineageEdge, LineageGraph, LineageNode } from "@healthbridge/shared-types";

const DEFAULT_MAX_DECLARED_RULES = 500;
const MAX_DECLARED_RULES = 500;
const MAX_DECLARED_FIELD_NODES = 1_000;

export class LineageBuilder {
  public buildLineageFromTrace(
    sourceAssetId: string,
    sourceFormat: string,
    targetFormat: string,
    rules: Array<{ id: string; sourcePath: string; targetPath: string }>,
  ): LineageGraph {
    const nodes: LineageNode[] = [];
    const edges: LineageEdge[] = [];

    const sourceNodeId = `asset:${sourceAssetId}`;
    nodes.push({
      id: sourceNodeId,
      label: `Source (${sourceFormat})`,
      type: "source_asset",
      metadata: { assetId: sourceAssetId },
    });

    const targetNodeId = `target:${targetFormat}`;
    nodes.push({
      id: targetNodeId,
      label: `Target (${targetFormat})`,
      type: "target_resource",
    });

    rules.forEach((rule) => {
      const ruleNodeId = `rule:${rule.id}`;
      nodes.push({
        id: ruleNodeId,
        label: `${rule.sourcePath} ➔ ${rule.targetPath}`,
        type: "mapping_rule",
        metadata: { sourcePath: rule.sourcePath, targetPath: rule.targetPath },
      });

      edges.push({
        id: `edge:${sourceNodeId}->${ruleNodeId}`,
        sourceId: sourceNodeId,
        targetId: ruleNodeId,
        label: rule.sourcePath,
      });

      edges.push({
        id: `edge:${ruleNodeId}->${targetNodeId}`,
        sourceId: ruleNodeId,
        targetId: targetNodeId,
        label: rule.targetPath,
      });
    });

    return { nodes, edges };
  }
}

export interface DeclaredLineageInput {
  /** Mapping whose rules describe the declared lineage. */
  mapping: MappingDefinition;
  /** Emitted as a `source_asset` node when supplied. */
  sourceAssetId?: string;
  /** Emitted as an `adapter` node when supplied. */
  adapterId?: string;
  /** Maximum number of rules to include. Defaults to and is capped at 500. */
  maxRules?: number;
  /** Published mapping version when known; otherwise `mapping.version` is parsed. */
  version?: number;
}

interface IncludedRule {
  rule: MappingRule;
  nodeId: string;
}

function resolveVersion(input: DeclaredLineageInput): number {
  const explicit = input.version;
  if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0) return explicit;

  const parsed = Number.parseInt(input.mapping.version, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveMaxRules(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_DECLARED_RULES;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_DECLARED_RULES);
}

/**
 * Builds the declared lineage graph for a mapping. Everything here is a
 * declaration: `basis` is always `"declared"` and the graph never carries
 * observed per-rule counts, which are evidence rather than declaration.
 */
export function buildDeclaredLineage(input: DeclaredLineageInput): DeclaredLineage {
  const { mapping } = input;
  const maxRules = resolveMaxRules(input.maxRules);
  const includedRules = mapping.rules.slice(0, maxRules);

  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const sourceNodeIds = new Map<string, string>();
  const targetNodeIds = new Map<string, string>();

  let fieldNodeCount = 0;
  let truncated = mapping.rules.length > maxRules;

  /**
   * Registers one field node per distinct path. The 1,000-node cap is an
   * invariant guard: a node that would exceed it is omitted and the graph is
   * flagged as truncated, so the cap can never be violated.
   */
  const ensureFieldNode = (kind: "source" | "target", path: string): string | undefined => {
    const registry = kind === "source" ? sourceNodeIds : targetNodeIds;
    const existing = registry.get(path);
    if (existing !== undefined) return existing;

    if (fieldNodeCount >= MAX_DECLARED_FIELD_NODES) {
      truncated = true;
      return undefined;
    }

    const nodeId = `${kind}:${path}`;
    registry.set(path, nodeId);
    fieldNodeCount += 1;
    nodes.push({
      id: nodeId,
      label: path,
      type: kind === "source" ? "source_field" : "target_field",
      metadata: { path },
    });
    return nodeId;
  };

  if (input.sourceAssetId !== undefined) {
    nodes.push({
      id: `asset:${input.sourceAssetId}`,
      label: `Source asset ${input.sourceAssetId}`,
      type: "source_asset",
      metadata: { assetId: input.sourceAssetId },
    });
  }

  if (input.adapterId !== undefined) {
    nodes.push({
      id: `adapter:${input.adapterId}`,
      label: `Adapter ${input.adapterId}`,
      type: "adapter",
      metadata: { adapterId: input.adapterId },
    });
  }

  for (const rule of includedRules) ensureFieldNode("source", rule.sourcePath);

  const ruleNodes: IncludedRule[] = [];
  const usedRuleNodeIds = new Set<string>();

  for (const rule of includedRules) {
    // Duplicate rule ids get a deterministic suffix; metadata keeps the original id.
    const baseId = `rule:${rule.id}`;
    let nodeId = baseId;
    let suffix = 2;
    while (usedRuleNodeIds.has(nodeId)) {
      nodeId = `${baseId}#${suffix}`;
      suffix += 1;
    }
    usedRuleNodeIds.add(nodeId);

    nodes.push({
      id: nodeId,
      label: `${rule.sourcePath} ➔ ${rule.targetPath}`,
      type: "mapping_rule",
      metadata: {
        ruleId: rule.id,
        sourcePath: rule.sourcePath,
        targetPath: rule.targetPath,
        transform: rule.transform,
        conditionCount: rule.when?.length ?? 0,
        required: rule.required === true,
      },
    });
    ruleNodes.push({ rule, nodeId });
  }

  for (const rule of includedRules) ensureFieldNode("target", rule.targetPath);

  const targetResourceType = mapping.targetResourceType;
  if (typeof targetResourceType === "string" && targetResourceType.length > 0) {
    nodes.push({
      id: `resource:${targetResourceType}`,
      label: targetResourceType,
      type: "target_resource",
      metadata: { resourceType: targetResourceType },
    });
  }

  for (const { rule, nodeId } of ruleNodes) {
    const sourceId = sourceNodeIds.get(rule.sourcePath);
    if (sourceId !== undefined) {
      edges.push({
        id: `edge:${sourceId}->${nodeId}`,
        sourceId,
        targetId: nodeId,
        label: rule.transform,
      });
    }

    const targetId = targetNodeIds.get(rule.targetPath);
    if (targetId !== undefined) {
      edges.push({
        id: `edge:${nodeId}->${targetId}`,
        sourceId: nodeId,
        targetId,
        label: rule.targetPath,
      });
    }
  }

  return {
    name: mapping.name,
    mappingId: mapping.id,
    version: resolveVersion(input),
    basis: "declared",
    nodes,
    edges,
    rules: includedRules.map((rule) => ({
      ruleId: rule.id,
      sourcePath: rule.sourcePath,
      targetPath: rule.targetPath,
      transform: rule.transform,
      conditionCount: rule.when?.length ?? 0,
    })),
    truncated,
  };
}
