# Object storage

Content-addressed blob storage for HealthBridge OS. Keys are the SHA-256 of
the bytes (`sha256/<first-2-hex>/<full-hex>`), so identical files are stored
once and every driver verifies bytes on read.

## Drivers

| Driver | Lives in | Backend |
|---|---|---|
| `MemoryStorageDriver` | `packages/storage/src/index.ts` | In-process map (tests, demo) |
| `LocalFileStorage` | `packages/storage/src/index.ts` | Local filesystem, atomic writes |
| `S3StorageDriver` | `packages/storage/src/s3.ts` | Any S3-compatible store over HTTPS |

All three implement the same `StorageDriver` contract
(`put` / `get` / `stat` / `delete` / `exists`) and the same error taxonomy:

- `OBJECT_TOO_LARGE` / `INVALID_ARGUMENT` from `put` (empty or over-limit)
- `OBJECT_NOT_FOUND` from `get` on a missing key
- `INTEGRITY_MISMATCH` from `get` when bytes fail verification — never serve
  corrupted bytes
- `INVALID_KEY` from every operation on a non-content-address (no user input
  ever reaches the backend raw, so path traversal is impossible by construction)

`s3.test.ts` asserts the S3 driver against the same behaviours as the other
two, including key-layout identity with `LocalFileStorage`.

## S3 driver details

- Plain `PUT` / `GET` / `HEAD` / `DELETE` over HTTP/HTTPS with AWS Signature
  Version 4 signed in-file (Node built-ins only, no new dependencies).
- The object key is the storage key verbatim (no prefix); the checksum travels
  as the `x-amz-meta-checksum` user-metadata header and `Content-Type` is
  stored normally. `put` checks first, so re-uploading identical bytes is a
  no-op and the first write's content type wins.
- `delete` reports whether something was actually removed. S3 itself returns
  `204` even for missing keys, so the driver checks existence first.
- `stat`/`exists` use `HEAD`: `404` maps to `undefined`/`false`, anything else
  unexpected throws a plain `Error` (with the HTTP status and a 200-char body
  snippet; `403` adds a credentials hint). Transport failures propagate
  unwrapped — the taxonomy has no upstream code, and masking an outage as
  "missing" would be worse.

## Configuration

Connection info is additive on `ApiConfig.storage.s3`; credentials never touch
the config object. They resolve per driver as explicit options first, then
`HEALTHBRIDGE_S3_*`, then the standard `AWS_*` variables.

| Variable | Meaning | Default |
|---|---|---|
| `HEALTHBRIDGE_S3_ENDPOINT` | Base URL, e.g. `https://s3.eu-west-1.amazonaws.com` or `http://minio:9000` | unset (S3 off) |
| `HEALTHBRIDGE_S3_BUCKET` | Existing bucket (never auto-created) | unset (S3 off) |
| `HEALTHBRIDGE_S3_REGION` | Signing region (`AWS_REGION` also read) | `us-east-1` |
| `HEALTHBRIDGE_S3_FORCE_PATH_STYLE` | `endpoint/bucket/key` vs `bucket.endpoint/key` | `true` |
| `HEALTHBRIDGE_S3_ACCESS_KEY_ID` | Access key (`AWS_ACCESS_KEY_ID` also read) | — |
| `HEALTHBRIDGE_S3_SECRET_ACCESS_KEY` | Secret, never logged (`AWS_SECRET_ACCESS_KEY` also read) | — |
| `HEALTHBRIDGE_S3_SESSION_TOKEN` | Optional session token (`AWS_SESSION_TOKEN` also read) | — |

Setting only one of endpoint/bucket refuses to start (`ConfigError`); setting
neither leaves storage exactly as before.

## Limitations

- Single-part `PUT` only; objects are still bounded by `maxObjectBytes`, so
  very large blobs need chunking above this layer.
- No retries, no bucket creation, no versioning or lifecycle handling.
- `app.context.ts` selects `S3StorageDriver` whenever
  `ApiConfig.storage.s3` is present (credentials resolve inside the driver
  from `HEALTHBRIDGE_S3_*` / `AWS_*`); a requested-but-unbuildable S3 driver
  fails startup with a `ConfigError` instead of falling back to local disk.
