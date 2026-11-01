import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ApiProblem } from "../core/api-types";
import { EmptyState, ErrorPanel, LoadingState, StatusChip, PlannedCard } from "./primitives";

describe("StatusChip", () => {
  function render(status: string): HTMLElement {
    const fixture = TestBed.createComponent(StatusChip);
    fixture.componentRef.setInput("status", status);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it("renders the human label and an accessible status name", () => {
    const el = render("completed_with_warnings");
    const chip = el.querySelector("span.chip") as HTMLElement;
    expect(chip.textContent?.trim()).toBe("Completed with warnings");
    expect(chip.getAttribute("aria-label")).toBe("Status: Completed with warnings");
  });

  it("maps each lifecycle status to its documented tone", () => {
    expect(render("completed").querySelector("span.chip")?.className).toContain("ok");
    expect(render("failed").querySelector("span.chip")?.className).toContain("danger");
    expect(render("running").querySelector("span.chip")?.className).toContain("info");
    expect(render("queued").querySelector("span.chip")?.className).toContain("muted");
  });

  it("falls back to a muted tone for an unknown status instead of throwing", () => {
    const chip = render("something_new").querySelector("span.chip") as HTMLElement;
    expect(chip.className).toContain("muted");
    expect(chip.textContent?.trim().length).toBeGreaterThan(0);
  });
});

describe("ErrorPanel", () => {
  const problem: ApiProblem = {
    code: "UNAUTHORIZED",
    message: "The API key was rejected.",
    status: 401,
    requestId: "req-123",
  };

  it("renders nothing without a problem", () => {
    const fixture = TestBed.createComponent(ErrorPanel);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector(".error-panel")).toBeNull();
  });

  it("announces the code, status and request id", () => {
    const fixture = TestBed.createComponent(ErrorPanel);
    fixture.componentRef.setInput("problem", problem);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector("[role=alert]")).not.toBeNull();
    expect(el.textContent).toContain("UNAUTHORIZED");
    expect(el.textContent).toContain("401");
    expect(el.textContent).toContain("req-123");
  });

  it("omits the request id line when the API did not supply one", () => {
    const fixture = TestBed.createComponent(ErrorPanel);
    fixture.componentRef.setInput("problem", { ...problem, requestId: undefined });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain("request");
  });

  it("only offers a retry button when asked, and emits on click", () => {
    const fixture = TestBed.createComponent(ErrorPanel);
    fixture.componentRef.setInput("problem", problem);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector("button")).toBeNull();

    let retried = 0;
    fixture.componentInstance.retry.subscribe(() => (retried += 1));
    fixture.componentRef.setInput("showRetry", true);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector("button")?.click();
    expect(retried).toBe(1);
  });
});

describe("EmptyState and LoadingState", () => {
  @Component({
    standalone: true,
    imports: [EmptyState],
    template: `<hb-empty title="No runs" message="Submit one to see it here">
      <button type="button">Submit</button>
    </hb-empty>`,
  })
  class Host {}

  it("projects the caller's action inside the empty state", () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector("h3")?.textContent).toContain("No runs");
    expect(el.textContent).toContain("Submit one to see it here");
    expect(el.querySelector("button")?.textContent).toContain("Submit");
  });

  it("labels a loading region as a live status with a default label", () => {
    const fixture = TestBed.createComponent(LoadingState);
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector("[role=status]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toContain("Loading");
  });
});

describe("PlannedCard", () => {
  it("states that a featured capability is not implemented", () => {
    const fixture = TestBed.createComponent(PlannedCard);
    fixture.componentRef.setInput("title", "Mapping studio");
    fixture.componentRef.setInput("detail", "Edit mappings visually.");
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Mapping studio");
    expect(text.toLowerCase()).toContain("planned");
  });
});
