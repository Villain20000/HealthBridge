# S3-compatible object storage — shipped

**Status:** ✅ S3 driver shipped and auto-selected when configured · **Phase:** F · **UI today:** `/assets` shows `storage: local-fs`
from `/healthz`; no option to change it.

## Why it matters

Content-addressed files on a container volume do not survive a multi-node deployment and cannot be
served by a CDN or a managed backup policy.

## What exists today (verified)

- `@healthbridge/storage` writes content-addressed objects under `HEALTHBRIDGE_STORAGE_DIR`,
  computes SHA-256 while writing, and streams downloads with `x-checksum`.
- `StorageError` is mapped to an API problem; `/healthz` reports `storage: local-fs`.
- Upload limits come from `/healthz` and are enforced before persistence.

## What is missing

- An S3 driver (`put`, `get`, `head`, streaming, multipart for large objects).
- Integrity verification on read (checksum comparison), and lifecycle/retention configuration.
- Credentials handling that never lands in logs or the console.

## Proposed design

`ObjectStorage` interface already exists; add `storage.s3.ts` selected by
`HEALTHBRIDGE_STORAGE_DRIVER=s3` with bucket/region/endpoint from env. Keep local-fs as the
default for demos and CI. Downloads stream through the API (unchanged contract) so redaction,
auth and `x-checksum` stay in one place.

## Acceptance criteria

- The same asset uploaded twice yields one object and one checksum.
- A corrupted object is detected on read and reported, not served.
- Contract tests run against local-fs in CI and against a MinIO container in one job.
- No credential appears in logs, error messages, `/healthz` or the bundle.

## Risks / non-goals

- Multipart upload is required above 5 GiB; do not claim large-file support before it exists.
- No CDN signed URLs in v1 (they would bypass API auth and redaction decisions).
