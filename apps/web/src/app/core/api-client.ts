/**
 * Typed API client: one method per documented endpoint, no presentation logic.
 *
 * Everything that touches HTTP lives here and in `api.interceptor.ts`, so features never
 * build URLs or read headers themselves — that separation is what lets the Studio (mapping
 * editor, debugger, lineage) be added later without rewriting the data layer.
 */
import { HttpClient, HttpErrorResponse, HttpParams, HttpResponse } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable, catchError, map, throwError } from "rxjs";
import { problemFromUnknown } from "./api-errors";
import type {
  Asset,
  AssetsPage,
  AuditEvent,
  AuditPage,
  CreatedKey,
  CreatedWorkspace,
  Health,
  KeysResponse,
  Mapping,
  MappingDiffResponse,
  MappingDraftView,
  MappingPreviewResponse,
  MappingsPage,
  Page,
  Pipeline,
  PipelinesPage,
  PublishMappingResponse,
  Run,
  RunIssuesResponse,
  RunResourcesResponse,
  RunTracesResponse,
  RunsPage,
  RunStatus,
  VersionInfo,
  WorkspaceResponse,
} from "./api-types";

/**
 * The API names each collection in its envelope (`{ runs, nextCursor }`). The console works
 * with one `Page<T>` shape so tables and pagers are generic; the adaptation happens here and
 * nowhere else.
 */
function toPage<T, K extends string>(key: K) {
  return map((envelope: Record<K, T[]> & { nextCursor?: string }): Page<T> => ({
    items: envelope[key],
    nextCursor: envelope.nextCursor,
  }));
}

export const API_BASE = "/api/v1";

function toProblem(error: unknown): Observable<never> {
  if (error instanceof HttpErrorResponse) return throwError(() => problemFromUnknown(error));
  return throwError(() => problemFromUnknown(error));
}

@Injectable({ providedIn: "root" })
export class ApiClient {
  private readonly http = inject(HttpClient);

  // ---- health / meta ----
  public health(): Observable<Health> {
    return this.http.get<Health>(`${API_BASE}/healthz`).pipe(catchError(toProblem));
  }

  public version(): Observable<VersionInfo> {
    return this.http.get<VersionInfo>(`${API_BASE}/version`).pipe(catchError(toProblem));
  }

  public formats(): Observable<unknown> {
    return this.http.get(`${API_BASE}/formats`).pipe(catchError(toProblem));
  }

  // ---- workspaces / keys ----
  public createWorkspace(input: { name: string; slug: string }, bootstrapToken: string): Observable<CreatedWorkspace> {
    return this.http
      .post<CreatedWorkspace>(`${API_BASE}/workspaces`, input, { headers: { "x-bootstrap-token": bootstrapToken } })
      .pipe(catchError(toProblem));
  }

  public currentWorkspace(): Observable<WorkspaceResponse> {
    return this.http.get<WorkspaceResponse>(`${API_BASE}/workspaces/current`).pipe(catchError(toProblem));
  }

  public listKeys(): Observable<KeysResponse> {
    return this.http.get<KeysResponse>(`${API_BASE}/keys`).pipe(catchError(toProblem));
  }

  public createKey(input: { name: string; role: string; scopes?: string[]; ttlDays?: number }): Observable<CreatedKey> {
    return this.http
      .post<CreatedKey>(`${API_BASE}/keys`, input, { headers: { "idempotency-key": crypto.randomUUID() } })
      .pipe(catchError(toProblem));
  }

  public rotateKey(id: string): Observable<CreatedKey> {
    return this.http.post<CreatedKey>(`${API_BASE}/keys/${id}/rotate`, {}).pipe(catchError(toProblem));
  }

  public revokeKey(id: string): Observable<unknown> {
    return this.http.delete(`${API_BASE}/keys/${id}`).pipe(catchError(toProblem));
  }

  // ---- assets ----
  public uploadAsset(file: File): Observable<Asset> {
    const params = new HttpParams().set("filename", file.name);
    return this.http
      .post<{ asset: Asset }>(`${API_BASE}/assets`, file, {
        params,
        headers: { "content-type": file.type || "application/octet-stream" },
      })
      .pipe(
        map((response) => response.asset),
        catchError(toProblem),
      );
  }

