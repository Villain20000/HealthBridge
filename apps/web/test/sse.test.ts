import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SseParser, parseFrame } from "../src/app/core/sse";

/**
 * SSE parsing is the one piece of browser code where a bug is silent: events simply never
 * arrive, or arrive twice. These tests pin the wire format, chunk boundaries, and dedupe.
 */
describe("SSE frame parser", () => {
  it("parses a named event with JSON data", () => {
    const frame = parseFrame('event: status\ndata: {"status":"running"}');
    assert.equal(frame?.event, "status");
    assert.equal(frame?.data, '{"status":"running"}');
  });

  it("joins multiple data lines with a newline, per the spec", () => {
    const frame = parseFrame("event: trace\ndata: line one\ndata: line two");
    assert.equal(frame?.data, "line one\nline two");
  });

  it("keeps the single leading space stripping rule and nothing more", () => {
    const frame = parseFrame("data:  two spaces");
    assert.equal(frame?.data, " two spaces");
  });

  it("defaults the event name to message", () => {
    assert.equal(parseFrame("data: hello")?.event, "message");
  });

  it("ignores heartbeat comments and blank lines", () => {
    const frame = parseFrame(": keep-alive\n\ndata: real");
    assert.equal(frame?.data, "real");
  });

  it("returns undefined when a block carries no recognised field", () => {
    assert.equal(parseFrame(": only a comment"), undefined);
  });

  it("carries id and retry", () => {
    const frame = parseFrame("id: 42\nretry: 1500\ndata: x");
    assert.equal(frame?.id, "42");
    assert.equal(frame?.retry, 1500);
  });

  it("ignores a non-numeric retry", () => {
    assert.equal(parseFrame("retry: soon\ndata: x")?.retry, undefined);
  });
});

describe("SSE incremental parser", () => {
  it("yields nothing until the blank line arrives", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push('event: status\ndata: {"a":1}'), []);
    assert.deepEqual(parser.push("\n\n"), [{ event: "status", data: '{"a":1}', id: undefined, retry: undefined }]);
  });

  it("survives a chunk boundary in the middle of a data value", () => {
    const parser = new SseParser();
    parser.push('event: status\ndata: {"stat');
    const frames = parser.push('us":"completed"}\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, '{"status":"completed"}');
  });

  it("survives a chunk boundary between CR and LF", () => {
    const parser = new SseParser();
    parser.push("event: status\r\ndata: one\r");
    const frames = parser.push("\n\r\n");
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, "one");
  });

  it("emits several frames that arrive in one chunk, in order", () => {
    const parser = new SseParser();
    const frames = parser.push("id: 1\ndata: a\n\nid: 2\ndata: b\n\n");
    assert.deepEqual(
      frames.map((frame) => frame.id),
      ["1", "2"],
    );
  });

  it("keeps an incomplete trailing frame buffered", () => {
    const parser = new SseParser();
    const frames = parser.push("data: complete\n\ndata: partial");
    assert.equal(frames.length, 1);
    assert.equal(parser.pending, "data: partial");
  });
});
