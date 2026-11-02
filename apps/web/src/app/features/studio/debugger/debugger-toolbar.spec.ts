import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { DebuggerToolbar } from "./debugger-toolbar";

@Component({
  standalone: true,
  imports: [DebuggerToolbar],
  template: `
    <hb-debugger-toolbar
      [canPrevious]="canPrev"
      [canNext]="canNext"
      [hasBreakpoints]="true"
      [currentIndex]="currentIndex"
      [totalCount]="totalCount"
      [offFilterNotice]="notice"
      (continue)="onContinue()"
      (stepOver)="onStepOver()"
      (stepBack)="onStepBack()"
      (jumpNextError)="onNextError()"
      (jumpOffFilter)="onJumpOffFilter()"
    />
  `,
})
class TestHost {
  canPrev = true;
  canNext = true;
  currentIndex = 2;
  totalCount = 10;
  notice: { seq: number; label: string } | null = null;

  continued = false;
  steppedOver = false;
  steppedBack = false;
  nextError = false;
  jumpedOffFilter = false;

  onContinue() {
    this.continued = true;
  }
  onStepOver() {
    this.steppedOver = true;
  }
  onStepBack() {
    this.steppedBack = true;
  }
  onNextError() {
    this.nextError = true;
  }
  onJumpOffFilter() {
    this.jumpedOffFilter = true;
  }
}

describe("DebuggerToolbar", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHost],
    }).compileComponents();
  });

  it("renders stepping buttons and emits actions on click", () => {
    const fixture = TestBed.createComponent(TestHost);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const buttons = element.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(3);

    const continueBtn = Array.from(buttons).find((b) => b.textContent?.includes("Continue"));
    expect(continueBtn).toBeDefined();
    continueBtn?.click();
    expect(fixture.componentInstance.continued).toBe(true);

    const stepOverBtn = Array.from(buttons).find((b) => b.textContent?.includes("Step Over"));
    expect(stepOverBtn).toBeDefined();
    stepOverBtn?.click();
    expect(fixture.componentInstance.steppedOver).toBe(true);
  });

  it("shows off-filter alert when notice is set and emits jumpOffFilter on click", () => {
    const fixture = TestBed.createComponent(TestHost);
    fixture.componentInstance.notice = { seq: 42, label: "Error at event #42 is hidden by filter." };
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const alert = element.querySelector("[role='alert']");
    expect(alert).toBeDefined();
    expect(alert?.textContent).toContain("Error at event #42 is hidden by filter.");

    const jumpBtn = alert?.querySelector("button");
    jumpBtn?.click();
    expect(fixture.componentInstance.jumpedOffFilter).toBe(true);
  });
});
