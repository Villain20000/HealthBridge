import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import type { Health, VersionInfo } from "../../core/api-types";
import { formatBytes, formatDuration } from "../../core/format";

/**
 * Server facts. Every value comes from `GET /healthz` (including the limits, B6) and
 * `GET /version`; nothing here is estimated.
 */
@Component({
  selector: "hb-health-cards",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid cols-4">
      <div class="card">
        <div class="stat">
          <span class="label">Persistence</span>
          <span class="value" style="font-size: 15px">{{ health().persistence }}</span>
          <span class="hint">{{
            health().mode === "database" ? "survives a restart" : "lost when the process stops"
          }}</span>
        </div>
      </div>
      <div class="card">
        <div class="stat">
          <span class="label">Queue</span>
          <span class="value" style="font-size: 15px">{{ health().queue.mode }}</span>
          <span class="hint">{{ health().queue.active }} active · {{ health().queue.queued }} queued here</span>
        </div>
      </div>
      <div class="card">
        <div class="stat">
          <span class="label">Storage</span>
          <span class="value" style="font-size: 15px">{{ health().storage }}</span>
          <span class="hint">max upload {{ bytes(health().limits.maxUploadBytes) }}</span>
        </div>
      </div>
      <div class="card">
        <div class="stat">
          <span class="label">Uptime</span>
          <span class="value" style="font-size: 15px">{{ uptime() }}</span>
          <span class="hint">{{ health().nodeEnv }} · since {{ health().startedAt.slice(11, 19) }} UTC</span>
        </div>
      </div>
    </div>

    <div class="grid cols-3" style="margin-top: 12px">
      <div class="card">
        <h3>Execution limits</h3>
        <dl class="kv">
          <dt>Request body</dt>
          <dd>{{ bytes(health().limits.maxRequestBodyBytes) }}</dd>
          <dt>Stored result</dt>
          <dd>{{ bytes(health().limits.maxStoredResultBytes) }}</dd>
          <dt>Traces per run</dt>
          <dd>{{ health().limits.maxTracesPerRun }}</dd>
          <dt>Queue</dt>
          <dd>{{ health().limits.queue.concurrency }} concurrent · {{ health().limits.queue.maxAttempts }} attempts</dd>
        </dl>
      </div>
      <div class="card">
        <h3>Rate limits</h3>
        <dl class="kv">
          <dt>Burst</dt>
          <dd>{{ health().limits.rateLimit.burst }} requests</dd>
          <dt>Refill</dt>
          <dd>{{ health().limits.rateLimit.refillPerSecond }}/s</dd>
        </dl>
        <p class="card-sub" style="margin-top: 8px">
          Applied per API key. Exceeding it returns <code>RATE_LIMITED</code>.
        </p>
      </div>
      <div class="card">
        <h3>Versions</h3>
        <dl class="kv">
          <dt>Engine</dt>
          <dd>{{ version()?.engine ?? "—" }}</dd>
          <dt>Trace protocol</dt>
          <dd>{{ version()?.traceProtocol ?? "—" }}</dd>
          <dt>API</dt>
          <dd>{{ version()?.api ?? "—" }}</dd>
          <dt>Node</dt>
          <dd>{{ version()?.node ?? "—" }}</dd>
        </dl>
      </div>
    </div>
  `,
})
export class HealthCards {
  public readonly health = input.required<Health>();
  public readonly version = input<VersionInfo | null>(null);

  protected readonly uptime = computed(() => formatDuration(this.health().uptimeSeconds * 1000));

  protected bytes(value: number): string {
    return formatBytes(value);
  }
}
