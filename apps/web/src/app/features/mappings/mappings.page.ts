import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { JsonPipe } from "@angular/common";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, Mapping } from "../../core/api-types";
import { EmptyState, ErrorPanel, LoadingState, PlannedCard } from "../../ui/primitives";
import { formatRelative } from "../../core/format";

/**
 * Mappings: list, inspect a version's spec, import a spec, and show the version history.
 *
 * The mapping *editor* (drag-and-drop, coverage heat map, diff) is Studio work and is shown as
 * `Planned` — a disabled editor button would be a lie.
 */
@Component({
  selector: "hb-mappings",
  standalone: true,
  imports: [FormsModule, JsonPipe, EmptyState, ErrorPanel, LoadingState, PlannedCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Mappings</h1>
        <p>Versioned, immutable mapping specs. A run always references an exact version.</p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
        <button type="button" class="small primary" (click)="importOpen.set(!importOpen())">
          {{ importOpen() ? "Close" : "Import spec" }}
        </button>
      </div>
    </div>

    @if (importOpen()) {
      <section class="card" style="margin-bottom: 16px" aria-labelledby="import-heading">
        <h2 id="import-heading">Import a mapping spec</h2>
        <p class="card-sub">
          Paste the mapping JSON. The server validates it and assigns the next version for the name.
        </p>

        <div class="grid cols-2">
          <div class="field">
            <label for="mapping-name">Name</label>
            <input id="mapping-name" [(ngModel)]="importName" placeholder="patient-migration" autocomplete="off" />
          </div>
          <div class="field">
            <label for="mapping-target">Target resource type</label>
            <input id="mapping-target" [(ngModel)]="importTarget" placeholder="Patient" autocomplete="off" />
          </div>
        </div>

        <div class="field">
          <label for="mapping-spec">Spec JSON</label>
          <textarea id="mapping-spec" rows="8" [(ngModel)]="importSpec" spellcheck="false" class="mono"></textarea>
        </div>

        @if (importProblem(); as issue) {
          <hb-error [problem]="issue" />
        }

        <button
          type="button"
          class="primary"
          (click)="importSpecFile()"
          [disabled]="importing() || !importName || !importSpec"
        >
          {{ importing() ? "Importing…" : "Import" }}
        </button>
      </section>
    }

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && mappings().length === 0) {
      <hb-loading label="Loading mappings…" />
    } @else if (mappings().length === 0) {
      <hb-empty title="No mappings yet" message="Import a mapping spec to describe how a source file becomes FHIR." />
    } @else {
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Mapping</th>
              <th>Name</th>
              <th class="num">Version</th>
              <th>Source → target</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (mapping of mappings(); track mapping.id) {
              <tr>
                <td class="mono">{{ mapping.id }}</td>
                <td>{{ mapping.name }}</td>
                <td class="num">v{{ mapping.version }}</td>
                <td class="subtle">{{ mapping.sourceFormat }} → {{ mapping.targetFormat }}</td>
                <td class="subtle">{{ relative(mapping.createdAt) }}</td>
                <td class="right">
                  <button type="button" class="small" (click)="inspect(mapping)">Inspect</button>
                  <button type="button" class="small" (click)="history(mapping.name)">Versions</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button type="button" class="small" (click)="next()" [disabled]="!cursor() || loading()">Next</button>
        <span>{{ mappings().length }} shown</span>
      </div>
    }

    @if (versions(); as list) {
      <section class="card" style="margin-top: 16px">
        <h2>Version history: {{ versionsName() }}</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="num">Version</th>
                <th>Checksum</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              @for (mapping of list; track mapping.id) {
                <tr>
                  <td class="num">v{{ mapping.version }}</td>
                  <td class="mono">{{ mapping.specChecksum.slice(0, 22) }}…</td>
                  <td class="subtle">{{ relative(mapping.createdAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }

    @if (inspected(); as mapping) {
      <section class="card" style="margin-top: 16px">
        <h2>{{ mapping.name }} v{{ mapping.version }}</h2>
        <p class="card-sub">Checksum {{ mapping.specChecksum }}</p>
        <pre>{{ mapping.spec | json }}</pre>
      </section>
    }

    <div style="margin-top: 16px">
      <hb-planned
        title="Visual mapping studio"
        message="Drag-and-drop editing with a keyboard-complete alternative, coverage heat map, draft autosave and version diff are planned for the Studio. Today the console imports and inspects specs."
      />
    </div>
  `,
})
export class MappingsPage {
  private readonly api = inject(ApiClient);

  protected readonly mappings = signal<Mapping[]>([]);
  protected readonly cursor = signal<string | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly importOpen = signal(false);
  protected readonly importing = signal(false);
  protected readonly importProblem = signal<ApiProblem | null>(null);
  protected readonly inspected = signal<Mapping | null>(null);
  protected readonly versions = signal<Mapping[] | null>(null);
  protected readonly versionsName = signal("");

  protected importName = "";
  protected importTarget = "Patient";
  protected importSpec = "";

  constructor() {
    this.reload();
  }

  protected reload(): void {
    this.cursor.set(undefined);
    this.fetch();
  }

  protected next(): void {
    const cursor = this.cursor();
    if (cursor) this.fetch(cursor);
  }

  protected inspect(mapping: Mapping): void {
    this.versions.set(null);
    this.inspected.set(mapping);
    this.api.getMapping(mapping.id).subscribe({
      next: (full) => this.inspected.set(full),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  protected history(name: string): void {
    this.inspected.set(null);
    this.versionsName.set(name);
    this.api.listMappingVersions(name).subscribe({
      next: (response) => this.versions.set(response.versions),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  protected importSpecFile(): void {
    let spec: unknown;
    try {
      spec = JSON.parse(this.importSpec);
    } catch (error) {
      this.importProblem.set({
        status: 0,
        code: "INVALID_JSON",
        message: `The pasted spec is not valid JSON: ${(error as Error).message}`,
      });
      return;
    }

    this.importing.set(true);
    this.importProblem.set(null);
    this.api
      .createMapping({ name: this.importName.trim(), spec, targetResourceType: this.importTarget.trim() || undefined })
      .subscribe({
        next: (mapping) => {
          this.importing.set(false);
          this.importOpen.set(false);
          this.importSpec = "";
          this.inspected.set(mapping);
          this.reload();
        },
        error: (error: ApiProblem) => {
          this.importing.set(false);
          this.importProblem.set(error);
        },
      });
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  private fetch(cursor?: string): void {
    this.loading.set(true);
    this.problem.set(null);
    this.api.listMappings(25, cursor).subscribe({
      next: (page) => {
        this.mappings.update((current) => (cursor ? [...current, ...page.items] : page.items));
        this.cursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }
}
