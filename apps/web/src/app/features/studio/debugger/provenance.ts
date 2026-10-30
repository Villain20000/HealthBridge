import { JsonPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { joinRule } from "./trace.logic";
import type { DebuggerEvent, RuleJoinStatus } from "./trace.logic";

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
 * Declared rule provenance for one stored event.
 *
 * The join is against the run's mapping version, not against observed values: the stored trace
 * does not record what the rule produced. Conditions are printed as declared, never evaluated.
 */
@Component({
  selector: "hb-provenance",
  standalone: true,
  imports: [JsonPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="dbg-prov-heading">
      <h3 id="dbg-prov-heading">Declared rule provenance</h3>

      <p class="badge-row">
        <span class="chip" [class]="joinTone()">{{ joinLabel() }}</span>
      </p>

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
            @if (rule.when && rule.when.length > 0) {
              <ul class="conditions">
                @for (condition of rule.when; track $index) {
                  <li class="mono">
                    {{ condition.path }} {{ condition.op
                    }}{{ condition.value === undefined ? "" : " " + (condition.value | json) }}
                  </li>
                }
              </ul>
            } @else {
              None
            }
          </dd>
        </dl>
      } @else {
        <p class="subtle">{{ join().note }}</p>
      }

      <div class="evidence">
        <p>Trace status: {{ event().status }}</p>
        <p>Issues on this event: {{ event().issues.length }}</p>
        <p>Redaction: {{ redactionLabel() }}</p>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    h3 {
      margin-bottom: var(--space-2);
    }

    .badge-row {
      margin: 0 0 var(--space-2);
    }

    .conditions {
      margin: 0;
      padding-left: var(--space-4);
    }

    .evidence {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-top: var(--space-3);
      font-size: 13px;
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

  protected readonly redactionLabel = computed(() => {
    const redacted = this.event().redacted;
    if (redacted === true) return "redacted";
    if (redacted === false) return "not redacted";
    return "redaction not recorded";
  });
}
