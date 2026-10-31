import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { MAPPING_TRANSFORM_KINDS } from "@healthbridge/shared-types";
import type { ConditionOperator, MappingRule, RuleCondition, TransformFunctionKind } from "@healthbridge/shared-types";
import {
  JSON_PARAM_MAX_CHARS,
  defaultValueProblem,
  paramFields,
  parseConditionLiteral,
  usesDefaultValue,
} from "./editor.logic";
import type { ParamField, RulePatch } from "./editor.logic";
import { JsonValueEditor } from "./json-value-editor";

export interface RuleParamChange {
  readonly key: string;
  readonly value: unknown;
}

const CONDITION_OPERATORS: readonly ConditionOperator[] = [
  "exists",
  "not_exists",
  "equals",
  "not_equals",
  "in",
  "not_in",
  "matches",
  "gt",
  "gte",
  "lt",
  "lte",
];

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

/**
 * Edits one mapping rule. The form never mutates the rule: it emits a patch (`ruleChange`) or a
 * single parameter change (`paramChange`) and the editor store applies it to the draft.
 *
 * Conditions are edited as whole immutable arrays: every path, operator or value change emits one
 * `when` patch. `in`/`not_in` use the bounded JSON editor with the `scalar-array` shape, and a
 * `matches` value shows an inline hint when the regular expression cannot be parsed (the text is
 * still emitted; the server remains authoritative).
 */
