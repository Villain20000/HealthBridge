import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BreakpointsPanel } from "./breakpoints-panel";
import type { Breakpoint } from "./breakpoints.logic";

@Component({
  standalone: true,
  imports: [BreakpointsPanel],
  template: `
    <hb-breakpoints-panel
      [breakpoints]="bps"
      (add)="onAdd($event)"
      (remove)="onRemove($event)"
      (toggle)="onToggle($event)"
    />
  `,
})
class TestHost {
  bps: Breakpoint[] = [
    { id: "bp-1", kind: "seq", enabled: true, value: 42 },
    { id: "bp-2", kind: "status", enabled: false, value: "error" },
  ];

  added: Omit<Breakpoint, "id"> | null = null;
  removed: string | null = null;
  toggled: string | null = null;

  onAdd(bp: Omit<Breakpoint, "id">) {
    this.added = bp;
  }
  onRemove(id: string) {
    this.removed = id;
  }
  onToggle(id: string) {
    this.toggled = id;
  }
}

describe("BreakpointsPanel", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHost],
    }).compileComponents();
  });

  it("renders active breakpoints and emits toggle and remove", () => {
    const fixture = TestBed.createComponent(TestHost);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const items = element.querySelectorAll(".breakpoint-item");
    expect(items.length).toBe(2);

    const checkbox = items[0].querySelector("input[type='checkbox']") as HTMLInputElement;
    checkbox.click();
    expect(fixture.componentInstance.toggled).toBe("bp-1");

    const deleteBtn = items[0].querySelector(".delete-btn") as HTMLButtonElement;
    deleteBtn.click();
    expect(fixture.componentInstance.removed).toBe("bp-1");
  });

  it("does not emit add when seq or record value is non-numeric", () => {
    const fixture = TestBed.createComponent(TestHost);
    fixture.detectChanges();

    const panel = fixture.debugElement.children[0].componentInstance as BreakpointsPanel;
    panel.showAddForm.set(true);
    panel.newKind.set("seq");
    panel.newValue.set("abc");

    panel.onAddSubmit();
    expect(fixture.componentInstance.added).toBeNull();

    panel.newValue.set("42");
    panel.onAddSubmit();
    expect(fixture.componentInstance.added).toEqual({
      kind: "seq",
      enabled: true,
      value: 42,
    });
  });
});
