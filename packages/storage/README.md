# @healthbridge/storage

Content-addressed object storage drivers for HealthBridge OS, with local filesystem and in-memory implementations.

**Status:** Partial: local filesystem, in-memory and S3-compatible drivers (`S3StorageDriver` in `src/s3.ts`, SigV4, env config); the API selects S3 automatically when `HEALTHBRIDGE_S3_ENDPOINT` + bucket are configured, otherwise local/memory.

## Install

Install from source until the first npm release: `npm ci && npm run build`.

Published as `@healthbridge/storage` when released.

## Links

- [Project README](../../README.md)
- [Roadmap](../../ROADMAP.md)
- [Security policy](../../SECURITY.md)
- [License (Apache-2.0)](LICENSE)
