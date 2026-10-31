import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { MAPPING_TRANSFORM_KINDS } from "@healthbridge/shared-types";
import type { MappingRule, TransformFunctionKind } from "@healthbridge/shared-types";
import { paramFields, usesDefaultValue } from "./editor.logic";
import type { ParamField, RulePatch } from "./editor.logic";

export interface RuleParamChange {
  readonly key: string;
  readonly value: unknown;
}

let nextFormId = 0;

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
}

function isChecked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked;
}

/** Shows a default value as JSON when plain text would be read back as a different type. */
export function formatDefaultValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    if (value.length === 0) {
      return '""';
    }
    try {
      return typeof JSON.parse(value) === "string" ? value : JSON.stringify(value);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value);
}

/** Reads typed text back: valid JSON keeps its type (number, boolean, null, object), anything else is a string. */
export function parseDefaultValue(text: string): unknown {
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatList(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).join("\n") : "";
}

function parseList(text: string): string[] | undefined {
  const items = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return items.length > 0 ? items : undefined;
}

function formatMap(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${key}=${String(entry)}`)
    .join("\n");
}

function parseMap(text: string): Record<string, string> | undefined {
  const entries: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0) {
      continue;
    }
    const key = line.slice(0, at).trim();
    if (key.length > 0) {
      entries[key] = line.slice(at + 1).trim();
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

/**
 * Edits one mapping rule. The form never mutates the rule: it emits a patch (`ruleChange`) or a
 * single parameter change (`paramChange`) and the editor store applies it to the draft.
 */
@Component({
  selector: "hb-rule-form",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="rule-form" (submit)="$event.preventDefault()" [attr.aria-label]="'Rule ' + rule().id">
      <div class="field">
        <label [for]="id('source')">Source path</label>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          [id]="id('source')"
          [value]="rule().sourcePath"
          (input)="ruleChange.emit({ sourcePath: value($event) })"
        />
      </div>

      <div class="field">
        <label [for]="id('target')">Target path</label>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          [id]="id('target')"
          [value]="rule().targetPath"
          (input)="ruleChange.emit({ targetPath: value($event) })"
        />
      </div>

      <div class="field">
        <label [for]="id('transform')">Transform</label>
        <select [id]="id('transform')" (change)="ruleChange.emit({ transform: transformOf($event) })">
          @for (kind of transforms; track kind) {
            <option [value]="kind" [selected]="kind === rule().transform">{{ kind }}</option>
          }
        </select>
      </div>

      @if (showDefault()) {
        <div class="field">
          <label [for]="id('default')">Default value</label>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            [id]="id('default')"
            [attr.aria-describedby]="id('default-help')"
            [value]="defaultText()"
            (input)="ruleChange.emit({ defaultValue: parseDefault($event) })"
          />
          <p class="meta" [id]="id('default-help')">
            Plain text is stored as text. Numbers, true, false, null and JSON are stored with their type.
          </p>
        </div>
      }

      @if (fields().length > 0) {
        <fieldset class="params">
          <legend>Parameters</legend>
          @for (field of fields(); track field.key) {
            <div class="field">
              @switch (field.kind) {
                @case ("boolean") {
                  <label>
                    <input
                      type="checkbox"
                      [checked]="param(field.key) === true"
                      [attr.aria-describedby]="field.help ? id('help-' + field.key) : null"
                      (change)="paramChange.emit({ key: field.key, value: checked($event) ? true : undefined })"
                    />
                    {{ field.label }}
                  </label>
                }
                @case ("string-list") {
                  <label [for]="id('p-' + field.key)">{{ field.label }} (one per line)</label>
                  <textarea
                    rows="3"
                    spellcheck="false"
                    [id]="id('p-' + field.key)"
                    [attr.aria-describedby]="field.help ? id('help-' + field.key) : null"
                    [value]="listText(field.key)"
                    (input)="paramChange.emit({ key: field.key, value: parseList($event) })"
                  ></textarea>
                }
                @case ("string-map") {
                  <label [for]="id('p-' + field.key)">{{ field.label }} (one key=value per line)</label>
                  <textarea
                    rows="3"
                    spellcheck="false"
                    [id]="id('p-' + field.key)"
                    [attr.aria-describedby]="field.help ? id('help-' + field.key) : null"
                    [value]="mapText(field.key)"
                    (input)="paramChange.emit({ key: field.key, value: parseMap($event) })"
                  ></textarea>
                }
                @case ("number") {
                  <label [for]="id('p-' + field.key)">{{ field.label }}</label>
                  <input
                    type="number"
                    [id]="id('p-' + field.key)"
                    [attr.aria-describedby]="field.help ? id('help-' + field.key) : null"
                    [attr.placeholder]="field.defaultText ?? null"
                    [attr.aria-required]="field.required ? 'true' : null"
                    [value]="textParam(field.key)"
                    (input)="paramChange.emit({ key: field.key, value: parseNumber($event) })"
                  />
                }
                @default {
                  <label [for]="id('p-' + field.key)">{{ field.label }}</label>
                  <input
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    [id]="id('p-' + field.key)"
                    [attr.aria-describedby]="field.help ? id('help-' + field.key) : null"
                    [attr.placeholder]="field.defaultText ?? null"
                    [attr.aria-required]="field.required ? 'true' : null"
                    [value]="textParam(field.key)"
                    (input)="paramChange.emit({ key: field.key, value: parseText($event) })"
                  />
                }
              }
              @if (field.help) {
                <p class="meta" [id]="id('help-' + field.key)">{{ field.help }}</p>
              }
            </div>
          }
        </fieldset>
      }

      <div class="field">
        <label>
          <input
            type="checkbox"
            [checked]="rule().required === true"
            (change)="ruleChange.emit({ required: checked($event) ? true : undefined })"
          />
          Required: reject the record when this rule produces no value
        </label>
      </div>

      <div class="field">
        <label [for]="id('description')">Description</label>
        <textarea
          rows="2"
          [id]="id('description')"
          [value]="rule().description ?? ''"
          (input)="ruleChange.emit({ description: nonEmpty($event) })"
        ></textarea>
      </div>
    </form>
  `,
})
export class RuleForm {
  public readonly rule = input.required<MappingRule>();

