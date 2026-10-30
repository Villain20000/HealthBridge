/**
 * Windowed-list arithmetic for the trace timeline. Pure and framework-free so the scrolling
 * maths can be unit-tested without a DOM: callers render rows `[start, end)` and place them at
 * `offsetY` inside a spacer of `totalHeight`.
 */

export interface VirtualWindowInput {
  total: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight?: number;
  overscan?: number;
}

export interface VirtualWindow {
  start: number; // inclusive
  end: number; // exclusive
  offsetY: number; // start * rowHeight
  totalHeight: number; // total * rowHeight
}

const DEFAULT_ROW_HEIGHT = 34;
const DEFAULT_OVERSCAN = 8;

export function computeWindow(input: VirtualWindowInput): VirtualWindow {
  const total = normaliseTotal(input.total);
  const rowHeight = normaliseRowHeight(input.rowHeight);
  const overscan = normaliseOverscan(input.overscan);
  const viewportHeight = normaliseNonNegative(input.viewportHeight);
  const scrollTop = normaliseNonNegative(input.scrollTop);

  const totalHeight = total * rowHeight;
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const clampedScrollTop = Math.min(scrollTop, maxScrollTop);
  const first = total === 0 ? 0 : Math.min(total, Math.floor(clampedScrollTop / rowHeight));
  const visible = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visible + overscan);
  return { start, end, offsetY: start * rowHeight, totalHeight };
}

function normaliseTotal(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.max(0, Math.floor(value));
}

function normaliseRowHeight(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_ROW_HEIGHT;
  return value;
}

function normaliseOverscan(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_OVERSCAN;
  return Math.max(0, Math.floor(value));
}

function normaliseNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.max(0, value);
}
