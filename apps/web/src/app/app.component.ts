import { ChangeDetectionStrategy, Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";

@Component({
  selector: "hb-root",
  standalone: true,
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<a class="skip-link" href="#main" (click)="skipToMain($event)">Skip to content</a> <router-outlet />`,
})
export class AppComponent {
  protected skipToMain(event: Event): void {
    const main = document.getElementById("main");
    if (!main) return;
    event.preventDefault();
    main.focus();
    main.scrollIntoView({ block: "start" });
  }
}
