import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";
import { PersistenceError } from "@healthbridge/persistence";
import { StorageError } from "@healthbridge/storage";
import { HealthBridgeError } from "@healthbridge/sdk";
import { ApiError, ApiErrorCode } from "./errors.js";
import type { AuthenticatedRequest } from "./auth.guard.js";

/**
 * One place that decides what a client sees.
 *
 * Internal error messages (SQL text, stack traces, storage paths) never cross this
 * boundary; they are logged with the request id instead.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("ApiExceptionFilter");

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<AuthenticatedRequest>();
    const requestId = request.requestId;

    const { error, log } = this.translate(exception);

    if (log) {
      this.logger.error(
        `${request.method} ${request.originalUrl ?? request.url} → ${error.statusCode} ${error.code}: ${log} (requestId=${requestId})`,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.originalUrl ?? request.url} → ${error.statusCode} ${error.code}: ${error.message} (requestId=${requestId})`,
      );
    }

    if (response.headersSent) {
      response.end();
      return;
    }

    for (const [header, value] of Object.entries(error.options.headers ?? {})) {
      response.setHeader(header, value);
    }

    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        requestId,
        ...(error.options.details === undefined ? {} : { details: error.options.details }),
      },
      statusCode: error.statusCode,
    });
  }

  private translate(exception: unknown): { error: ApiError; log?: string } {
    if (ApiError.isApiError(exception)) return { error: exception };

    if (exception instanceof PersistenceError) {
      const code: ApiErrorCode =
        exception.code === "NOT_FOUND"
          ? "NOT_FOUND"
          : exception.code === "CONFLICT"
            ? "CONFLICT"
            : exception.code === "IDEMPOTENCY_CONFLICT"
              ? "IDEMPOTENCY_CONFLICT"
              : "VALIDATION_FAILED";
      return { error: new ApiError(code, exception.message), log: exception.message };
    }

    if (exception instanceof StorageError) {
      const code: ApiErrorCode =
        exception.code === "OBJECT_TOO_LARGE"
          ? "PAYLOAD_TOO_LARGE"
          : exception.code === "OBJECT_NOT_FOUND"
            ? "NOT_FOUND"
            : "VALIDATION_FAILED";
      return { error: new ApiError(code, exception.message) };
    }

    if (exception instanceof HealthBridgeError) {
      const code: ApiErrorCode =
        exception.code === "CANCELLED"
          ? "CANCELLED"
          : exception.code === "INPUT_NOT_FOUND"
            ? "NOT_FOUND"
            : "VALIDATION_FAILED";
      return { error: new ApiError(code, exception.message), log: exception.message };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === "string"
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      const code: ApiErrorCode =
        status === 404
          ? "NOT_FOUND"
          : status === 401
            ? "UNAUTHENTICATED"
            : status === 403
              ? "FORBIDDEN"
              : status === 409
                ? "CONFLICT"
                : status === 413
                  ? "PAYLOAD_TOO_LARGE"
                  : status === 415
                    ? "UNSUPPORTED_MEDIA_TYPE"
                    : status === 429
                      ? "RATE_LIMITED"
                      : status < 500
                        ? "VALIDATION_FAILED"
                        : "INTERNAL";
      if (status === 400 && /JSON/i.test(Array.isArray(message) ? message.join(" ") : message)) {
        return { error: new ApiError("INVALID_JSON", "The request body is not valid JSON.") };
      }
      return {
        error: new ApiError(code, Array.isArray(message) ? message.join("; ") : message),
        log: code === "INTERNAL" ? exception.message : undefined,
      };
    }

    // Body-parser rejects (oversized upload, malformed JSON) are plain Errors carrying an HTTP
    // status, not HttpExceptions. Without this they surface as 500s, which sends an operator
    // looking for a server bug that does not exist.
    const transport = exception as { status?: number; statusCode?: number; type?: string; message?: string };
    const transportStatus = transport.statusCode ?? transport.status;
    if (typeof transportStatus === "number" && transportStatus >= 400 && transportStatus < 500) {
      if (transportStatus === 413 || transport.type === "entity.too.large") {
        return {
          error: new ApiError(
            "PAYLOAD_TOO_LARGE",
            "The request body exceeds the size limit reported by GET /api/v1/healthz.",
          ),
        };
      }
      if (transportStatus === 400 && transport.type === "entity.parse.failed") {
        return { error: new ApiError("INVALID_JSON", "The request body is not valid JSON.") };
      }
      return {
        error: new ApiError(
          transportStatus === 400 ? "VALIDATION_FAILED" : "INTERNAL",
          transport.message ?? "The request was rejected.",
        ),
      };
    }

    const error = exception as Error;
    return {
      error: new ApiError("INTERNAL", "An unexpected error occurred. Quote the requestId when reporting it."),
      log: error?.stack ?? String(exception),
    };
  }
}