  public readonly ruleChange = output<RulePatch>();
  public readonly paramChange = output<RuleParamChange>();

  protected readonly transforms: readonly TransformFunctionKind[] = MAPPING_TRANSFORM_KINDS;
  protected readonly fields = computed<readonly ParamField[]>(() => paramFields(this.rule().transform));
  protected readonly showDefault = computed(() => usesDefaultValue(this.rule().transform));
  protected readonly defaultText = computed(() => formatDefaultValue(this.rule().defaultValue));

  private readonly prefix = `rule-form-${nextFormId++}`;

  protected id(part: string): string {
    return `${this.prefix}-${part}`;
  }

  protected value(event: Event): string {
    return inputValue(event);
  }

  protected checked(event: Event): boolean {
    return isChecked(event);
  }

  protected transformOf(event: Event): TransformFunctionKind {
    return inputValue(event) as TransformFunctionKind;
  }

  protected nonEmpty(event: Event): string | undefined {
    const text = inputValue(event);
    return text.trim().length > 0 ? text : undefined;
  }

  protected parseDefault(event: Event): unknown {
    return parseDefaultValue(inputValue(event));
  }

  protected param(key: string): unknown {
    return this.rule().params?.[key];
  }

  protected textParam(key: string): string {
    const value = this.param(key);
    return value === undefined || value === null ? "" : String(value);
  }

  protected listText(key: string): string {
    return formatList(this.param(key));
  }

  protected mapText(key: string): string {
    return formatMap(this.param(key));
  }

  protected parseText(event: Event): string | undefined {
    const text = inputValue(event);
    return text.length > 0 ? text : undefined;
  }

  protected parseNumber(event: Event): number | undefined {
    const text = inputValue(event).trim();
    if (text.length === 0) {
      return undefined;
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  protected parseList(event: Event): string[] | undefined {
    return parseList(inputValue(event));
  }

  protected parseMap(event: Event): Record<string, string> | undefined {
    return parseMap(inputValue(event));
  }
}
