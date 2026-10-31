import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import type { MappingDiff } from "@healthbridge/shared-types";
import type { ApiProblem, MappingDiffResponse } from "../../../core/api-types";
import { ErrorPanel } from "../../../ui/primitives";

function compactJson(value: unknown): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value) ?? "—";
  } catch {
    return "—";
  }
}

/**
 * Presentational result of `GET /mappings/:name/diff`. Every value is rendered as text or compact
 * JSON; the server's response is never inserted as HTML.
 */
@Component({
  selector: "hb-version-diff",
  standalone: true,
  imports: [ErrorPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="version-diff" aria-label="Version diff result">
      @if (loading()) {
        <p class="meta" role="status">Comparing versions…</p>
      }

      @if (problem(); as issue) {
        <hb-error [problem]="issue" />
      }

      @if (response(); as result) {
        @let diff = result.diff;
        <p class="meta">Comparing {{ fromLabel() || result.from }} to {{ toLabel() || result.to }}.</p>

        <dl class="kv">
          <dt>Added</dt>
          <dd>{{ diff.counts.added }}</dd>
          <dt>Removed</dt>
          <dd>{{ diff.counts.removed }}</dd>
          <dt>Changed</dt>
          <dd>{{ diff.counts.changed }}</dd>
          <dt>Reordered</dt>
          <dd>{{ diff.counts.reordered }}</dd>
          <dt>Unchanged</dt>
          <dd>{{ diff.counts.unchanged }}</dd>
        </dl>

        @if (diff.truncated) {
          <p class="banner" role="note" style="margin-top: var(--space-3)">
            The server truncated this diff; some differences are not shown.
          </p>
        }

        @if (!hasDifferences(diff)) {
          <p class="meta">No differences.</p>
        }

        @if (diff.metadata.length > 0) {
          <h3 style="margin-top: var(--space-3)">Metadata changes</h3>
          <div class="table-wrap">
            <table>
              <caption class="sr-only">
                Metadata changes
              </caption>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                @for (change of diff.metadata; track change.field) {
                  <tr>
                    <td class="mono">{{ change.field }}</td>
                    <td class="mono">{{ json(change.from) }}</td>
                    <td class="mono">{{ json(change.to) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (diff.rules.added.length > 0) {
          <h3 style="margin-top: var(--space-3)">Added rules ({{ diff.rules.added.length }})</h3>
          <div class="table-wrap">
            <table>
              <caption class="sr-only">
                Added rules
              </caption>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Source path</th>
                  <th>Target path</th>
                  <th>Transform</th>
                </tr>
              </thead>
              <tbody>
                @for (rule of diff.rules.added; track rule.id) {
                  <tr>
                    <td class="mono">{{ rule.id }}</td>
                    <td class="mono">{{ rule.sourcePath }}</td>
                    <td class="mono">{{ rule.targetPath }}</td>
                    <td>{{ rule.transform }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (diff.rules.removed.length > 0) {
          <h3 style="margin-top: var(--space-3)">Removed rules ({{ diff.rules.removed.length }})</h3>
          <div class="table-wrap">
            <table>
              <caption class="sr-only">
                Removed rules
              </caption>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Source path</th>
                  <th>Target path</th>
                  <th>Transform</th>
                </tr>
              </thead>
              <tbody>
                @for (rule of diff.rules.removed; track rule.id) {
                  <tr>
                    <td class="mono">{{ rule.id }}</td>
                    <td class="mono">{{ rule.sourcePath }}</td>
                    <td class="mono">{{ rule.targetPath }}</td>
                    <td>{{ rule.transform }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (diff.rules.changed.length > 0) {
          <h3 style="margin-top: var(--space-3)">Changed rules ({{ diff.rules.changed.length }})</h3>
          <div class="table-wrap">
            <table>
              <caption class="sr-only">
                Changed rules
              </caption>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Field</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                @for (change of diff.rules.changed; track change.ruleId) {
                  @if (change.fields.length === 0) {
                    <tr>
                      <td class="mono">{{ change.ruleId }}</td>
                      <td colspan="3">No field-level changes reported.</td>
                    </tr>
                  } @else {
                    @for (field of change.fields; track field.field) {
                      <tr>
                        <td class="mono">{{ change.ruleId }}</td>
                        <td class="mono">{{ field.field }}</td>
                        <td class="mono">{{ json(field.from) }}</td>
                        <td class="mono">{{ json(field.to) }}</td>
                      </tr>
                    }
                  }
                }
              </tbody>
            </table>
          </div>
        }

        @if (diff.rules.reordered.length > 0) {
          <h3 style="margin-top: var(--space-3)">Reordered rules ({{ diff.rules.reordered.length }})</h3>
          <div class="table-wrap">
            <table>
              <caption class="sr-only">
                Reordered rules
              </caption>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>From index</th>
                  <th>To index</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of diff.rules.reordered; track entry.ruleId) {
                  <tr>
                    <td class="mono">{{ entry.ruleId }}</td>
                    <td>{{ entry.fromIndex }}</td>
                    <td>{{ entry.toIndex }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    </section>
  `,
})
export class VersionDiff {
  public readonly response = input<MappingDiffResponse | null>(null);
  public readonly loading = input(false);
  public readonly problem = input<ApiProblem | null>(null);
  public readonly fromLabel = input("");
  public readonly toLabel = input("");

  protected json(value: unknown): string {
    return compactJson(value);
  }

  protected hasDifferences(diff: MappingDiff): boolean {
    return (
      diff.metadata.length > 0 ||
      diff.rules.added.length > 0 ||
      diff.rules.removed.length > 0 ||
      diff.rules.changed.length > 0 ||
      diff.rules.reordered.length > 0
    );
  }
}
