import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMappingSlug, safeReturnUrl } from "../src/app/core/navigation";

/**
 * Navigation guards. The return URL is attacker-controlled and the slug rule must match the API's,
 * so these tests pin the exact rejections rather than trusting a URL parser or the server to catch it.
 */
describe("safeReturnUrl", () => {
  it("accepts same-origin paths with query and fragment", () => {
    assert.equal(safeReturnUrl("/dashboard"), "/dashboard");
    assert.equal(safeReturnUrl("/runs?status=failed"), "/runs?status=failed");
    assert.equal(safeReturnUrl("/studio/debugger/run_1?event=5#detail"), "/studio/debugger/run_1?event=5#detail");
  });

  it("rejects missing, empty and whitespace-only values", () => {
    assert.equal(safeReturnUrl(null), null);
    assert.equal(safeReturnUrl(undefined), null);
    assert.equal(safeReturnUrl(""), null);
    assert.equal(safeReturnUrl("   "), null);
    assert.equal(safeReturnUrl("\t\n"), null);
  });

  it("rejects absolute, protocol-relative, scheme and backslash URLs", () => {
    assert.equal(safeReturnUrl("https://evil.example"), null);
    assert.equal(safeReturnUrl("http://evil.example/path"), null);
    assert.equal(safeReturnUrl("//evil.example"), null);
    assert.equal(safeReturnUrl("javascript:alert(1)"), null);
    assert.equal(safeReturnUrl("/\\evil"), null);
    assert.equal(safeReturnUrl("/\\\\evil"), null);
    assert.equal(safeReturnUrl("\\\\evil.example"), null);
  });

  it("rejects control characters anywhere", () => {
    assert.equal(safeReturnUrl("/dash\u0000board"), null);
    assert.equal(safeReturnUrl("/dash\nboard"), null);
    assert.equal(safeReturnUrl("/dash\u007fboard"), null);
  });

  it("rejects the connect page but not lookalike paths", () => {
    assert.equal(safeReturnUrl("/connect"), null);
    assert.equal(safeReturnUrl("/connect?x=1"), null);
    assert.equal(safeReturnUrl("/connect#x"), null);
    assert.equal(safeReturnUrl("/connect "), null);
    assert.equal(safeReturnUrl("/connect/"), "/connect/");
    assert.equal(safeReturnUrl("/dashboard/connect"), "/dashboard/connect");
  });

  it("enforces the 2,048 character boundary on the trimmed value", () => {
    const longest = `/${"a".repeat(2047)}`;
    assert.equal(longest.length, 2048);
    assert.equal(safeReturnUrl(longest), longest);
    assert.equal(safeReturnUrl(`${longest}a`), null);
  });

  it("trims outer whitespace and returns the trimmed value", () => {
    assert.equal(safeReturnUrl("  /dashboard?x=1  "), "/dashboard?x=1");
    assert.equal(safeReturnUrl("\n/runs\t"), "/runs");
  });

  it("does not decode encoded characters", () => {
    assert.equal(safeReturnUrl("/%2F%2Fevil.example"), "/%2F%2Fevil.example");
    assert.equal(safeReturnUrl("/connect%3Fx=1"), "/connect%3Fx=1");
  });
});

describe("isMappingSlug", () => {
  it("accepts lowercase alphanumerics with internal hyphens", () => {
    assert.equal(isMappingSlug("a"), true);
    assert.equal(isMappingSlug("m1"), true);
    assert.equal(isMappingSlug("my-mapping"), true);
    assert.equal(isMappingSlug("a-b-c"), true);
    assert.equal(isMappingSlug("0"), true);
  });

  it("accepts exactly 60 characters and rejects 61", () => {
    const sixty = `a${"-".repeat(58)}0`;
    assert.equal(sixty.length, 60);
    assert.equal(isMappingSlug(sixty), true);
    assert.equal(isMappingSlug(`a${"-".repeat(59)}0`), false);
  });

  it("rejects uppercase, empty, misplaced hyphens, underscores, spaces and unicode", () => {
    assert.equal(isMappingSlug("Mapping"), false);
    assert.equal(isMappingSlug(""), false);
    assert.equal(isMappingSlug("-a"), false);
    assert.equal(isMappingSlug("a-"), false);
    assert.equal(isMappingSlug("-"), false);
    assert.equal(isMappingSlug("a_b"), false);
    assert.equal(isMappingSlug("a b"), false);
    assert.equal(isMappingSlug("café"), false);
    assert.equal(isMappingSlug("märklin"), false);
    assert.equal(isMappingSlug("m1\n"), false);
  });

  it("returns false for non-strings at runtime", () => {
    assert.equal(isMappingSlug(5 as unknown as string), false);
    assert.equal(isMappingSlug(null as unknown as string), false);
    assert.equal(isMappingSlug(undefined as unknown as string), false);
  });
});
