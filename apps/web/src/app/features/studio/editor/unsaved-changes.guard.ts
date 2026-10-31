import { CanDeactivateFn } from "@angular/router";

export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes. Leave this page and discard them?";

export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component.hasUnsavedChanges()) {
    return true;
  }
  return window.confirm(UNSAVED_CHANGES_MESSAGE);
};
