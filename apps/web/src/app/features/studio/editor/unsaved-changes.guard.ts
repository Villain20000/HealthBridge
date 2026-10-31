import { CanDeactivateFn } from "@angular/router";

/**
 * Pages that can be left with unsaved work implement this contract. The page owns the
 * confirmation UI: the guard never opens a browser dialog or blocks on `window.confirm`, because
 * the page needs to offer "retry save" and "discard and leave" inline.
 */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
  /** Called only when dirty. Return true to allow leaving. */
  confirmLeave(nextUrl: string): boolean | Promise<boolean>;
}

export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (
  component,
  _current,
  _currentState,
  nextState,
) => (component.hasUnsavedChanges() ? component.confirmLeave(nextState.url) : true);
