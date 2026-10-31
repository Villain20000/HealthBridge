import { JsonPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import type { MappingPreviewResponse } from "@healthbridge/shared-types";
import type { ApiProblem } from "../../../core/api-types";
import { ErrorPanel } from "../../../ui/primitives";
import { CoverageTable } from "./coverage-table";
import { IssueList } from "./issue-list";

/**
 * Result of a server-side dry run of the draft against a stored asset. Nothing here is persisted.
 * When the request failed only the error is shown: a stale success payload would look like data
 * from the failed run.
 */
@Component({
  selector: "hb-preview-panel",
  standalone: true,
  imports: [ErrorPanel, IssueList, JsonPipe, CoverageTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="preview-panel" aria-label="Preview">
      <h3>Preview</h3>
      @if (previewing()) {
        <p role="status">Running preview…</p>
      }
      @if (problem(); as current) {
        <hb-error [problem]="current" [showRetry]="false"></hb-error>
      } @else {
        @if (result(); as response) {
          @let preview = response.preview;
          <p class="meta" role="note">Preview only — no run was created.</p>
          <dl class="meta">
            <dt>Adapter</dt>
            <dd class="mono">{{ preview.adapter.id }} v{{ preview.adapter.version }} ({{ preview.adapter.format }})</dd>
            <dt>Processed</dt>
            <dd>{{ preview.recordsProcessed }}</dd>
            <dt>Succeeded</dt>
            <dd>{{ preview.recordsSucceeded }}</dd>
            <dt>Rejected</dt>
            <dd>{{ preview.recordsRejected }}</dd>
            <dt>Duration</dt>
            <dd>{{ preview.durationMs }} ms</dd>
          </dl>
          <hb-coverage-table [coverage]="preview.coverage" />
          @if (preview.truncated) {
            <p class="meta" role="note">
              The preview was truncated to stay small. Omitted: {{ preview.omitted.join(", ") || "n/a" }}.
            </p>
          }
          <hb-issue-list
            [issues]="preview.issues"
            heading="Preview issues"
            emptyText="The preview produced no issues."
            (selectRule)="selectRule.emit($event)"
          ></hb-issue-list>
          @if (preview.rejected.length > 0) {
            <h4>Rejected records ({{ preview.rejected.length }})</h4>
            <ul>
              @for (record of preview.rejected; track $index) {
                <li>
                  <pre class="mono">{{ record | json }}</pre>
                </li>
              }
            </ul>
          }
          <h4>Sample output ({{ preview.sample.length }})</h4>
          @if (preview.sample.length === 0) {
            <p class="meta">No records were produced.</p>
          } @else {
            <ul>
              @for (item of preview.sample; track $index) {
                <li>
                  <pre class="mono">{{ item | json }}</pre>
                </li>
              }
            </ul>
          }
        }
      }
    </section>
  `,
})
export class PreviewPanel {
  public readonly result = input<MappingPreviewResponse | null>(null);
  public readonly previewing = input(false);
  public readonly problem = input<ApiProblem | null>(null);

  public readonly selectRule = output<string>();
}
