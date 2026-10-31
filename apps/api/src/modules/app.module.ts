import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ApiKeyService, TokenBucketRateLimiter } from "@healthbridge/auth";
import { APP_CONTEXT, type AppContext } from "../providers.js";
import { ApiKeyGuard } from "../common/auth.guard.js";
import { ApiExceptionFilter } from "../common/exception.filter.js";
import { HealthController } from "../controllers/health.controller.js";
import { WorkspacesController } from "../controllers/workspaces.controller.js";
import { KeysController } from "../controllers/keys.controller.js";
import { AssetsController } from "../controllers/assets.controller.js";
import { MappingStudioController } from "../controllers/mapping-studio.controller.js";
import { MappingsController } from "../controllers/mappings.controller.js";
import { PipelinesController } from "../controllers/pipelines.controller.js";
import { RunsController } from "../controllers/runs.controller.js";
import { AuditController } from "../controllers/audit.controller.js";

const CONTROLLERS = [
  HealthController,
  WorkspacesController,
  KeysController,
  AssetsController,
  MappingStudioController,
  MappingsController,
  PipelinesController,
  RunsController,
  AuditController,
];

const CONTEXT_PROVIDERS = (context: AppContext): Provider[] => [
  { provide: APP_CONTEXT, useValue: context },
  { provide: ApiKeyService, useFactory: () => context.apiKeys },
  { provide: TokenBucketRateLimiter, useFactory: () => context.limiter },
  { provide: APP_GUARD, useClass: ApiKeyGuard },
  { provide: APP_FILTER, useClass: ApiExceptionFilter },
];

/**
 * The module is only a shell: the context is always supplied explicitly so the
 * same controllers run against MySQL in production and in-memory repositories in
 * tests. There is no code path where production wiring can be reached by accident.
 */
@Module({})
export class AppModule {}

export function createAppModule(context: AppContext): DynamicModule {
  return {
    module: AppModule,
    controllers: CONTROLLERS,
    providers: CONTEXT_PROVIDERS(context),
    exports: [APP_CONTEXT],
  };
}