  public listAssets(limit = 25, cursor?: string): Observable<Page<Asset>> {
    let params = new HttpParams().set("limit", limit);
    if (cursor) params = params.set("cursor", cursor);
    return this.http.get<AssetsPage>(`${API_BASE}/assets`, { params }).pipe(toPage("assets"), catchError(toProblem));
  }

  public getAsset(id: string): Observable<Asset> {
    return this.http.get<{ asset: Asset }>(`${API_BASE}/assets/${id}`).pipe(
      map((response) => response.asset),
      catchError(toProblem),
    );
  }

  public downloadAsset(id: string): Observable<HttpResponse<Blob>> {
    return this.http
      .get(`${API_BASE}/assets/${id}/content`, { observe: "response", responseType: "blob" })
      .pipe(catchError(toProblem)) as Observable<HttpResponse<Blob>>;
  }

  // ---- mappings ----
  public createMapping(input: { name: string; spec: unknown; targetResourceType?: string }): Observable<Mapping> {
    return this.http.post<{ mapping: Mapping }>(`${API_BASE}/mappings`, input).pipe(
      map((response) => response.mapping),
      catchError(toProblem),
    );
  }

  public listMappings(limit = 25, cursor?: string): Observable<Page<Mapping>> {
    let params = new HttpParams().set("limit", limit);
    if (cursor) params = params.set("cursor", cursor);
    return this.http
      .get<MappingsPage>(`${API_BASE}/mappings`, { params })
      .pipe(toPage("mappings"), catchError(toProblem));
  }

  public getMapping(id: string): Observable<Mapping> {
    return this.http.get<{ mapping: Mapping }>(`${API_BASE}/mappings/${id}`).pipe(
      map((response) => response.mapping),
      catchError(toProblem),
    );
  }

  public listMappingVersions(name: string): Observable<{ versions: Mapping[] }> {
    return this.http
      .get<{ versions: Mapping[] }>(`${API_BASE}/mappings/${encodeURIComponent(name)}/versions`)
      .pipe(catchError(toProblem));
  }

  // ---- mapping studio: drafts, publish, diff, preview ----
  public getMappingDraft(name: string): Observable<MappingDraftView> {
    return this.http
      .get<MappingDraftView>(`${API_BASE}/mappings/${encodeURIComponent(name)}/draft`)
      .pipe(catchError(toProblem));
  }

  /** `revision` is the revision the caller last saw (0 for a first save); a stale one is a 409 `DRAFT_CONFLICT`. */
  public saveMappingDraft(
    name: string,
    input: { spec: unknown; revision: number; baseVersion?: number },
  ): Observable<MappingDraftView> {
    return this.http
      .put<MappingDraftView>(`${API_BASE}/mappings/${encodeURIComponent(name)}/draft`, input)
      .pipe(catchError(toProblem));
  }

  /** Idempotent. Pass `revision` to refuse discarding a draft someone else has changed. */
  public discardMappingDraft(name: string, revision?: number): Observable<void> {
    let params = new HttpParams();
    if (revision !== undefined) params = params.set("revision", revision);
    return this.http
      .delete<void>(`${API_BASE}/mappings/${encodeURIComponent(name)}/draft`, { params })
      .pipe(catchError(toProblem));
  }

  public publishMapping(name: string, revision: number): Observable<PublishMappingResponse> {
    return this.http
      .post<PublishMappingResponse>(`${API_BASE}/mappings/${encodeURIComponent(name)}/publish`, { revision })
      .pipe(catchError(toProblem));
  }

  /** `from` and `to` are `latest`, `draft` or a version number; the server defaults to latest → draft. */
  public diffMapping(name: string, from?: string, to?: string): Observable<MappingDiffResponse> {
    let params = new HttpParams();
    if (from) params = params.set("from", from);
    if (to) params = params.set("to", to);
    return this.http
      .get<MappingDiffResponse>(`${API_BASE}/mappings/${encodeURIComponent(name)}/diff`, { params })
      .pipe(catchError(toProblem));
  }

  public previewMapping(input: {
    spec: unknown;
    assetId: string;
    maxRecords?: number;
    adapterId?: string;
  }): Observable<MappingPreviewResponse> {
    return this.http.post<MappingPreviewResponse>(`${API_BASE}/mappings/preview`, input).pipe(catchError(toProblem));
  }

