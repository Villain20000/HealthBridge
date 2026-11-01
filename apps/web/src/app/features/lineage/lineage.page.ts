import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, ResourceItem, Run, StoredTrace } from "../../core/api-types";
import { isTerminalStatus, pluralize } from "../../core/format";
import { EmptyState, ErrorPanel, LoadingState, StatusChip } from "../../ui/primitives";
import {
  EMPTY_LINEAGE_MESSAGE,
  STORED_LINEAGE_NOTICE,
  buildLineageGraph,
  edgeBackingLabel,
  nodeTone,
  nodesOfKind,
  type LineageNode,
} from "./lineage.logic";

/**
 * Data lineage: read-only rendering of a stored run's field lineage.
 *
 * The graph is built client-side from stored rows only — `GET /runs/:id` (run coverage),
 * `GET /runs/:id/traces`, `GET /runs/:id/resources`, and the run mapping version via
 * `GET /mappings/:id`. It never submits, re-executes, replays or cancels anything; the
 * only action is Refresh (re-reads the same stored rows). Stored results are labelled as
 * stored; nothing here is a live execution.
 */
@Component({
  selector: "hb-lineage",
  standalone: true,
  imports: [RouterLink, StatusChip, ErrorPanel, EmptyState, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1 style="font-size: 17px">Data lineage</h1>
        <p>
          Stored field lineage for run <span class="mono">{{ runId() }}</span> · read-only. {{ notice }}
        </p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
        <a class="button small" [routerLink]="['/runs', runId()]">Back to run detail</a>
        <a class="button small" routerLink="/runs">All runs</a>
      </div>
    </div>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && !run()) {
      <hb-loading label="Loading stored lineage…" />
    }

    @if (run(); as current) {
      <div class="grid cols-4">
        <div class="card">
          <div class="stat">
            <span class="label">Source fields</span>
            <span class="value">{{ graph().summary.sources }}</span>
            <span class="hint">stored trace + mapping version</span>
          </div>
        </div>
        <div class="card">
          <div class="stat">
            <span class="label">Transform rules</span>
            <span class="value">{{ graph().summary.transforms }}</span>
            <span class="hint"
              >{{ graph().summary.observedEdges }} observed ·
              {{ graph().summary.coverageBackedEdges }} coverage-backed</span
            >
          </div>
        </div>
        <div class="card">
          <div class="stat">
            <span class="label">Target fields</span>
            <span class="value">{{ graph().summary.targets }}</span>
            <span class="hint">stored traces, rules, resources</span>
          </div>
        </div>
        <div class="card">
          <div class="stat">
            <span class="label">Dropped</span>
            <span class="value">{{ graph().summary.dropped }}</span>
            <span class="hint">unmapped or rejected, from stored rows</span>
          </div>
        </div>
      </div>

      <div style="height: 16px"></div>

      <div class="card" style="margin-bottom: 16px">
        <div class="stat">
          <span class="label">Run status</span>
          <span class="value" style="font-size: 15px"><hb-status-chip [status]="current.status" /></span>
          <span class="hint">{{ availability() }}</span>
        </div>
      </div>

      @if (graph().nodes.length === 0) {
        <hb-empty title="No lineage stored" [message]="emptyMessage" />
      } @else {
        <section class="card lineage-columns" aria-label="Lineage graph" style="margin-bottom: 16px">
          <h2>Field graph</h2>
          <p class="card-sub">
            Source fields on the left flow through transform rules into target fields. Dropped values are listed below —
            never hidden. Select a node to see its stored evidence.
          </p>
          <div class="columns">
            <div>
              <h3>Source fields</h3>
              <ul class="nodes">
                @for (node of sourceNodes(); track node.id) {
                  <li>
                    <button
                      type="button"
                      class="small node"
                      [class.selected]="selectedId() === node.id"
                      (click)="select(node.id)"
                    >
                      <span class="chip" [class]="tone(node.kind)">{{ node.kind }}</span>
                      <span class="mono">{{ node.label }}</span>
                    </button>
                  </li>
                }
              </ul>
            </div>
            <div>
              <h3>Transform rules</h3>
              <ul class="nodes">
                @for (node of transformNodes(); track node.id) {
                  <li>
                    <button
                      type="button"
                      class="small node"
                      [class.selected]="selectedId() === node.id"
                      (click)="select(node.id)"
                    >
                      <span class="chip" [class]="tone(node.kind)">{{ node.kind }}</span>
                      <span class="mono">{{ node.label }}</span>
                    </button>
                  </li>
                }
              </ul>
            </div>
            <div>
              <h3>Target fields</h3>
              <ul class="nodes">
                @for (node of targetNodes(); track node.id) {
                  <li>
                    <button
                      type="button"
                      class="small node"
                      [class.selected]="selectedId() === node.id"
                      (click)="select(node.id)"
                    >
                      <span class="chip" [class]="tone(node.kind)">{{ node.kind }}</span>
                      <span class="mono">{{ node.label }}</span>
                    </button>
                  </li>
                }
              </ul>
            </div>
          </div>

          @if (selected(); as node) {
            <div class="selection" role="status">
              <h3>Selected field</h3>
              <p>
                <span class="chip" [class]="tone(node.kind)">{{ node.kind }}</span>
                <span class="mono"> {{ node.label }}</span>
              </p>
              @if (node.reason) {
                <p class="subtle">{{ node.reason }}</p>
              }
              <p class="subtle">{{ evidenceLabel(node) }}</p>
            </div>
          }
        </section>

        @if (droppedNodes().length > 0) {
          <section class="card" style="margin-bottom: 16px" aria-labelledby="lineage-dropped-heading">
            <h2 id="lineage-dropped-heading">Dropped values</h2>
            <p class="card-sub">Unmapped source fields and rejected values, each from a stored row.</p>
            <div class="table-wrap">
              <table aria-label="Dropped values">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Reason</th>
                    <th>Stored evidence</th>
                  </tr>
                </thead>
                <tbody>
                  @for (node of droppedNodes(); track node.id) {
                    <tr>
                      <td class="mono">{{ node.label }}</td>
                      <td>{{ node.reason ?? "Recorded as dropped in the stored rows." }}</td>
                      <td class="mono">{{ evidenceText(node) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <section class="card" aria-labelledby="lineage-edges-heading">
          <h2 id="lineage-edges-heading">Edges</h2>
          <p class="card-sub">
            Every edge is backed by stored trace events, or labelled declared-only. The edge table alone answers where
            each target field came from and what was lost.
          </p>
          <div class="table-wrap">
            <table aria-label="Lineage edges">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Transform</th>
                  <th>To</th>
                  <th>Backing</th>
                </tr>
              </thead>
              <tbody>
                @for (edge of graph().edges; track edge.id) {
                  <tr>
                    <td class="mono">{{ shortId(edge.from) }}</td>
                    <td class="mono">{{ edge.label }}</td>
                    <td class="mono">{{ shortId(edge.to) }}</td>
                    <td>{{ backingLabel(edge) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pager">{{ pluralize(graph().edges.length, "edge") }} · stored result, not a live execution</div>
        </section>
      }
    }
  `,
  styles: `
    .lineage-columns .columns {
      display: grid;
      gap: var(--space-3);
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    .nodes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      max-height: 320px;
      overflow: auto;
    }

    .node {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      text-align: left;
      font-weight: 400;
    }

    .node.selected {
      border-color: var(--accent);
    }

    .selection {
      margin-top: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-inset);
    }

    .selection h3 {
      margin-bottom: var(--space-2);
    }

    .selection p {
      margin: 0 0 var(--space-1);
    }
  `,
})
export class LineagePage {
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);

  protected readonly runId = signal(this.route.snapshot.paramMap.get("runId") ?? "");
  protected readonly run = signal<Run | null>(null);
  protected readonly traces = signal<StoredTrace[]>([]);
  protected readonly resources = signal<ResourceItem[]>([]);
  protected readonly mappingSpec = signal<unknown>(null);
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly selectedId = signal<string | null>(null);

  protected readonly notice = STORED_LINEAGE_NOTICE;
  protected readonly emptyMessage = EMPTY_LINEAGE_MESSAGE;
  protected readonly pluralize = pluralize;

  protected readonly graph = computed(() =>
    buildLineageGraph({
      traces: this.traces(),
      coverage: this.run()?.coverage,
      mappingSpec: this.mappingSpec(),
      resources: { resources: this.resources() },
    }),
  );

  protected readonly sourceNodes = computed(() => nodesOfKind(this.graph(), "source"));
  protected readonly transformNodes = computed(() => nodesOfKind(this.graph(), "transform"));
  protected readonly targetNodes = computed(() => nodesOfKind(this.graph(), "target"));
  protected readonly droppedNodes = computed(() => nodesOfKind(this.graph(), "dropped"));

  protected readonly selected = computed<LineageNode | null>(() => {
    const id = this.selectedId();
    if (id === null) return null;
    return this.graph().nodes.find((node) => node.id === id) ?? null;
  });

  protected readonly availability = computed(() => {
    const current = this.run();
    if (!current) return "stored result, not a live execution";
    if (isTerminalStatus(current.status)) return "stored result, not a live execution";
    return `This run is still ${current.status}; the stored trace may be partial — stored result, not a live execution.`;
  });

  constructor() {
    this.reload();
  }

  protected reload(): void {
    this.loading.set(true);
    this.problem.set(null);
    this.api.getRun(this.runId()).subscribe({
      next: (run) => {
        this.run.set(run);
        this.loading.set(false);
        this.loadTraces();
        this.loadResources();
        this.loadMapping(run.mappingId);
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }

  private loadTraces(): void {
    this.api.getRunTraces(this.runId()).subscribe({
      next: (payload) => this.traces.set(payload.traces),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  private loadResources(): void {
    this.api.getRunResources(this.runId()).subscribe({
      next: (payload) => this.resources.set(payload.resources),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  private loadMapping(mappingId: string): void {
    if (mappingId.trim().length === 0) {
      this.mappingSpec.set(null);
      return;
    }
    this.api.getMapping(mappingId).subscribe({
      next: (mapping) => this.mappingSpec.set(mapping.spec),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  protected select(id: string): void {
    this.selectedId.set(this.selectedId() === id ? null : id);
  }

  protected tone(kind: LineageNode["kind"]): string {
    return nodeTone(kind);
  }

  protected shortId(id: string): string {
    const marker = id.indexOf(":");
    return marker === -1 ? id : id.slice(marker + 1);
  }

  protected evidenceText(node: LineageNode): string {
    return node.evidence.length === 0 ? "stored coverage" : `trace seq ${node.evidence.join(", ")}`;
  }

  protected evidenceLabel(node: LineageNode): string {
    return node.evidence.length === 0
      ? "No trace event mentions this node; it comes from the run mapping version or stored coverage."
      : `Mentioned by stored trace events: seq ${node.evidence.join(", ")}.`;
  }

  protected backingLabel(edge: Parameters<typeof edgeBackingLabel>[0]): string {
    return edgeBackingLabel(edge);
  }
}
