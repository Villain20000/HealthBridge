# @healthbridge/client

Typed `fetch`-based REST client for the HealthBridge OS API (v1), with one method per documented endpoint (see `docs/api.md`; the machine contract is `docs/openapi.json`).

**Status:** Supported in the v3.2.0 developer preview. Runtime-dependency free: it only needs a global `fetch` (Node 22+, browsers, edge runtimes).

## Install

Install from source until the first npm release: `npm ci && npm run build`.

Published as `@healthbridge/client` when released.

## Use

```ts
import { HealthBridgeClient, HealthBridgeApiError } from "@healthbridge/client";

const client = new HealthBridgeClient({ baseUrl: "http://localhost:3000", apiKey: process.env.HB_API_KEY });

const health = await client.health();
const asset = await client.uploadAsset(csvBytes, { filename: "patients.csv", contentType: "text/csv" });
const schema = await client.getAssetSchema(asset.id);

try {
  await client.getRun("run_missing");
} catch (error) {
  if (error instanceof HealthBridgeApiError) console.error(error.code, error.status);
}
```

## Links

- [Project README](../../README.md)
- [API reference](../../docs/api.md)
- [Security policy](../../SECURITY.md)
- [License (Apache-2.0)](LICENSE)
