import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { formatDateTime, formatDuration } from "../../../core/format";
import { JsonTree } from "../../../ui/json-tree";
import { Provenance } from "./provenance";
import { statusTone } from "./trace-timeline";
import type { DebuggerEvent } from "./trace.logic";

/**
 * Detail pane for one stored trace event: what the payload recorded, and the declared rule it
 * joins to. Missing fields say "not recorded" instead of inventing a value.
 */
@Component({
  selector: "hb-event-detail",
  standalone: true,
  imports: [JsonTree, Provenance],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="dbg-event-heading">
      <h2 id="dbg-event-heading">Event {{ event().seq }}</h2>

      <dl class="kv">
        <dt>Stage</dt>
        <dd>{{ event().stage }}</dd>
        <dt>Step</dt>
        <dd>{{ stepLabel() }}</dd>
        <dt>Status</dt>
        <dd>
          <span class="chip" [class]="toneForEvent(event().status)">{{ event().status }}</span>
        </dd>
        <dt>Timestamp</dt>
        <dd>{{ timestampLabel() }}</dd>
        <dt>Duration</dt>
        <dd>{{ durationLabel() }}</dd>
        <dt>Record</dt>
        <dd>{{ recordLabel() }}</dd>
        <dt>Redaction</dt>
        <dd>
          <span class="chip muted">{{ redactionLabel() }}</span>
        </dd>
      </dl>

      <section class="snippet" aria-labelledby="dbg-input-heading">
        <h3 id="dbg-input-heading">Input snippet</h3>
        @if (event().hasInputSnippet) {
          <hb-json-tree
            [value]="event().inputSnippet"
            label="Input snippet"
            [maxDepth]="12"
            [maxArrayItems]="200"
            [maxRows]="5000"
          />
        } @else {
          <p class="subtle">Input snippet not recorded in this trace event.</p>
        }
      </section>

      <section class="snippet" aria-labelledby="dbg-output-heading">
        <h3 id="dbg-output-heading">Output snippet</h3>
        @if (event().hasOutputSnippet) {
          <hb-json-tree
            [value]="event().outputSnippet"
            label="Output snippet"
            [maxDepth]="12"
            [maxArrayItems]="200"
            [maxRows]="5000"
          />
        } @else {
          <p class="subtle">Output snippet not recorded in this trace event.</p>
        }
      </section>

      @if (event().issues.length > 0) {
        <div class="table-wrap issues">
          <table>
            <caption>
              Issues recorded on event
              {{
                event().seq
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col">Code</th>
                <th scope="col">Message</th>
                <th scope="col">Record</th>
                <th scope="col">Path</th>
              </tr>
            </thead>
            <tbody>
              @for (issue of event().issues; track $index) {
                <tr>
                  <td>{{ issue.severity }}</td>
                  <td class="mono">{{ issue.code }}</td>
                  <td>{{ issue.message }}</td>
                  <td>{{ issue.recordIndex ?? "—" }}</td>
                  <td class="mono">{{ issue.path ?? "—" }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="subtle">No issues recorded on this event.</p>
      }

      <hb-provenance [event]="event()" [mappingSpec]="mappingSpec()" />
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    h2 {
      margin-bottom: var(--space-3);
    }

    .snippet {
      margin-top: var(--space-4);
    }

    .snippet h3 {
      margin-bottom: var(--space-2);
    }

    .issues {
      margin-top: var(--space-4);
    }

    caption {
      padding: var(--space-2) var(--space-3);
      text-align: left;
      color: var(--text-muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
  `,
})
export class EventDetail {
  public readonly event = input.required<DebuggerEvent>();
  public readonly mappingSpec = input.required<unknown>();

  protected readonly toneForEvent = statusTone;

  protected readonly stepLabel = computed(() => {
    const step = this.event().stepName;
    return step.length > 0 ? step : "not recorded";
  });

  protected readonly timestampLabel = computed(() => {
    const timestamp = this.event().timestamp;
    return timestamp === null ? "not recorded" : formatDateTime(timestamp);
  });

  protected readonly durationLabel = computed(() => {
    const duration = this.event().durationMs;
    return duration === null ? "not recorded" : formatDuration(duration);
  });

  protected readonly recordLabel = computed(() => {
    const record = this.event().recordIndex;
    return record === null ? "not recorded" : `record ${record} (0-based)`;
  });

  protected readonly redactionLabel = computed(() => {
    const redacted = this.event().redacted;
    if (redacted === true) return "redacted";
    if (redacted === false) return "not redacted";
    return "redaction not recorded";
  });
}
