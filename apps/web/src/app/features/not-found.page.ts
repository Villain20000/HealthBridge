import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { AuthStore } from "../core/auth.store";

@Component({
  selector: "hb-not-found",
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty" style="margin-top: 48px">
      <h1>404</h1>
      <p class="subtle">That page does not exist in the console.</p>
      <p>
        @if (auth.isConnected()) {
          <a routerLink="/dashboard">Back to the dashboard</a>
        } @else {
          <a routerLink="/connect">Connect to an API</a>
        }
      </p>
    </div>
  `,
})
export class NotFoundPage {
  protected readonly auth = inject(AuthStore);
}
