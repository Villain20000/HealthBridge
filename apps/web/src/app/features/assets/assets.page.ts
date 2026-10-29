import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, Asset, Health } from "../../core/api-types";
import { EmptyState, ErrorPanel, LoadingState } from "../../ui/primitives";
import { formatBytes, formatDateTime, formatRelative } from "../../core/format";

/**
 * Assets: upload (raw body), list, inspect, download.
 *
 * The maximum size shown comes from `/healthz` (B6) — never a hard-coded number that drifts
 * from the server's real limit.
 */
@Component({
  selector: "hb-assets",
  standalone: true,
  imports: [EmptyState, ErrorPanel, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Assets</h1>
        <p>Stored source files. Bytes are content-addressed and verified on read.</p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
      </div>
    </div>

    <section class="card" style="margin-bottom: 16px" aria-labelledby="upload-heading">
      <h2 id="upload-heading">Upload</h2>
      <p class="card-sub">
        Max {{ maxUpload() }} per file, sent as the raw request body. Supported source formats are reported by
        <code>GET /api/v1/formats</code>; detection runs server-side.
      </p>

      <div class="row">
        <input
          #fileInput
          type="file"
          (change)="pick(fileInput.files)"
          aria-label="Choose a file to upload"
          style="max-width: 420px"
        />
        <button type="button" class="primary" (click)="upload(fileInput)" [disabled]="uploading() || !selected">
          {{ uploading() ? "Uploading…" : "Upload" }}
        </button>
        @if (selected) {
          <span class="subtle">{{ selected!.name }} · {{ humanSize(selected!.size) }}</span>
        }
      </div>

      @if (uploadProblem(); as issue) {
        <div style="margin-top: 12px"><hb-error [problem]="issue" /></div>
      }
      @if (uploaded(); as asset) {
        <p class="banner" style="margin-top: 12px" role="status">
          Uploaded <code>{{ asset.id }}</code> · {{ asset.sourceFormat }} · {{ asset.checksum.slice(0, 22) }}…
        </p>
      }
    </section>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && assets().length === 0) {
      <hb-loading label="Loading assets…" />
    } @else if (assets().length === 0) {
      <hb-empty title="No assets yet" message="Upload a CSV/JSON export to get started." />
    } @else {
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th>Filename</th>
              <th>Format</th>
              <th class="num">Size</th>
              <th>Checksum</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (asset of assets(); track asset.id) {
              <tr>
                <td class="mono">{{ asset.id }}</td>
                <td>{{ asset.filename }}</td>
                <td>{{ asset.sourceFormat }}</td>
                <td class="num">{{ humanSize(asset.sizeBytes) }}</td>
                <td class="mono">{{ asset.checksum.slice(0, 18) }}…</td>
                <td class="subtle">{{ relative(asset.createdAt) }}</td>
                <td class="right">
                  <button type="button" class="small" (click)="download(asset)">Download</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button type="button" class="small" (click)="next()" [disabled]="!cursor() || loading()">Next</button>
        <span>{{ assets().length }} shown{{ cursor() ? " · more available" : "" }}</span>
      </div>
    }

    <p class="faint" style="margin-top: 16px">Exported {{ lastSync() }}</p>
  `,
})
export class AssetsPage {
  private readonly api = inject(ApiClient);

  protected readonly assets = signal<Asset[]>([]);
  protected readonly cursor = signal<string | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly uploading = signal(false);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly uploadProblem = signal<ApiProblem | null>(null);
  protected readonly uploaded = signal<Asset | null>(null);
  protected readonly health = signal<Health | null>(null);
  protected selected: File | null = null;
  private readonly syncedAt = signal(new Date().toISOString());

  constructor() {
    this.reload();
    this.api.health().subscribe({ next: (health) => this.health.set(health), error: () => undefined });
  }

  protected maxUpload(): string {
    const limit = this.health()?.limits.maxUploadBytes;
    return limit ? formatBytes(limit) : "the server limit (see /healthz)";
  }

  protected lastSync(): string {
    return formatDateTime(this.syncedAt());
  }

  protected pick(files: FileList | null): void {
    this.selected = files && files.length > 0 ? files[0] : null;
    this.uploaded.set(null);
    this.uploadProblem.set(null);
  }

  protected upload(input: HTMLInputElement): void {
    if (!this.selected) return;
    this.uploading.set(true);
    this.uploadProblem.set(null);
    this.api.uploadAsset(this.selected).subscribe({
      next: (asset) => {
        this.uploading.set(false);
        this.uploaded.set(asset);
        this.selected = null;
        input.value = "";
        this.reload();
      },
      error: (error: ApiProblem) => {
        this.uploading.set(false);
        this.uploadProblem.set(error);
      },
    });
  }

  protected download(asset: Asset): void {
    this.api.downloadAsset(asset.id).subscribe({
      next: (response) => {
        const blob = response.body;
        if (!blob) return;
        const headerChecksum = response.headers.get("x-checksum");
        if (headerChecksum && headerChecksum !== asset.checksum) {
          this.problem.set({
            status: 0,
            code: "CHECKSUM_MISMATCH",
            message: `The server reported ${headerChecksum} for this download but the asset row says ${asset.checksum}.`,
          });
          return;
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = asset.filename;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  protected reload(): void {
    this.cursor.set(undefined);
    this.fetch();
  }

  protected next(): void {
    const cursor = this.cursor();
    if (cursor) this.fetch(cursor);
  }

  protected humanSize(bytes: number): string {
    return formatBytes(bytes);
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  private fetch(cursor?: string): void {
    this.loading.set(true);
    this.problem.set(null);
    this.api.listAssets(25, cursor).subscribe({
      next: (page) => {
        this.assets.update((current) => (cursor ? [...current, ...page.items] : page.items));
        this.cursor.set(page.nextCursor);
        this.loading.set(false);
        this.syncedAt.set(new Date().toISOString());
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }
}
