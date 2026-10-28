export interface LineageNode {
  id: string;
  label: string;
  type: "source_asset" | "adapter" | "mapping_rule" | "transformation_step" | "target_resource";
  metadata?: Record<string, unknown>;
}

export interface LineageEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export class LineageBuilder {
  public buildLineageFromTrace(
    sourceAssetId: string,
    sourceFormat: string,
    targetFormat: string,
    rules: Array<{ id: string; sourcePath: string; targetPath: string }>
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
