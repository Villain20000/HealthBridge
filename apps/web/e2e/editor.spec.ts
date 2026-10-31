import type { Page } from "@playwright/test";
import { clientNavigate, expect, test } from "./support/fixtures";

/**
 * Mapping editor end-to-end coverage (`/studio/editor/:name`).
 *
 * These specs use the mapping the seed reserves for the editor (`state.editorMappingName`), so the
 * drafts they save and the versions they publish never change the mapping the run and debugger
 * specs read. The suite runs serially with a single worker (see playwright.config.ts), so editing
 * one shared mapping across specs is safe.
 *
 * The save indicator is `p.save-status` and exposes its state in `data-state`
 * (idle | dirty | saving | saved | conflict | error). The specs wait on that state instead of a
 * fixed delay, so they stay correct if the 800 ms autosave debounce changes. The page has two
 * other `role="status"` elements (a screen-reader announcer and the publish banner), which is why
 * the indicator is selected by its class.
 */

const SAVE_TIMEOUT_MS = 10_000;

function saveStatus(page: Page) {
  return page.locator("p.save-status");
}

async function openEditor(page: Page, name: string): Promise<void> {
  await clientNavigate(page, `/studio/editor/${name}`);
  await expect(page.getByRole("heading", { level: 1, name: "Mapping editor" })).toBeVisible();
  // The first seeded rule is selected once the draft has loaded.
  await expect(page.getByRole("form", { name: "Rule r1", exact: true })).toBeVisible();
}

test.describe("mapping editor", () => {
  test("opens from the mappings list and loads the seeded rules", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "Mappings", exact: true }).click();
    await expect(page).toHaveURL(/\/mappings$/);

    const row = page.getByRole("row").filter({ hasText: state.editorMappingName });
    await row.getByRole("link", { name: "Edit draft", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/studio/editor/${state.editorMappingName}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Mapping editor" })).toBeVisible();
    await expect(page.locator("span.mono", { hasText: state.editorMappingName })).toBeVisible();

    const rules = page.getByRole("region", { name: "Mapping rules", exact: true });
    await expect(rules.getByRole("heading", { name: "Rules (6)", exact: true })).toBeVisible();
    await expect(page.getByRole("form", { name: "Rule r1", exact: true })).toBeVisible();
    await expect(saveStatus(page)).toHaveAttribute("data-state", "idle");
  });

  test("autosaves a rule edit and reports the saved revision", async ({ console: page, state }) => {
    await openEditor(page, state.editorMappingName);

    const target = page.getByRole("form", { name: "Rule r1", exact: true }).getByLabel("Target path", { exact: true });
    await target.fill("id_edited");

    await expect(saveStatus(page)).toHaveAttribute("data-state", "dirty");
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: SAVE_TIMEOUT_MS });
    await expect(saveStatus(page)).toHaveText(/^Saved · revision [1-9]\d*$/);

    // Put the original value back so later specs start from the seeded rule.
    await target.fill("id");
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: SAVE_TIMEOUT_MS });
  });

  test("undo and redo move a field edit back and forward", async ({ console: page, state }) => {
    await openEditor(page, state.editorMappingName);

    const version = page.getByLabel("Version", { exact: true });
    const original = await version.inputValue();

    await version.fill("9.9.9");
    await expect(version).toHaveValue("9.9.9");

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(version).toHaveValue(original);

    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(version).toHaveValue("9.9.9");

    // Undo once more and wait for autosave to settle, so the draft ends on the original value.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(version).toHaveValue(original);
    await expect(saveStatus(page)).toHaveAttribute("data-state", /^(idle|saved)$/, { timeout: SAVE_TIMEOUT_MS });
  });

  test("runs a preview against the seeded asset", async ({ console: page, state }) => {
    await openEditor(page, state.editorMappingName);

    // The asset options are loaded asynchronously; selectOption waits for the option to appear.
    await page.getByLabel("Asset", { exact: true }).selectOption(state.assetId);
    await page.getByRole("button", { name: "Run preview", exact: true }).click();

    const processed = page.locator("dt", { hasText: "Processed" }).locator("xpath=following-sibling::dd[1]");
    await expect(processed).toHaveText(/^[1-9]\d*$/, { timeout: SAVE_TIMEOUT_MS });
  });

  test("publishes the saved draft as a new version", async ({ console: page, state }) => {
    await openEditor(page, state.editorMappingName);

    // Publish needs a saved draft. Earlier specs may already have stored one, so do not assume the
    // button is disabled on load: make a change that differs from the latest version and wait for
    // it to be stored.
    const publish = page.getByRole("button", { name: "Publish", exact: true });

    await page.getByLabel("Version", { exact: true }).fill("1.0.1");
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: SAVE_TIMEOUT_MS });

    await expect(publish).toBeEnabled();
    await publish.click();

    await expect(page.locator("p.banner")).toContainText(
      new RegExp(`Published ${state.editorMappingName} as version \\d+\\.`),
      { timeout: SAVE_TIMEOUT_MS },
    );
  });
});
