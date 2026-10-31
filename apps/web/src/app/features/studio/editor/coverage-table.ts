import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import type { CoverageReport } from "@healthbridge/shared-types";

export type CoverageStatus = "Mapped" | "Unmapped" | "Rejected";

export interface CoverageRow {
  readonly path: string;
  readonly status: CoverageStatus;
}

export const COVERAGE_ROW_CAP = 200;

/**
 * Coverage heat map for a preview: source field paths with a text status, never a colour-only
 * signal. Rejected paths win over mapped ones, and the table is capped so a large asset cannot
 * lock up the page.
 */
@Component({
  selector: "hb-coverage-table",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (coverage(); as report) {
      <dl class="kv">
        <dt>Records considered</dt>
        <dd>{{ report.recordsConsidered ?? "—" }}</dd>
        <dt>Source fields</dt>
        <dd>{{ report.mappedSourceFields }} of {{ report.totalSourceFields }} mapped</dd>
        <dt>Coverage</dt>
        <dd>{{ report.coveragePercentage }}%</dd>
        <dt>Target fields populated</dt>
        <dd>{{ report.targetFieldsPopulated }}</dd>
        <dt>Rejected values</dt>
        <dd>{{ report.rejectedValuesCount }}</dd>
      </dl>

      @if (rows().length === 0) {
        <p class="meta">No coverage data.</p>
      } @else {
        <div class="table-wrap" style="margin-top: var(--space-3)">
          <table>
            <caption class="sr-only">
              Source field coverage
            </caption>
            <thead>
              <tr>
                <th>Source path</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              @for (row of visibleRows(); track row.path) {
                <tr>
                  <td class="mono">{{ row.path }}</td>
                  <td>{{ row.status }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (hiddenCount() > 0) {
          <p class="meta">{{ hiddenCount() }} more source paths are not shown.</p>
        }
      }
    } @else {
      <p class="meta">No coverage data.</p>
    }
  `,
})
export class CoverageTable {
  public readonly coverage = input<CoverageReport | null>(null);

  protected readonly rows = computed<CoverageRow[]>(() => {
    const report = this.coverage();
    if (report === null) return [];

    const byPath = new Map<string, CoverageStatus>();
    for (const path of report.unmappedSourceFields) byPath.set(path, "Unmapped");
    for (const path of report.mappedFieldPaths ?? []) byPath.set(path, "Mapped");
    // A rejected path is reported as rejected even when another rule also mapped it.
    for (const path of report.rejectedFieldPaths ?? []) byPath.set(path, "Rejected");

    return [...byPath.entries()]
      .map(([path, status]) => ({ path, status }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });

  protected readonly visibleRows = computed(() => this.rows().slice(0, COVERAGE_ROW_CAP));

  protected readonly hiddenCount = computed(() => Math.max(0, this.rows().length - COVERAGE_ROW_CAP));
}
