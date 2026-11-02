import { JsonPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { joinRule } from "./trace.logic";
import type { DebuggerEvent, RuleJoinStatus } from "./trace.logic";
import { evaluateRuleConditions } from "./breakpoints.logic";

const JOIN_LABELS: Record<RuleJoinStatus, string> = {
  exact: "Joined by rule id",
  "by-target": "Joined by declared target path",
  ambiguous: "Ambiguous target path",
  missing: "Rule id not in mapping version",
  unrecorded: "Rule not recorded",
  "no-mapping": "No declared rules",
};

const JOIN_TONES: Record<RuleJoinStatus, "ok" | "info" | "warn" | "muted"> = {
  exact: "ok",
  "by-target": "info",
  ambiguous: "warn",
  missing: "warn",
  unrecorded: "muted",
  "no-mapping": "muted",
};

/**
 * Declared rule provenance and condition evaluation for one stored event.
 *
 * Explicitly separates [observed] payload fields from [inferred] mapping spec metadata.
 * Evaluates rule conditions against the stored input snippet when present.
 */
@Component({
  selector: "hb-provenance",
  standalone: true,
  imports: [JsonPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="dbg-prov-heading">
      <h3 id="dbg-prov-heading">Rule Provenance & Evaluation</h3>

      <div class="badge-row">
        <span class="chip" [class]="joinTone()">{{ joinLabel() }}</span>
        @if (join().status === "exact") {
          <span class="chip micro ok" title="Rule ID recorded in trace event">[observed rule]</span>
        } @else if (join().status === "by-target") {
          <span class="chip micro info" title="Rule inferred by unique target path match">[inferred rule]</span>
        }
      </div>

      <p class="subtle">Declared from the run's mapping version. The trace does not record per-rule observed values.</p>

      @if (join().rule; as rule) {
        <dl class="kv">
          <dt>Source path</dt>
          <dd class="mono">{{ rule.sourcePath }}</dd>
          <dt>Target path</dt>
          <dd class="mono">{{ rule.targetPath }}</dd>
          <dt>Transform</dt>
          <dd class="mono">{{ rule.transform }}</dd>
          <dt>Required</dt>
          <dd>{{ rule.required === true ? "yes" : "no" }}</dd>
          <dt>Conditions</dt>
          <dd>
            @if (conditionResults().length > 0) {
              <div class="table-wrap">
                <table class="condition-table">
                  <thead>
                    <tr>
                      <th scope="col">Condition</th>
                      <th scope="col">Observed in Input</th>
                      <th scope="col">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (res of conditionResults(); track res.path + res.op + $index) {
                      <tr>
                        <td class="mono">
                          {{ res.path }} {{ res.op }}
                          @if (res.expectedValue !== undefined) {
                            <span> {{ res.expectedValue | json }}</span>
                          }
                        </td>
                        <td>
                          @if (res.hasObservedValue) {
                            <span class="mono">{{ res.observedValue | json }}</span>
                            <span class="badge-tag observed">[observed]</span>
                          } @else {
                            <span class="subtle">not in snippet</span>
                          }
                        </td>
                        <td>
                          @if (!res.evaluated) {
                            <span class="chip muted">Unavailable</span>
                          } @else if (res.matched) {
                            <span class="chip ok">Matched</span>
                          } @else {
                            <span class="chip warn">Not matched</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              None
            }
          </dd>
        </dl>
      } @else {
        <p class="subtle">{{ join().note }}</p>
      }

      <div class="evidence">
        <h4>Event Metadata</h4>
        <p>Status: <strong>{{ event().status }}</strong> <span class="badge-tag observed">[observed]</span></p>
        <p>Recorded issues: <strong>{{ event().issues.length }}</strong> <span class="badge-tag observed">[observed]</span></p>
        <p>Redaction: <strong>{{ redactionLabel() }}</strong> <span class="badge-tag observed">[observed]</span></p>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    h3 {
      margin-bottom: var(--space-2);
      font-size: 16px;
    }

    h4 {
      font-size: 13px;
      margin: var(--space-3) 0 var(--space-2);
      color: var(--text);
    }

    .badge-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin: 0 0 var(--space-2);
    }

    .badge-tag {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      margin-left: var(--space-1);
      font-weight: 600;
      text-transform: uppercase;
      font-family: var(--font-sans, sans-serif);
    }

    .badge-tag.observed {
      background: var(--bg-hover, rgba(0, 0, 0, 0.06));
      color: var(--primary, #2563eb);
      border: 1px solid var(--border);
    }

    .badge-tag.inferred {
      background: var(--bg-hover, rgba(0, 0, 0, 0.06));
      color: var(--text-muted);
      border: 1px dashed var(--border);
    }

    .chip.micro {
      font-size: 10px;
      padding: 1px 4px;
    }

    .condition-table {
      width: 100%;
      font-size: 12px;
      margin-top: 4px;
    }

    .condition-table th, .condition-table td {
      padding: 4px 8px;
    }

    .evidence {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: var(--space-3);
      font-size: 12.5px;
      padding-top: var(--space-2);
      border-top: 1px solid var(--border);
    }

    .evidence p {
      margin: 0;
    }
  `,
})
export class Provenance {
  public readonly event = input.required<DebuggerEvent>();
  public readonly mappingSpec = input.required<unknown>();

  protected readonly join = computed(() => joinRule(this.event(), this.mappingSpec()));
  protected readonly joinLabel = computed(() => JOIN_LABELS[this.join().status]);
  protected readonly joinTone = computed(() => JOIN_TONES[this.join().status]);

  protected readonly conditionResults = computed(() => {
    const rule = this.join().rule;
    if (!rule) return [];
    return evaluateRuleConditions(rule, this.event().inputSnippet, this.event().hasInputSnippet);
  });

  protected readonly redactionLabel = computed(() => {
    const redacted = this.event().redacted;
    if (redacted === true) return "redacted";
    if (redacted === false) return "not redacted";
    return "redaction not recorded";
  });
}
