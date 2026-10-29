import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createAppContext } from "./app.context.js";
import { configureHttp } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { createAppModule } from "./modules/app.module.js";

/**
 * API entry point.
 *
 * Startup is fail-fast: a configuration problem (missing pepper, production without
 * a database) throws before the port is opened, so an operator sees the reason in the
 * logs instead of discovering it through 500s.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger("Bootstrap");

  const context = await createAppContext({ config });
  const app = await NestFactory.create(createAppModule(context), {
    bodyParser: false,
    logger: config.nodeEnv === "test" ? false : ["error", "warn", "log"],
  });

  configureHttp(app, config);
  await app.listen(config.port, config.host);

  logger.log(`HealthBridge API listening on http://${config.host}:${config.port}/api/v1 (mode: ${config.mode})`);
  if (config.mode === "demo") {
    logger.warn(
      "DEMO MODE: in-memory persistence. Do not point this at real patient data. " +
        "Set DATABASE_URL and HEALTHBRIDGE_KEY_PEPPER for a durable deployment.",
    );
    // Without this the first workspace can never be created in demo mode.
    logger.log(`Demo bootstrap token (POST /api/v1/workspaces as x-bootstrap-token): ${config.auth.bootstrapToken}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} received: draining queue and closing persistence`);
    await app.close();
    await context.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((error: unknown) => {
  // Configuration errors must be readable without a stack-trace wall.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`HealthBridge API failed to start: ${message}`);
  process.exit(1);
});
