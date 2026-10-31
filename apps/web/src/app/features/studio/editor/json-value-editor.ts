import { ChangeDetectionStrategy, Component, effect, input, output, signal } from "@angular/core";
import { formatJsonParam, parseJsonParam } from "./editor.logic";
import type { JsonParamShape } from "./editor.logic";

let nextEditorId = 0;

const UNSEEN = Symbol("unseen");

const SHAPE_TEXT: Record<JsonParamShape, string> = {
  "string-list": "a JSON array of non-empty strings",
  "string-map": "a JSON object whose values are strings",
  "scalar-array": "a JSON array of strings, finite numbers or booleans",
};

function describeError(error: string, shape: JsonParamShape): string {
  return error.startsWith("Expected") ? error : `${error} Expected ${SHAPE_TEXT[shape]}.`;
}

/**
 * Bounded JSON editor for object/list parameters and condition values.
 *
 * The textarea holds the author's text. Only valid JSON in the requested shape is emitted, so an
 * invalid intermediate keystroke never reaches the draft. Empty text clears the value. The parsed
 * value is shape-checked, never evaluated.
 */
@Component({
  selector: "hb-json-value-editor",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (label()) {
      <label [for]="id">{{ label() }}</label>
    }
    <textarea
      rows="4"
      spellcheck="false"
      class="mono"
      [id]="id"
      [attr.aria-label]="label() ? null : ariaLabel() || 'JSON value'"
      [attr.aria-invalid]="error() === null ? null : 'true'"
      [attr.aria-describedby]="id + '-hint'"
      [value]="text()"
      (input)="onInput($event)"
    ></textarea>
    @if (error(); as message) {
      <p class="meta" role="alert" [id]="id + '-hint'">{{ message }}</p>
    } @else {
      <p class="meta" [id]="id + '-hint'">
        Valid JSON is required; expected {{ shapeText() }}. Empty clears the value.
      </p>
    }
  `,
})
export class JsonValueEditor {
  public readonly value = input<unknown>(undefined);
  public readonly shape = input<JsonParamShape>("string-list");
  public readonly label = input("");
  public readonly ariaLabel = input("");
  /**
   * Changes when the edited value moves (another rule, another condition). Triggering a reset on
   * the context, not only on the value, keeps text such as an unparsed `[` from following the
   * author to a different rule whose value is equally empty.
   */
  public readonly contextKey = input("");

  public readonly valueChange = output<unknown>();

  protected readonly id = `hb-json-${nextEditorId++}`;
  protected readonly text = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly shapeText = signal(SHAPE_TEXT["string-list"]);

  private context: string | null = null;
  private seen: unknown = UNSEEN;
  private emitted: unknown = UNSEEN;

  public constructor() {
    effect(() => {
      const context = this.contextKey();
      const shape = this.shape();
      const value = this.value();
      const contextChanged = context !== this.context;
      const valueChanged = !Object.is(value, this.seen);
      if (!contextChanged && !valueChanged) return;

      this.shapeText.set(SHAPE_TEXT[shape]);
      this.context = context;
      this.seen = value;

      // Our own emission is echoed back by the parent: keep the author's text untouched.
      if (!contextChanged && Object.is(value, this.emitted)) {
        this.emitted = UNSEEN;
        return;
      }

      this.emitted = UNSEEN;
      this.text.set(formatJsonParam(value));
      this.error.set(null);
    });
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value;
    this.text.set(text);

    const shape = this.shape();
    this.shapeText.set(SHAPE_TEXT[shape]);
    const parsed = parseJsonParam(text, shape);
    if (!parsed.ok) {
      this.error.set(describeError(parsed.error, shape));
      return;
    }

    this.error.set(null);
    this.emitted = parsed.value;
    this.valueChange.emit(parsed.value);
  }
}
