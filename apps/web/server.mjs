#!/usr/bin/env node
/**
 * HealthBridge Operator Console server.
 *
 * One process, three jobs:
 *   1. serve the built Angular app (with an SPA fallback),
 *   2. reverse-proxy `/api/*` to the API so the browser only ever talks to its own origin
 *      (no CORS preflight, no API key in a query string, no internal host names in the bundle),
 *   3. apply the security headers the console relies on.
 *
 * Node built-ins only: `npm prune --omit=dev` runs before this file is shipped, so a runtime
 * dependency would be a deploy-time surprise.
 *
 * Configuration (environment, never hard-coded):
 *   PORT              listen port                (default 4200)
 *   API_ORIGIN        upstream API origin        (default http://127.0.0.1:3000)
 *   API_PREFIX        proxied path prefix        (default /api)
 *   PROXY_TIMEOUT_MS  upstream socket timeout    (default 0 = no timeout, for SSE)
 *   TRUST_PROXY       set to 1 behind TLS term.  (enables HSTS)
 *   STATIC_DIR        built app directory        (default ./dist/web/browser)
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env["PORT"] ?? 4200);
const API_ORIGIN = process.env["API_ORIGIN"] ?? "http://127.0.0.1:3000";
const API_PREFIX = process.env["API_PREFIX"] ?? "/api";
const PROXY_TIMEOUT_MS = Number(process.env["PROXY_TIMEOUT_MS"] ?? 0);
const TRUST_PROXY = process.env["TRUST_PROXY"] === "1";
const STATIC_DIR = resolve(process.env["STATIC_DIR"] ?? join(here, "dist", "web", "browser"));

const upstream = new URL(API_ORIGIN);
const upstreamRequest = upstream.protocol === "https:" ? httpsRequest : httpRequest;

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".map", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    // Angular injects component styles at runtime; hashes would break on every build.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

function securityHeaders(extra = {}) {
  return {
    ...SECURITY_HEADERS,
    ...(TRUST_PROXY ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
    ...extra,
  };
}

function logLine(entry) {
  process.stdout.write(`${JSON.stringify({ level: "info", component: "web", ...entry })}\n`);
}

function sendJson(res, status, body, requestId) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(
    status,
    securityHeaders({
      "content-type": "application/json; charset=utf-8",
      "content-length": String(payload.byteLength),
      "cache-control": "no-store",
      "x-request-id": requestId,
    }),
  );
  res.end(payload);
}

/** Resolves a URL path inside the static root, or null when it escapes it. */
function staticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\0")) return null;
  const candidate = normalize(join(STATIC_DIR, decoded));
  if (candidate !== STATIC_DIR && !candidate.startsWith(STATIC_DIR + sep)) return null;
  return candidate;
}

function contentType(file) {
  return MIME.get(extname(file).toLowerCase()) ?? "application/octet-stream";
}

/** Hashed bundles are immutable; HTML must never be cached or a deploy leaves a stale app. */
function cacheControlFor(pathname) {
  if (pathname === "/" || pathname.endsWith(".html")) return "no-store";
  if (/-[A-Z0-9]{8}\.(js|css|woff2)$/.test(pathname)) return "public, max-age=31536000, immutable";
  return "public, max-age=300";
}

function serveFile(req, res, file, pathname, requestId) {
  const stats = statSync(file);
  const etag = `W/"${stats.size}-${Math.floor(stats.mtimeMs)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(
      304,
      securityHeaders({ etag, "cache-control": cacheControlFor(pathname), "x-request-id": requestId }),
    );
    res.end();
    return;
  }
  res.writeHead(
    200,
    securityHeaders({
      "content-type": contentType(file),
      "content-length": String(stats.size),
      "cache-control": cacheControlFor(pathname),
      etag,
      "x-request-id": requestId,
    }),
  );
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function proxy(req, res, requestId) {
  let target;
  try {
    target = new URL(req.url ?? "/", API_ORIGIN);
  } catch {
    sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "Unparsable request URL" } }, requestId);
    return;
  }

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || name === "host") continue;
    headers[name] = value;
  }
  headers["x-request-id"] = requestId;
  headers["x-forwarded-proto"] = TRUST_PROXY ? "https" : "http";
  headers["x-forwarded-host"] = req.headers["host"] ?? "";
  // SSE must not be buffered by anything in front of the browser.
  if ((req.url ?? "").includes("/events")) headers["accept-encoding"] = "identity";

  const upstreamReq = upstreamRequest(
    {
      protocol: upstream.protocol,
      hostname: target.hostname,
      port: target.port || (upstream.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP.has(name) || name === "content-length") continue;
        responseHeaders[name] = value;
      }
      const isStream = String(upstreamRes.headers["content-type"] ?? "").includes("text/event-stream");
      res.writeHead(
        upstreamRes.statusCode ?? 502,
        securityHeaders({
          ...responseHeaders,
          "cache-control": isStream ? "no-store, no-transform" : "no-store",
          ...(isStream ? { "x-accel-buffering": "no" } : {}),
          "x-request-id": String(upstreamRes.headers["x-request-id"] ?? requestId),
        }),
      );
      if (isStream) {
        res.socket?.setTimeout(0);
        res.socket?.setNoDelay(true);
        res.flushHeaders?.();
      }
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    },
  );

  upstreamReq.setTimeout(PROXY_TIMEOUT_MS);
  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timeout")));
  upstreamReq.on("error", (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    logLine({ message: "upstream error", error: error.message, path: req.url, requestId });
    sendJson(
      res,
      502,
      {
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "The console cannot reach the HealthBridge API.",
          requestId,
        },
      },
      requestId,
    );
  });

  req.pipe(upstreamReq);
}

const server = createServer((req, res) => {
  const startedAt = Date.now();
  const requestId = String(req.headers["x-request-id"] ?? randomUUID());
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  res.on("finish", () => {
    logLine({
      message: "request",
      method: req.method,
      path: pathname,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      requestId,
    });
  });

  if (req.method === "GET" && pathname === "/healthz") {
    sendJson(
      res,
      200,
      { status: "ok", component: "web", upstream: `${upstream.protocol}//${upstream.host}`, staticDir: STATIC_DIR },
      requestId,
    );
    return;
  }

  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
    proxy(req, res, requestId);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(
      res,
      405,
      { error: { code: "METHOD_NOT_ALLOWED", message: `${req.method} is not supported for static content.` } },
      requestId,
    );
    return;
  }

  const file = staticPath(pathname);
  if (file && existsSync(file) && statSync(file).isFile()) {
    serveFile(req, res, file, pathname, requestId);
    return;
  }

  // SPA fallback: only for navigation-shaped paths, never for files that look like assets.
  if (extname(pathname) === "") {
    const index = join(STATIC_DIR, "index.html");
    if (existsSync(index)) {
      serveFile(req, res, index, "/index.html", requestId);
      return;
    }
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "No such page." } }, requestId);
});

// SSE connections are long-lived; Node's default request timeout would cut them at 5 minutes.
server.requestTimeout = 0;
server.headersTimeout = 66_000;
server.keepAliveTimeout = 72_000;

server.listen(PORT, () => {
  logLine({
    message: "console listening",
    port: PORT,
    apiOrigin: `${upstream.protocol}//${upstream.host}${API_PREFIX}`,
    staticDir: STATIC_DIR,
  });
  if (!existsSync(join(STATIC_DIR, "index.html"))) {
    logLine({ level: "warn", message: "build missing: run `npm run build:web`", staticDir: STATIC_DIR });
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    logLine({ message: "shutting down", signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
