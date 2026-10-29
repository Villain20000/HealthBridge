import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeProblem,
  isRetryable,
  isUnauthorized,
  problemFromStatus,
  problemFromUnknown,
} from "../src/app/core/api-errors";
import { formatBytes, formatDuration, maskKey, truncateMiddle } from "../src/app/core/format";

/**
 * Error mapping and formatting. Both are pure, both are what the operator actually reads:
 * a failure with no `code` or `requestId` is a failure nobody can support.
 */
describe("API problem mapping", () => {
  it("prefers the server's error envelope", () => {
    const problem = problemFromStatus(422, {
      error: { code: "MAPPING_INVALID", message: "binding x has no source", requestId: "req-1" },
    });
    assert.deepEqual(problem, {
      status: 422,
      code: "MAPPING_INVALID",
      message: "binding x has no source",
      requestId: "req-1",
      details: undefined,
    });
  });

  it("falls back to the status table when the body is empty", () => {
    const problem = problemFromStatus(429, undefined);
    assert.equal(problem.code, "RATE_LIMITED");
    assert.match(problem.message, /Too many requests/);
  });

  it("uses the x-request-id response header when the body has none", () => {
    assert.equal(problemFromStatus(500, {}, "req-header").requestId, "req-header");
  });

  it("treats a transport failure as a network error with status 0", () => {
    const problem = problemFromUnknown({ status: 0, error: { type: "error" } });
    assert.equal(problem.code, "NETWORK_ERROR");
    assert.equal(problem.status, 0);
  });

  it("reads the request id from an Angular HttpErrorResponse-like object", () => {
    const problem = problemFromUnknown({ status: 503, error: { message: "down" }, headers: { get: () => "req-9" } });
    assert.equal(problem.requestId, "req-9");
  });

  it("renders one line including code and request id", () => {
    assert.equal(
      describeProblem({ status: 401, code: "UNAUTHORIZED", message: "Key rejected", requestId: "r1" }),
      "Key rejected [UNAUTHORIZED] (request r1)",
    );
  });

  it("classifies retryable and unauthorised problems", () => {
    assert.equal(isRetryable({ status: 503, code: "UNAVAILABLE", message: "" }), true);
    assert.equal(isRetryable({ status: 400, code: "BAD_REQUEST", message: "" }), false);
    assert.equal(isUnauthorized({ status: 401, code: "MISSING_CREDENTIALS", message: "" }), true);
    assert.equal(isUnauthorized({ status: 403, code: "FORBIDDEN", message: "" }), false);
  });
});

describe("formatting", () => {
  it("formats byte sizes with one sensible unit", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(999), "999 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(15 * 1024 * 1024), "15 MB");
    assert.equal(formatBytes(null), "—");
  });

  it("formats durations across the ms/s/m/h boundaries", () => {
    assert.equal(formatDuration(84), "84 ms");
    assert.equal(formatDuration(1_250), "1.3 s");
    assert.equal(formatDuration(65_000), "1m 5s");
    assert.equal(formatDuration(3_720_000), "1h 2m");
    assert.equal(formatDuration(undefined), "—");
  });

  it("masks a key without leaking its middle", () => {
    assert.equal(maskKey("hb_1234567890abcdef"), "hb_123…cdef");
    assert.equal(maskKey("short"), "…");
  });

  it("truncates long identifiers in the middle so both ends stay recognisable", () => {
    assert.equal(truncateMiddle("0123456789abcdefghij", 4), "0123…ghij");
    assert.equal(truncateMiddle("tiny", 4), "tiny");
  });
});
