import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createAppContext, type AppContext } from "../src/app.context.js";
import { configureHttp } from "../src/bootstrap.js";
import { loadTestConfig, type ApiConfig } from "../src/config.js";
import { createAppModule } from "../src/modules/app.module.js";

/**
 * Test harness that boots the *same* HTTP stack production uses
 * (configureHttp), only with in-memory repositories and storage.
 */

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  raw: string;
}

export interface ApiClient {
  request: <T = unknown>(
    method: string,
    path: string,
    options?: { body?: unknown; raw?: Buffer; headers?: Record<string, string> },
  ) => Promise<ApiResponse<T>>;
  url: string;
  key?: string;
}

export interface TestApi {
  url: string;
  app: INestApplication;
  context: AppContext;
  client: (apiKey?: string) => ApiClient;
  close: () => Promise<void>;
}

export async function startApi(overrides: Partial<ApiConfig> = {}): Promise<TestApi> {
  const config = loadTestConfig(overrides);
  const context = await createAppContext({ config });

  const app = await NestFactory.create(createAppModule(context), {
    bodyParser: false,
    logger: process.env.HB_TEST_LOGS ? ["error", "warn"] : false,
  });
  configureHttp(app, config);
  await app.listen(0, "127.0.0.1");
  const url = (await app.getUrl()).replace("[::1]", "127.0.0.1");

  const client = (apiKey?: string): ApiClient => ({
    url,
    key: apiKey,
    async request<T = unknown>(
      method: string,
      path: string,
      options: { body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {},
    ) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (apiKey) headers["x-api-key"] = apiKey;
      let body: BodyInit | undefined;
      if (options.raw) {
        body = options.raw;
        headers["content-type"] = headers["content-type"] ?? "application/octet-stream";
      } else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers["content-type"] = "application/json";
      }

      const response = await fetch(`${url}${path}`, { method, headers, body });
      const raw = await response.text();
      let parsed: unknown = raw;
      try {
        parsed = raw === "" ? undefined : JSON.parse(raw);
      } catch {
        // Not JSON; keep the raw text.
      }
      return { status: response.status, headers: response.headers, body: parsed as T, raw };
    },
  });

  return {
    url,
    app,
    context,
    client,
    close: async () => {
      await app.close();
      await context.close();
    },
  };
}

/** Polls a run until it reaches a terminal state. */
export async function waitForRun(
  client: ApiClient,
  runId: string,
  timeoutMs = 15_000,
): Promise<{ id: string; status: string; [key: string]: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.request<{ run: { id: string; status: string } }>("GET", `/api/v1/runs/${runId}`);
    if (response.status !== 200) {
      throw new Error(`run ${runId} polling failed with ${response.status}: ${response.raw}`);
    }
    const status = response.body.run.status;
    if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(status)) return response.body.run;
    await delay(25);
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function fixture(...parts: string[]): Buffer {
  return readFileSync(resolve(process.cwd(), ...parts));
}

export function fixtureJson<T = unknown>(...parts: string[]): T {
  return JSON.parse(fixture(...parts).toString("utf-8")) as T;
}
