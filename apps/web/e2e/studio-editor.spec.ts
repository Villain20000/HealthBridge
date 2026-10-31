import { readFileSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { clientNavigate, expect, signIn, test } from "./support/fixtures";

/**
 * Mapping editor end-to-end coverage (`/studio/mappings/:name`).
 *
 * These specs use the mapping the seed reserves for the editor (`state.editorMappingName`), so the
 * drafts they save and the versions they publish never change the mapping the run and debugger
 * specs read. The version-diff spec reads the run mapping, whose seed publishes a real v1 and v2
 * (one extra rule). The suite runs serially with a single worker (see playwright.config.ts), so
 * editing one shared mapping across specs is safe; specs that change a seeded value restore it and
 * later specs do not depend on an earlier spec's draft.
 *
 * The save indicator is `p.save-status` and exposes its state in `data-state`
 * (idle | dirty | saving | saved | conflict | error). The specs wait on that state instead of a
 * fixed delay, so they stay correct if the 800 ms autosave debounce changes. The page also renders
 * screen-reader announcers and the publish banner as `role="status"`, which is why the indicator is
 * selected by its class.
 *
 * The page's document keydown handler intentionally ignores keys pressed inside text fields
 * (native undo must keep working), so the shortcut specs first focus a non-input control.
 */

const SAVE_TIMEOUT_MS = 10_000;

interface DraftRule {
  id: string;
  sourcePath: string;
  targetPath: string;
}

interface DraftSpec {
  version?: string;
  sourceFormat?: string;
  rules: DraftRule[];
}

interface DraftView {
  draft: { revision: number; baseVersion?: number; spec: DraftSpec } | null;
}

function saveStatus(page: Page) {
  return page.locator("p.save-status");
}

async function openEditor(page: Page, name: string): Promise<void> {
  await clientNavigate(page, `/studio/mappings/${name}`);
  await expect(page.getByRole("heading", { level: 1, name: "Mapping editor" })).toBeVisible();
  // The first seeded rule is selected once the draft has loaded.
  await expect(page.getByRole("form", { name: "Rule r1", exact: true })).toBeVisible();
}

async function getDraft(page: Page, state: { baseUrl: string; key: string }, name: string): Promise<DraftView> {
  const response = await page.request.get(`${state.baseUrl}/api/v1/mappings/${name}/draft`, {
    headers: { "x-api-key": state.key },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as DraftView;
}

async function listRunIds(page: Page, state: { baseUrl: string; key: string }): Promise<string[]> {
  const response = await page.request.get(`${state.baseUrl}/api/v1/runs?limit=100`, {
    headers: { "x-api-key": state.key },
  });
  expect(response.ok()).toBe(true);
  const { runs } = (await response.json()) as { runs: { id: string }[] };
  return runs.map((run) => run.id);
}

test.describe("mapping editor", () => {
  test("opens from the mappings list and loads the seeded rules", async ({ console: page, state }) => {
    await page.getByRole("link", { name: "Mappings", exact: true }).click();
    await expect(page).toHaveURL(/\/mappings$/);

    const row = page.getByRole("row").filter({ hasText: state.editorMappingName });
    await row.getByRole("link", { name: "Open in Studio", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/studio/mappings/${state.editorMappingName}$`));
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

  test("creates, previews and publishes a mapping entirely from the keyboard", async ({
    console: page,
    state,
  }, testInfo) => {
    // A retry must not inherit the first attempt's draft or published version. The first attempt
    // keeps the brief's exact name; retries append the retry index.
    const name = testInfo.retry === 0 ? `e2e-keyboard-${state.slug}` : `e2e-keyboard-${state.slug}-r${testInfo.retry}`;
    await clientNavigate(page, `/studio/mappings/${name}`);
    await expect(page.getByRole("heading", { level: 1, name: "Mapping editor" })).toBeVisible();
    await expect(page.getByText("New mapping — not published.", { exact: true })).toBeVisible();
    await expect(page.locator("form.rule-form")).toHaveCount(0);

    const addRule = page.getByRole("button", { name: "Add rule", exact: true });
    await addRule.focus();
    await page.keyboard.press("Enter");

    const ruleSelects = page.locator("button.rule-select");
    await expect(ruleSelects).toHaveCount(1);
    await expect(page.locator("form.rule-form")).toBeVisible();
    await expect(ruleSelects.first()).toBeFocused();

    // Keyboard entry only: no fill() for the fields that prove typing works.
    await page.getByLabel("Source path", { exact: true }).focus();
    await page.keyboard.type("given_name");
    await page.getByLabel("Target path", { exact: true }).focus();
    await page.keyboard.type("name.0.given.0");

    const sourceFormat = page.getByLabel("Source format", { exact: true });
    await sourceFormat.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("csv");

    // Second rule, also added and filled from the keyboard.
    await addRule.focus();
    await page.keyboard.press("Enter");
    await expect(ruleSelects).toHaveCount(2);
    await expect(ruleSelects.last()).toBeFocused();
    await page.getByLabel("Source path", { exact: true }).focus();
    await page.keyboard.type("family_name");
    await page.getByLabel("Target path", { exact: true }).focus();
    await page.keyboard.type("name.0.family");

    // Move rule 2 up, then undo and redo with the page shortcuts.
    const moveUp = page.getByRole("button", { name: "Move rule 2 up", exact: true });
    await moveUp.focus();
    await page.keyboard.press("Enter");
    await expect(ruleSelects.first()).toContainText("family_name");

    await ruleSelects.first().focus();
    await page.keyboard.press("Control+z");
    await expect(ruleSelects.first()).toContainText("given_name");

    await page.keyboard.press("Control+y");
    await expect(ruleSelects.first()).toContainText("family_name");

    // Move the first rule down again; the order returns to given_name, family_name.
    const moveDown = page.getByRole("button", { name: "Move rule 1 down", exact: true });
    await moveDown.focus();
    await page.keyboard.press("Enter");
    await expect(ruleSelects.first()).toContainText("given_name");
    await expect(ruleSelects.last()).toContainText("family_name");

    // Prove that Ctrl+S flushes: type the version, then press the shortcut while the draft is
    // dirty. A registered shortcut issues the draft PUT immediately; without it the pending edit
    // would only be written by the 800 ms autosave debounce.
    const version = page.getByLabel("Version", { exact: true });
    await version.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("1.0.1");
    const typedAt = Date.now();

    // The waiter timeout is deliberately longer than the debounce so it captures either an
    // immediate flush or a debounce save; the elapsed bound below is the discriminator.
    const draftPut = page.waitForRequest(
      (request) => request.method() === "PUT" && new URL(request.url()).pathname === `/api/v1/mappings/${name}/draft`,
      { timeout: 2_000 },
    );

    await expect(saveStatus(page)).toHaveAttribute("data-state", "dirty");
    await ruleSelects.first().focus();
    await page.keyboard.press("Control+s");

    await draftPut;
    // A debounce-triggered PUT cannot start before 800 ms after the last keystroke, so this fails
    // if the keyboard handler is unregistered and only autosave saves the draft.
    expect(Date.now() - typedAt).toBeLessThan(800);
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: SAVE_TIMEOUT_MS });

    // The keyboard-entered draft really reached the server.
    const draft = await getDraft(page, state, name);
    expect(draft.draft).not.toBeNull();
    expect(draft.draft?.revision).toBeGreaterThanOrEqual(1);
    const storedRules = draft.draft?.spec.rules ?? [];
    expect(storedRules.map((rule) => rule.sourcePath)).toEqual(expect.arrayContaining(["given_name", "family_name"]));
    expect(storedRules.map((rule) => rule.targetPath)).toEqual(
      expect.arrayContaining(["name.0.given.0", "name.0.family"]),
    );
    expect(draft.draft?.spec.version).toBe("1.0.1");
    expect(draft.draft?.spec.sourceFormat).toBe("csv");

    // Preview the draft; it must not create a run.
    const runsBefore = await listRunIds(page, state);
    await page.getByLabel("Asset", { exact: true }).selectOption(state.assetId);
    await page.getByLabel("Record limit", { exact: true }).fill("10");
    const runPreview = page.getByRole("button", { name: "Run preview", exact: true });
    await expect(runPreview).toBeEnabled();
    await runPreview.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByText("Preview only — no run was created.", { exact: true })).toBeVisible({
      timeout: SAVE_TIMEOUT_MS,
    });
    const processed = page.locator("dt", { hasText: "Processed" }).locator("xpath=following-sibling::dd[1]");
    await expect(processed).toHaveText(/^[1-9]\d*$/, { timeout: SAVE_TIMEOUT_MS });
    expect(await listRunIds(page, state)).toEqual(runsBefore);

    // Publish from the keyboard and verify the version through the API.
    const publish = page.getByRole("button", { name: "Publish", exact: true });
    await expect(publish).toBeEnabled({ timeout: SAVE_TIMEOUT_MS });
    await publish.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("p.banner").filter({ hasText: `Published ${name} as version 1.` })).toBeVisible({
      timeout: SAVE_TIMEOUT_MS,
    });

    const versionsResponse = await page.request.get(`${state.baseUrl}/api/v1/mappings/${name}/versions`, {
      headers: { "x-api-key": state.key },
    });
    expect(versionsResponse.ok()).toBe(true);
    const { versions } = (await versionsResponse.json()) as { versions: { version: number }[] };
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
  });

  test("diffs the seeded v1 and v2 of the run mapping", async ({ console: page, state }) => {
    await openEditor(page, state.mappingName);

    await page.getByLabel("From", { exact: true }).selectOption("1");
    await page.getByLabel("To", { exact: true }).selectOption(String(state.mappingVersion2Version));
    await page.getByRole("button", { name: "Compare versions", exact: true }).click();

    const diff = page.getByRole("region", { name: "Version diff result" });
    await expect(diff.getByRole("heading", { name: "Added rules (1)", exact: true })).toBeVisible({
      timeout: SAVE_TIMEOUT_MS,
    });
    await expect(diff.getByText("r7", { exact: true })).toBeVisible();
    await expect(diff.getByText("name.0.given.1", { exact: true })).toBeVisible();
    const added = diff.locator("dt", { hasText: "Added" }).locator("xpath=following-sibling::dd[1]");
    await expect(added).toHaveText(/^[1-9]\d*$/);
  });

  test("resolves a draft conflict by reloading the server draft", async ({ console: page, state }) => {
    await openEditor(page, state.editorMappingName);

    const target = page.getByRole("form", { name: "Rule r1", exact: true }).getByLabel("Target path", { exact: true });
    await target.fill("id_edited");
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: SAVE_TIMEOUT_MS });

    // Bump the draft behind the editor's back, the way a second tab would.
    const before = await getDraft(page, state, state.editorMappingName);
    if (before.draft === null) throw new Error("expected the editor mapping to have a stored draft");
    const bumped = structuredClone(before.draft.spec);
    const rule = bumped.rules.find((item) => item.id === "r1");
    if (rule === undefined) throw new Error("expected rule r1 in the draft");
    rule.targetPath = "id_server";
    const put = await page.request.put(`${state.baseUrl}/api/v1/mappings/${state.editorMappingName}/draft`, {
      headers: { "x-api-key": state.key },
      data: { spec: bumped, revision: before.draft.revision },
    });
    expect(put.ok()).toBe(true);

    await target.fill("id_local");
    await expect(saveStatus(page)).toHaveAttribute("data-state", "conflict", { timeout: SAVE_TIMEOUT_MS });
    await expect(page.getByText("This draft was changed somewhere else.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload server draft", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Overwrite server draft", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Reload server draft", exact: true }).click();
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: SAVE_TIMEOUT_MS });
    await expect(page.getByText("This draft was changed somewhere else.", { exact: true })).toHaveCount(0);
    await expect(target).toHaveValue("id_server");

    // Restore the seeded value so later specs see the seeded rule.
    await target.fill("id");
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: SAVE_TIMEOUT_MS });
  });

  test("blocks navigation when the draft cannot be saved and retries", async ({ console: page, state }) => {
    await openEditor(page, state.editorMappingName);

    await page.route("**/api/v1/mappings/*/draft", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "QUEUE_UNAVAILABLE",
            message: "The draft could not be saved.",
            requestId: "req_e2e_forced_503",
          },
          statusCode: 503,
        }),
      });
    });

    const target = page.getByRole("form", { name: "Rule r1", exact: true }).getByLabel("Target path", { exact: true });
    await target.fill("id_blocked");
    await page.getByRole("link", { name: "Back to Studio", exact: true }).click();

    // The guard keeps the operator on the editor and offers an inline choice.
    await expect(page).toHaveURL(new RegExp(`/studio/mappings/${state.editorMappingName}$`));
    await expect(page.getByText("Your latest changes could not be saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard and leave", exact: true })).toBeVisible();

    await page.unroute("**/api/v1/mappings/*/draft");
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(page).toHaveURL(/\/studio$/);

    // The retry persisted the forced target. Reopen the editor and restore the seeded r1 value so
    // later specs and future runs see the same draft the seed created.
    await openEditor(page, state.editorMappingName);
    const restored = page
      .getByRole("form", { name: "Rule r1", exact: true })
      .getByLabel("Target path", { exact: true });
    await restored.fill("id");
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: SAVE_TIMEOUT_MS });

    const draft = await getDraft(page, state, state.editorMappingName);
    expect(draft.draft?.spec.rules.find((rule) => rule.id === "r1")?.targetPath).toBe("id");
  });

  test("a viewer key cannot save the draft and sees the 403 with code and request id", async ({
    page,
    request,
    state,
  }) => {
    // connect.spec.ts revokes the seeded viewer key on purpose, so this spec creates its own.
    const created = await request.post("/api/v1/keys", {
      headers: { "x-api-key": state.key, "idempotency-key": `editor-viewer-${Date.now()}` },
      data: { name: `e2e-editor-viewer-${Date.now()}`, role: "viewer" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const viewer = (await created.json()) as { key: string };

    await signIn(page, viewer.key);
    await clientNavigate(page, `/studio/mappings/${state.editorMappingName}`);
    await expect(page.getByRole("form", { name: "Rule r1", exact: true })).toBeVisible();

    await page.getByLabel("Target path", { exact: true }).fill("id_viewer");

    const error = page.locator("hb-error").first();
    await expect(error).toBeVisible({ timeout: SAVE_TIMEOUT_MS });
    await expect(error).toContainText("HTTP 403");
    await expect(error.locator("span.code")).toHaveText(/\S+/);
    await expect(error.locator(".meta code")).toHaveText(/\S+/);
  });

  test("shows a published version read-only with an Edit latest link", async ({ console: page, state }) => {
    await clientNavigate(page, `/studio/mappings/${state.editorMappingName}?version=1`);
    await expect(page.getByText("Read-only published version 1 — not editable.", { exact: true })).toBeVisible();

    await expect(page.getByRole("button", { name: "Add rule", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Import JSON", exact: true })).toHaveCount(0);

    const published = page.locator("section.card").filter({ hasText: "Published mapping" });
    await expect(published.locator("ul > li")).toHaveCount(6);

    await page.getByRole("link", { name: "Edit latest", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/studio/mappings/${state.editorMappingName}$`));
    await expect(page.getByRole("form", { name: "Rule r1", exact: true })).toBeVisible();
  });

  test("exports the draft JSON and rejects an invalid import without changing it", async ({
    console: page,
    state,
  }, testInfo) => {
    await openEditor(page, state.editorMappingName);

    const before = await getDraft(page, state, state.editorMappingName);
    const ruleCount = await page.locator("button.rule-select").count();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSON", exact: true }).click();
    const download = await downloadPromise;
    const jsonPath = await download.path();
    expect(jsonPath).not.toBeNull();
    const exported = JSON.parse(readFileSync(jsonPath as string, "utf8")) as { rules: unknown[] };
    expect(exported.rules.length).toBeGreaterThan(0);
    expect(exported.rules).toHaveLength(ruleCount);

    const invalidPath = testInfo.outputPath("bad.json");
    writeFileSync(invalidPath, '{ "bad": true }\n', "utf8");
    await page.locator('input[type="file"]').setInputFiles(invalidPath);
    await expect(page.getByText("The file is not a valid mapping definition.", { exact: true })).toBeVisible();

    // An invalid import is rejected before it touches the draft.
    expect(await getDraft(page, state, state.editorMappingName)).toEqual(before);
  });
});
