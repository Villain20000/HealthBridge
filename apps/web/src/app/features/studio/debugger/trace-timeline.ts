import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { VirtualWindow } from "../../../core/virtual-window";
import { computeWindow } from "../../../core/virtual-window";
import { EmptyState } from "../../../ui/primitives";
import type { DebuggerEvent } from "./trace.logic";

/**
 * Stored trace timeline. One row per stored event, windowed above 200 events so a long run
 * stays responsive. Selection is owned by the parent; this component only emits `seq`.
 */

const ROW_HEIGHT = 34;
const MAX_FULL_RENDER = 200;
const FALLBACK_VIEWPORT_HEIGHT = 480;
const OVERSCAN = 8;

export type EventStatusTone = "ok" | "warn" | "danger" | "muted";

/** The raw status is the chip text; the tone only reinforces it. */
export function statusTone(status: string): EventStatusTone {
  switch (status) {
    case "success":
      return "ok";
    case "warning":
      return "warn";
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

interface TimelineRow {
  event: DebuggerEvent;
  index: number;
}

@Component({
  selector: "hb-trace-timeline",
  standalone: true,
  imports: [EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>

    @if (events().length === 0) {
      <hb-empty
        title="No events match these filters"
        message="Clear a filter or widen the search to see stored events."
      />
    } @else {
      <div
        #scroller
        class="timeline"
        role="listbox"
        tabindex="0"
        aria-label="Stored trace events"
        [attr.aria-activedescendant]="activeDescendant()"
        (scroll)="onScroll($event)"
        (keydown)="onKeydown($event)"
      >
        <div class="spacer" role="presentation" [style.height.px]="totalHeight()">
          <div class="rows" role="presentation" [style.transform]="offsetTransform()">
            @for (row of rows(); track row.event.seq) {
              <div
                class="row"
                role="option"
                [id]="'hb-trace-option-' + row.event.seq"
                [attr.aria-selected]="row.event.seq === selectedSeq()"
                [attr.aria-posinset]="row.index + 1"
                [attr.aria-setsize]="events().length"
                (click)="selectSeq.emit(row.event.seq)"
              >
                <span class="seq">{{ row.event.seq }}</span>
                <span class="stage">{{ row.event.stage }}</span>
                <span class="step">{{ row.event.stepName || "not recorded" }}</span>
                <span class="chip" [class]="toneForEvent(row.event.status)">{{ row.event.status }}</span>
                @if (row.event.recordIndex !== null) {
                  <span class="meta">record {{ row.event.recordIndex }}</span>
                }
                @if (row.event.issues.length > 0) {
                  <span class="meta">{{ row.event.issues.length }} issues</span>
                }
                @if (row.event.redacted === true) {
                  <span class="meta">redacted</span>
                } @else if (row.event.redacted === false) {
                  <span class="meta">not redacted</span>
                }
              </div>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .timeline {
      max-height: 60vh;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-inset);
      position: relative;
    }

    .timeline:focus-visible {
      outline: none;
      box-shadow: var(--focus);
    }

    .row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      height: 34px;
      box-sizing: border-box;
      padding: 0 var(--space-3);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      overflow: hidden;
      white-space: nowrap;
    }

    .row:hover {
      background: var(--bg-hover);
    }

    .row[aria-selected="true"] {
      background: var(--accent-soft);
    }

    .seq {
      flex: none;
      width: 48px;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .stage {
      flex: none;
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
      color: var(--text-muted);
    }

    .step {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .meta {
      flex: none;
      font-size: 12px;
      color: var(--text-muted);
    }
  `,
})
export class TraceTimeline {
  public readonly events = input.required<DebuggerEvent[]>();
  public readonly selectedSeq = input<number | null>(null);
  public readonly selectSeq = output<number>();

  private readonly scroller = viewChild<ElementRef<HTMLElement>>("scroller");
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(0);

  protected readonly toneForEvent = statusTone;

  private readonly virtualised = computed(() => this.events().length > MAX_FULL_RENDER);

  private readonly virtualWindow = computed<VirtualWindow | null>(() => {
    if (!this.virtualised()) return null;
    return computeWindow({
      total: this.events().length,
      scrollTop: this.scrollTop(),
      viewportHeight: this.viewportHeight() > 0 ? this.viewportHeight() : FALLBACK_VIEWPORT_HEIGHT,
      rowHeight: ROW_HEIGHT,
      overscan: OVERSCAN,
    });
  });

  protected readonly rows = computed<readonly TimelineRow[]>(() => {
    const events = this.events();
    const window = this.virtualWindow();
    if (window === null) return events.map((event, index) => ({ event, index }));
    return events.slice(window.start, window.end).map((event, offset) => ({
      event,
      index: window.start + offset,
    }));
  });

  protected readonly totalHeight = computed<number | null>(() => this.virtualWindow()?.totalHeight ?? null);

  protected readonly offsetTransform = computed<string | null>(() => {
    const window = this.virtualWindow();
    return window === null ? null : `translateY(${window.offsetY}px)`;
  });

  private readonly activeIndex = computed(() => {
    const seq = this.selectedSeq();
    if (seq === null) return -1;
    return this.events().findIndex((event) => event.seq === seq);
  });

  protected readonly activeDescendant = computed<string | null>(() => {
    const seq = this.selectedSeq();
    if (seq === null) return null;
    // Only reference an option that is actually rendered: the window may not contain the
    // selection until the selection effect scrolls it into view.
    return this.rows().some((row) => row.event.seq === seq) ? `hb-trace-option-${seq}` : null;
  });

  protected readonly announcement = computed(() => {
    const index = this.activeIndex();
    if (index === -1) return "No event selected";
    return `Event ${index + 1} of ${this.events().length} selected`;
  });

  public constructor() {
    effect(() => {
      const element = this.scroller()?.nativeElement;
      if (element === undefined) return;
      // A recreated scroller starts at 0; reconcile the signal so the first window renders.
      this.scrollTop.set(element.scrollTop);
      this.measureViewport(element);
    });

    effect(() => {
      const seq = this.selectedSeq();
      const events = this.events();
      if (seq === null) return;

      const index = events.findIndex((event) => event.seq === seq);
      if (index === -1) return;

      const window = untracked(() => this.virtualWindow());
      const scroller = this.scroller()?.nativeElement;
      if (window !== null && scroller !== undefined && (index < window.start || index >= window.end)) {
        scroller.scrollTop = index * ROW_HEIGHT;
        this.scrollTop.set(scroller.scrollTop);
      }

      queueMicrotask(() => {
        this.optionElement(seq)?.scrollIntoView({ block: "nearest" });
      });
    });
  }

  protected onScroll(event: Event): void {
    const element = event.target as HTMLElement;
    this.scrollTop.set(element.scrollTop);
    this.measureViewport(element);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const events = this.events();
    if (events.length === 0) return;

    const current = this.activeIndex();
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = current === -1 ? 0 : current + 1;
        break;
      case "ArrowUp":
        next = current === -1 ? events.length - 1 : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = events.length - 1;
        break;
      case "PageDown":
        next = (current === -1 ? 0 : current) + 10;
        break;
      case "PageUp":
        next = (current === -1 ? events.length - 1 : current) - 10;
        break;
      default:
        return;
    }

    event.preventDefault();
    const clamped = Math.min(events.length - 1, Math.max(0, next));
    if (clamped !== current) this.selectSeq.emit(events[clamped].seq);
  }

  private measureViewport(element: HTMLElement): void {
    const height = element.clientHeight;
    if (height > 0 && height !== this.viewportHeight()) this.viewportHeight.set(height);
  }

  private optionElement(seq: number): HTMLElement | null {
    return this.scroller()?.nativeElement.querySelector<HTMLElement>(`#hb-trace-option-${seq}`) ?? null;
  }
}
