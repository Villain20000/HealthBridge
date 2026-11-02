import { TestBed } from "@angular/core/testing";
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
            getRun: () => {},
            getRunTraces: () => {},
            getRunIssues: () => {},
            getMapping: () => {},
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
});