@Component({
  selector: "hb-rule-form",
  standalone: true,
  imports: [JsonValueEditor],
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
            [attr.maxlength]="maxDefaultChars"
            [attr.aria-invalid]="defaultProblem() === null ? null : 'true'"
            [attr.aria-describedby]="defaultDescribedBy()"
            [value]="defaultText()"
            (input)="ruleChange.emit({ defaultValue: parseDefault($event) })"
          />
          <p class="meta" [id]="id('default-help')">
            Plain text is stored as text. Numbers, true, false, null and JSON are stored with their type. At most 10,000
            characters.
          </p>
          @if (defaultProblem(); as problem) {
            <p class="meta" role="alert" [id]="id('default-error')">{{ problem }}</p>
          }
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
                  <hb-json-value-editor
                    [label]="field.label"
                    shape="string-list"
                    [value]="param(field.key)"
                    [contextKey]="rule().id + ':param:' + field.key"
                    (valueChange)="paramChange.emit({ key: field.key, value: $event })"
                  />
                }
                @case ("string-map") {
                  <hb-json-value-editor
                    [label]="field.label"
                    shape="string-map"
                    [value]="param(field.key)"
                    [contextKey]="rule().id + ':param:' + field.key"
                    (valueChange)="paramChange.emit({ key: field.key, value: $event })"
                  />
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

      <fieldset class="params">
        <legend>Conditions</legend>
        <p class="meta">All conditions must hold for the rule to run.</p>
        @if ((rule().when ?? []).length === 0) {
          <p class="meta">This rule always runs.</p>
        } @else {
          <ul>
            @for (condition of rule().when ?? []; track $index; let i = $index) {
              <li style="margin-bottom: var(--space-3)">
                <div class="grid cols-3">
                  <div class="field">
                    <label [for]="id('cond-path-' + i)">Condition {{ i + 1 }} path</label>
                    <input
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      [id]="id('cond-path-' + i)"
                      [value]="condition.path"
                      (input)="updateCondition(i, { path: value($event) })"
                    />
                  </div>
                  <div class="field">
                    <label [for]="id('cond-op-' + i)">Condition {{ i + 1 }} operator</label>
                    <select [id]="id('cond-op-' + i)" (change)="updateCondition(i, { op: operatorOf($event) })">
                      @for (operator of operators; track operator) {
                        <option [value]="operator" [selected]="operator === condition.op">{{ operator }}</option>
                      }
                    </select>
                  </div>
                  <div class="field">
                    @if (condition.op === "exists" || condition.op === "not_exists") {
                      <p class="meta">No value is needed for this operator.</p>
                    } @else if (condition.op === "in" || condition.op === "not_in") {
                      <hb-json-value-editor
                        [label]="'Condition ' + (i + 1) + ' values'"
                        shape="scalar-array"
                        [value]="condition.value"
                        [contextKey]="rule().id + ':when:' + i + ':' + condition.op"
                        (valueChange)="updateCondition(i, { value: $event })"
                      />
                    } @else if (condition.op === "matches") {
                      <label [for]="id('cond-value-' + i)">Condition {{ i + 1 }} pattern</label>
                      <input
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        [id]="id('cond-value-' + i)"
                        [value]="conditionValueText(condition.value)"
                        (input)="updateConditionText(i, $event)"
                      />
                      @if (regexInvalid(condition.value)) {
                        <p class="meta" role="alert">Invalid regular expression.</p>
                      }
                    } @else {
                      <label [for]="id('cond-value-' + i)">Condition {{ i + 1 }} value</label>
                      <input
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        [id]="id('cond-value-' + i)"
                        [value]="conditionValueText(condition.value)"
                        (input)="updateConditionLiteral(i, $event)"
                      />
                    }
                  </div>
                </div>
                <button class="small" type="button" (click)="removeCondition(i)">Remove condition {{ i + 1 }}</button>
              </li>
            }
          </ul>
        }
        <button class="small" type="button" (click)="addCondition()">Add condition</button>
      </fieldset>

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
  protected readonly operators: readonly ConditionOperator[] = CONDITION_OPERATORS;
  protected readonly maxDefaultChars = JSON_PARAM_MAX_CHARS;
  protected readonly fields = computed<readonly ParamField[]>(() => paramFields(this.rule().transform));
  protected readonly showDefault = computed(() => usesDefaultValue(this.rule().transform));
  protected readonly defaultText = computed(() => formatDefaultValue(this.rule().defaultValue));
  protected readonly defaultProblem = computed(() => defaultValueProblem(this.rule().defaultValue));

  private readonly prefix = `rule-form-${nextFormId++}`;

  protected id(part: string): string {
    return `${this.prefix}-${part}`;
  }

  protected defaultDescribedBy(): string {
    const help = this.id("default-help");
    return this.defaultProblem() === null ? help : `${help} ${this.id("default-error")}`;
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

  protected operatorOf(event: Event): ConditionOperator {
    return inputValue(event) as ConditionOperator;
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

  /** A condition value as editable text: strings stay literal, other JSON keeps its compact form. */
  protected conditionValueText(value: unknown): string {
    if (value === undefined) return "";
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  }

  protected regexInvalid(value: unknown): boolean {
    if (typeof value !== "string" || value.length === 0) return false;
    try {
      new RegExp(value);
      return false;
    } catch {
      return true;
    }
  }

  protected addCondition(): void {
    const added: RuleCondition = { path: "", op: "equals" };
    this.ruleChange.emit({ when: [...(this.rule().when ?? []), added] });
  }

  protected removeCondition(index: number): void {
    const rows = (this.rule().when ?? []).filter((_condition, at) => at !== index);
    this.ruleChange.emit({ when: rows.length > 0 ? rows : undefined });
  }

  protected updateCondition(index: number, patch: Partial<RuleCondition>): void {
    const rows = (this.rule().when ?? []).map((condition, at) =>
      at === index ? { ...condition, ...patch } : condition,
    );
    this.ruleChange.emit({ when: rows.length > 0 ? rows : undefined });
  }

  protected updateConditionText(index: number, event: Event): void {
    const text = inputValue(event);
    this.updateCondition(index, { value: text.length > 0 ? text : undefined });
  }

  protected updateConditionLiteral(index: number, event: Event): void {
    this.updateCondition(index, { value: parseConditionLiteral(inputValue(event)) });
  }
}