  // ---- pipelines ----
  public createPipeline(input: {
    name: string;
    mappingId: string;
    config?: Record<string, unknown>;
  }): Observable<Pipeline> {
    return this.http.post<{ pipeline: Pipeline }>(`${API_BASE}/pipelines`, input).pipe(
      map((response) => response.pipeline),
      catchError(toProblem),
    );
  }

  public getPipeline(id: string): Observable<Pipeline> {
    return this.http.get<{ pipeline: Pipeline }>(`${API_BASE}/pipelines/${id}`).pipe(
      map((response) => response.pipeline),
      catchError(toProblem),
    );
  }

  public listPipelines(limit = 25, cursor?: string): Observable<Page<Pipeline>> {
    let params = new HttpParams().set("limit", limit);
    if (cursor) params = params.set("cursor", cursor);
    return this.http
      .get<PipelinesPage>(`${API_BASE}/pipelines`, { params })
      .pipe(toPage("pipelines"), catchError(toProblem));
  }

  // ---- runs ----
  public createRun(
    input: {
      assetId: string;
      mappingId?: string;
      mappingName?: string;
      pipelineId?: string;
      options?: Record<string, unknown>;
    },
    idempotencyKey: string,
  ): Observable<{ run: Run; created: boolean }> {
    return this.http
      .post<{ run: Run; created: boolean }>(`${API_BASE}/runs`, input, {
        headers: { "idempotency-key": idempotencyKey },
      })
      .pipe(catchError(toProblem));
  }

  public listRuns(request: { limit?: number; cursor?: string; status?: RunStatus } = {}): Observable<Page<Run>> {
    let params = new HttpParams().set("limit", request.limit ?? 25);
    if (request.cursor) params = params.set("cursor", request.cursor);
    if (request.status) params = params.set("status", request.status);
    return this.http.get<RunsPage>(`${API_BASE}/runs`, { params }).pipe(toPage("runs"), catchError(toProblem));
  }

  public getRun(id: string): Observable<Run> {
    return this.http.get<{ run: Run }>(`${API_BASE}/runs/${id}`).pipe(
      map((response) => response.run),
      catchError(toProblem),
    );
  }

  public getRunResources(id: string): Observable<RunResourcesResponse> {
    return this.http.get<RunResourcesResponse>(`${API_BASE}/runs/${id}/resources`).pipe(catchError(toProblem));
  }

  /** Issues are returned whole (no cursor): a run's problem list is bounded by the engine. */
  public getRunIssues(id: string): Observable<RunIssuesResponse> {
    return this.http.get<RunIssuesResponse>(`${API_BASE}/runs/${id}/issues`).pipe(catchError(toProblem));
  }

  public getRunTraces(id: string): Observable<RunTracesResponse> {
    return this.http.get<RunTracesResponse>(`${API_BASE}/runs/${id}/traces`).pipe(catchError(toProblem));
  }

  public getRunBundle(
    id: string,
  ): Observable<{ runId: string; expected: Record<string, unknown>; actual?: Record<string, unknown> }> {
    return this.http
      .get<{ runId: string; expected: Record<string, unknown>; actual?: Record<string, unknown> }>(
        `${API_BASE}/runs/${id}/bundle`,
      )
      .pipe(catchError(toProblem));
  }

  public cancelRun(id: string): Observable<Run> {
    return this.http.post<{ run: Run }>(`${API_BASE}/runs/${id}/cancel`, {}).pipe(
      map((response) => response.run),
      catchError(toProblem),
    );
  }

  public replayRun(id: string): Observable<Run> {
    return this.http.post<{ run: Run }>(`${API_BASE}/runs/${id}/replay`, {}).pipe(
      map((response) => response.run),
      catchError(toProblem),
    );
  }

  /** Event stream URL; the SSE client opens it with `fetch` so it can send the key. */
  public runEventsUrl(id: string): string {
    return `${API_BASE}/runs/${id}/events`;
  }

  // ---- audit ----
  public listAudit(limit = 25, cursor?: string): Observable<Page<AuditEvent>> {
    let params = new HttpParams().set("limit", limit);
    if (cursor) params = params.set("cursor", cursor);
    return this.http.get<AuditPage>(`${API_BASE}/audit`, { params }).pipe(toPage("events"), catchError(toProblem));
  }
}
