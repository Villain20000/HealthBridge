import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Response } from "express";
import type { INestApplication } from "@nestjs/common";
import type { ApiConfig } from "./config.js";
import type { AuthenticatedRequest } from "./common/auth.guard.js";

/**
 * Shared HTTP bootstrap for both `main.ts` and the e2e tests.
 *
 * Doing this in one place is deliberate: a test that boots a differently configured
 * server proves nothing about the server that runs in production.
 */

export const API_PREFIX = "api/v1";

export function applyRequestContext(_config: ApiConfig) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const provided = request.header("x-request-id");
    const requestId = provided && /^[A-Za-z0-9._:-]{1,100}$/.test(provided) ? provided : randomUUID();

    request.requestId = requestId;
    response.setHeader("x-request-id", requestId);

    // Conservative defaults for an API that returns patient-derived JSON.
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");

    next();
  };
}

export function configureHttp(app: INestApplication, config: ApiConfig): void {
  const server = app.getHttpAdapter().getInstance();

  server.use(applyRequestContext(config));

  if (config.corsOrigins.length > 0) {
    server.use((request: express.Request, response: Response, next: NextFunction) => {
      const origin = request.header("origin");
      if (origin && config.corsOrigins.includes(origin)) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "origin");
        response.setHeader(
          "access-control-allow-headers",
          "content-type, x-api-key, x-request-id, idempotency-key, x-bootstrap-token, last-event-id",
        );
        response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
        // Without this a browser cannot read the checksum or the request id, which is
        // exactly what an operator needs when a download or an error has to be traced.
        response.setHeader("access-control-expose-headers", "x-checksum, x-request-id, content-length, content-type");
        response.setHeader("access-control-max-age", "600");
      }
      if (request.method === "OPTIONS") {
        response.status(204).end();
        return;
      }
      next();
    });
  }

  // Raw uploads: the whole body is the file, and any content type is allowed
  // because hospital exports are routinely mislabelled.
  server.use(`/${API_PREFIX}/assets`, express.raw({ type: () => true, limit: config.storage.maxObjectBytes }));
  // JSON everywhere else, bounded: a huge JSON body is a cheap denial of service.
  server.use(express.json({ limit: config.limits.maxRequestBodyBytes }));

  app.enableShutdownHooks();
}
