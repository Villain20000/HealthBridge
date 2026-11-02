import { TestBed } from "@angular/core/testing";
import { of } from "rxjs";
import { ApiClient } from "../../../core/api-client";
import { DebuggerStore } from "./debugger.store";

describe("DebuggerStore breakpoints & stepping", () => {
  let store: DebuggerStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        DebuggerStore,
        {
          provide: ApiClient,
          useValue: {
            getRun: () => of({ id: "run-1", mappingId: "m-1" }),
            getRunTraces: () => of({ traces: [] }),
            getRunIssues: () => of({ issues: [] }),
            getMapping: () => of({ id: "m-1", rules: [] }),
          },
        },
      ],
    });
    store = TestBed.inject(DebuggerStore);
  });

  it("starts with empty breakpoints and no off-filter notice", () => {
    expect(store.breakpoints()).toEqual([]);
    expect(store.breakpointSeqs().size).toBe(0);
    expect(store.offFilterNotice()).toBeNull();
  });

  it("toggles sequence breakpoints", () => {
    store.toggleSeqBreakpoint(10);
    expect(store.breakpointSeqs().has(10)).toBe(true);
    expect(store.breakpoints().length).toBe(1);
    expect(store.breakpoints()[0].kind).toBe("seq");
    expect(store.breakpoints()[0].value).toBe(10);

    store.toggleSeqBreakpoint(10);
    expect(store.breakpointSeqs().has(10)).toBe(false);
    expect(store.breakpoints().length).toBe(0);
  });

  it("adds, toggles enabled state, and removes custom breakpoints", () => {
    store.addBreakpoint({
      kind: "status",
      enabled: true,
      value: "error",
    });
    expect(store.breakpoints().length).toBe(1);
    const id = store.breakpoints()[0].id;

    store.toggleBreakpoint(id);
    expect(store.breakpoints()[0].enabled).toBe(false);

    store.removeBreakpoint(id);
    expect(store.breakpoints().length).toBe(0);
  });

  it("toggles off sequence breakpoint even if value was stored as a string", () => {
    store.addBreakpoint({
      kind: "seq",
      enabled: true,
      value: "42" as any,
    });
    expect(store.breakpoints().length).toBe(1);
    expect(store.breakpointSeqs().has(42)).toBe(true);

    store.toggleSeqBreakpoint(42);
    expect(store.breakpoints().length).toBe(0);
    expect(store.breakpointSeqs().has(42)).toBe(false);
  });

  it("resets breakpoints on load when switching to a run without cached breakpoints", () => {
    sessionStorage.setItem("healthbridge:debugger:bp:run-1", JSON.stringify([{ id: "bp-1", kind: "seq", enabled: true, value: 1 }]));
    sessionStorage.removeItem("healthbridge:debugger:bp:run-2");

    store.load("run-1");
    expect(store.breakpoints().length).toBe(1);

    store.load("run-2");
    expect(store.breakpoints().length).toBe(0);
  });
});
