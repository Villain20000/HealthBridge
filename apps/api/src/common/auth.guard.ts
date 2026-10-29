import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ApiKeyService, Principal, Scope, TokenBucketRateLimiter } from "@healthbridge/auth";
import { ApiError } from "./errors.js";

export const PUBLIC_ROUTE = "healthbridge:public";
export const REQUIRED_SCOPE = "healthbridge:scope";
export const SCOPE_ANY = "healthbridge:scopes";

/** Routes that do not require an API key (health and bootstrap only). */
export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true);

/** Requires one specific scope. */
export const RequiresScope = (scope: Scope) => SetMetadata(REQUIRED_SCOPE, scope);

/** Requires at least one of the listed scopes. */
export const RequiresAnyScope = (...scopes: Scope[]) => SetMetadata(SCOPE_ANY, scopes);

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
  requestId?: string;
}

export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.principal) throw new ApiError("UNAUTHENTICATED", "This endpoint requires an API key.");
  return request.principal;
});

export const RequestId = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.requestId;
});

/**
 * Single guard for authentication, authorisation and rate limiting.
 *
 * They are combined on purpose: one key lookup per request, and it is impossible
 * to add a route that is rate limited but unauthenticated by mistake.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  // Token-injected rather than type-injected: the build must work even when
  // decorator metadata is unavailable (tsx/esbuild), and explicit tokens make the
  // wiring readable without knowing Nest's reflection rules.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
    @Inject(TokenBucketRateLimiter) private readonly limiter: TokenBucketRateLimiter,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [handler, controller])) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Scope>(REQUIRED_SCOPE, [handler, controller]);
    const anyOf = this.reflector.getAllAndOverride<Scope[]>(SCOPE_ANY, [handler, controller]);

    const rawKey = request.header("x-api-key") ?? undefined;
    const result = await this.apiKeys.authenticate(rawKey, required);

    if (!result.ok) {
      const code =
        result.code === "MISSING_CREDENTIALS"
          ? "UNAUTHENTICATED"
          : result.code === "MALFORMED_KEY"
            ? "MALFORMED_KEY"
            : result.code === "INSUFFICIENT_SCOPE"
              ? "FORBIDDEN"
              : result.code === "EXPIRED_KEY"
                ? "EXPIRED_KEY"
                : result.code === "REVOKED_KEY"
                  ? "REVOKED_KEY"
                  : "UNAUTHENTICATED";
      throw new ApiError(code, result.message, {
        details: result.requiredScope ? { requiredScope: result.requiredScope } : undefined,
      });
    }

    if (anyOf && anyOf.length > 0 && !anyOf.some((scope) => result.principal.scopes.includes(scope))) {
      throw new ApiError("FORBIDDEN", `This key needs one of: ${anyOf.join(", ")}.`, {
        details: { requiredScopes: anyOf },
      });
    }

    const decision = this.limiter.consume(result.principal.apiKeyId);
    if (!decision.allowed) {
      throw new ApiError("RATE_LIMITED", "Too many requests for this API key.", {
        details: { retryAfterSeconds: decision.retryAfterSeconds },
        headers: {
          "retry-after": String(decision.retryAfterSeconds),
          "x-ratelimit-limit": String(decision.limit),
          "x-ratelimit-remaining": "0",
        },
      });
    }

    request.principal = result.principal;
    return true;
  }
}
