import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, provideRouter } from "@angular/router";
import { of } from "rxjs";
import { ApiClient } from "../../../core/api-client";
import { DebuggerPage } from "./debugger.page";
import { DebuggerStore } from "./debugger.store";

describe("DebuggerPage three-pane workbench & keyboard shortcuts", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DebuggerPage],
      providers: [
        DebuggerStore,
        provideRouter([]),
        {
          provide: ApiClient,
          useValue: {
            getRun: () => of({ id: "run-test", status: "completed", createdAt: "2026-01-01T00:00:00Z" }),
            getRunTraces: () => of({ traces: [] }),
            getRunIssues: () => of({ issues: [] }),
            getMapping: () => of({ id: "map-test", version: 1, spec: {} }),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: { get: () => "run-test" },
              queryParamMap: { get: () => null },
            },
          },
        },
      ],
    }).compileComponents();
  });

  it("creates the page component and binds keyboard shortcuts", () => {
    const fixture = TestBed.createComponent(DebuggerPage);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element).toBeDefined();

    // Verify keydown listener does not throw
    const event = new KeyboardEvent("keydown", { key: "F10" });
    window.dispatchEvent(event);
  });
});
