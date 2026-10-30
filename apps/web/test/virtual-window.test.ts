import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeWindow } from "../src/app/core/virtual-window";

/**
 * Window arithmetic for the trace timeline. Off-by-one errors here either hide the newest event
 * or render rows outside the list, so start/end/offset and every clamp are pinned explicitly.
 */
describe("computeWindow", () => {
  it("returns an empty window for an empty list", () => {
    assert.deepEqual(computeWindow({ total: 0, scrollTop: 0, viewportHeight: 400 }), {
      start: 0,
      end: 0,
      offsetY: 0,
      totalHeight: 0,
    });
    assert.deepEqual(computeWindow({ total: 0, scrollTop: 10_000, viewportHeight: 400 }), {
      start: 0,
      end: 0,
      offsetY: 0,
      totalHeight: 0,
    });
  });

  it("starts at the top with default row height and overscan", () => {
    assert.deepEqual(computeWindow({ total: 100, scrollTop: 0, viewportHeight: 340 }), {
      start: 0,
      end: 18,
      offsetY: 0,
      totalHeight: 3400,
    });
  });

  it("uses the exact row under the scroll position at a row boundary", () => {
    assert.deepEqual(computeWindow({ total: 100, scrollTop: 340, viewportHeight: 340 }), {
      start: 2,
      end: 28,
      offsetY: 68,
      totalHeight: 3400,
    });
  });

  it("clamps a scroll to the bottom and includes the last row", () => {
    const window = computeWindow({ total: 100, scrollTop: 1_000_000, viewportHeight: 340 });
    assert.deepEqual(window, { start: 82, end: 100, offsetY: 2788, totalHeight: 3400 });
    assert.equal(window.end, 100);
    assert.equal(window.end - 1, 99);
  });

  it("handles a huge list without losing the scroll position", () => {
    assert.deepEqual(computeWindow({ total: 1_000_000, scrollTop: 17_000_000, viewportHeight: 680 }), {
      start: 499_992,
      end: 500_028,
      offsetY: 16_999_728,
      totalHeight: 34_000_000,
    });
  });

  it("expands the window with overscan and clamps it at both ends", () => {
    const none = computeWindow({ total: 1000, scrollTop: 3400, viewportHeight: 340, overscan: 0 });
    assert.deepEqual(none, { start: 100, end: 110, offsetY: 3400, totalHeight: 34_000 });

    const wide = computeWindow({ total: 1000, scrollTop: 3400, viewportHeight: 340, overscan: 20 });
    assert.deepEqual(wide, { start: 80, end: 130, offsetY: 2720, totalHeight: 34_000 });

    const top = computeWindow({ total: 1000, scrollTop: 0, viewportHeight: 340, overscan: 20 });
    assert.deepEqual(top, { start: 0, end: 30, offsetY: 0, totalHeight: 34_000 });

    const bottom = computeWindow({ total: 1000, scrollTop: 33_660, viewportHeight: 340, overscan: 20 });
    assert.deepEqual(bottom, { start: 970, end: 1000, offsetY: 32_980, totalHeight: 34_000 });
  });

  it("honours a custom row height", () => {
    assert.deepEqual(computeWindow({ total: 100, scrollTop: 500, viewportHeight: 200, rowHeight: 50 }), {
      start: 2,
      end: 22,
      offsetY: 100,
      totalHeight: 5000,
    });
  });

  it("handles a zero-height viewport", () => {
    assert.deepEqual(computeWindow({ total: 100, scrollTop: 340, viewportHeight: 0 }), {
      start: 2,
      end: 18,
      offsetY: 68,
      totalHeight: 3400,
    });
    assert.deepEqual(computeWindow({ total: 100, scrollTop: 1_000_000, viewportHeight: 0 }), {
      start: 92,
      end: 100,
      offsetY: 3128,
      totalHeight: 3400,
    });
  });

  it("falls back or clamps for negative, NaN and infinite inputs", () => {
    assert.deepEqual(
      computeWindow({
        total: Number.NaN,
        scrollTop: Number.NaN,
        viewportHeight: Number.NaN,
        rowHeight: Number.NaN,
        overscan: Number.NaN,
      }),
      { start: 0, end: 0, offsetY: 0, totalHeight: 0 },
    );
    assert.deepEqual(computeWindow({ total: -10, scrollTop: -100, viewportHeight: -5, rowHeight: 0, overscan: -3 }), {
      start: 0,
      end: 0,
      offsetY: 0,
      totalHeight: 0,
    });
    assert.deepEqual(
      computeWindow({
        total: Infinity,
        scrollTop: Infinity,
        viewportHeight: Infinity,
        rowHeight: Infinity,
        overscan: Infinity,
      }),
      { start: 0, end: 0, offsetY: 0, totalHeight: 0 },
    );

    const invalidRowHeight = computeWindow({ total: 3, scrollTop: 0, viewportHeight: 34, rowHeight: -10 });
    assert.equal(invalidRowHeight.totalHeight, 3 * 34);
    const infiniteScroll = computeWindow({ total: 10, scrollTop: Infinity, viewportHeight: 100 });
    assert.equal(infiniteScroll.start, 0);
  });

  it("floors the total and overscan", () => {
    assert.equal(computeWindow({ total: 10.9, scrollTop: 0, viewportHeight: 34 }).totalHeight, 340);
    assert.deepEqual(computeWindow({ total: 100, scrollTop: 3400, viewportHeight: 340, overscan: 2.9 }), {
      start: 88,
      end: 100,
      offsetY: 2992,
      totalHeight: 3400,
    });
  });

  it("keeps the rendered window bounded on a huge list", () => {
    const window = computeWindow({ total: 1_000_000, scrollTop: 500_000, viewportHeight: 10 });
    assert.equal(window.end - window.start, 17);
    assert.ok(window.end <= 1_000_000);
    assert.ok(window.start >= 0);
  });
});
