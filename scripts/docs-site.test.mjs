/**
 * Tests for scripts/docs-site.mjs.
 *
 * Run:  node --test scripts/docs-site.test.mjs
 *       node scripts/run-tests.mjs "scripts/docs-site.test.mjs"
 *
 * Dependency-free: node:test + node:fs/os/path only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSite,
  collectLinkTargets,
  escapeHtml,
  pageTitle,
  renderBody,
  renderInline,
  validateLinks,
} from "./docs-site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-site-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function listTree(dir) {
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
}

describe("docs-site generator", () => {
  it("escapes raw HTML instead of emitting it", () => {
    const html = renderBody('<script>alert("x")</script>\n', {
      rewrite: new Map(),
      sourceDir: REPO_ROOT,
      root: REPO_ROOT,
    });
    assert.ok(!html.includes("<script>"), "raw tag must not survive");
    assert.ok(html.includes("&lt;script&gt;"), "tag must be escaped");
  });

  it("preserves fenced code blocks verbatim (no markdown interpretation)", () => {
    const html = renderBody("```js\n# not a heading [x](y.md) <b>\n```\n", {
      rewrite: new Map(),
      sourceDir: REPO_ROOT,
      root: REPO_ROOT,
    });
    assert.ok(html.includes("<pre><code"), "code block wrapper missing");
    assert.ok(html.includes("# not a heading [x](y.md) &lt;b&gt;"), "code content altered");
    assert.ok(!html.includes("<h1"), "heading must not render inside code");
  });

  it("renders tables, inline code and strong text", () => {
    const html = renderBody("| a | b |\n| --- | :-: |\n| `x` | **y** |\n", {
      rewrite: new Map(),
      sourceDir: REPO_ROOT,
      root: REPO_ROOT,
    });
    assert.ok(html.includes("<table>"), "table missing");
    assert.ok(html.includes("<code>x</code>"), "inline code missing");
    assert.ok(html.includes("<strong>y</strong>"), "strong missing");
  });

  it("rewrites in-site .md links to .html and keeps anchors", () => {
    const rewrite = new Map([[path.join(REPO_ROOT, "docs", "cli.md"), "cli.html"]]);
    const html = renderInline("see [cli](cli.md#flags) and [ext](https://example.com/a.md)", new Map(), rewrite, path.join(REPO_ROOT, "docs"), REPO_ROOT);
    assert.ok(html.includes('href="cli.html#flags"'), `md link not rewritten: ${html}`);
    assert.ok(html.includes('href="https://example.com/a.md"'), "external link must pass through");
  });

  it("collects link targets outside fenced code blocks", () => {
    const targets = collectLinkTargets("```\n[x](ghost.md)\n```\n\n[ok](real.md)\n");
    assert.deepEqual(targets.map((t) => t.raw), ["real.md"]);
  });

  it("derives titles from the first heading", () => {
    assert.equal(pageTitle("# Hello World\n\ntext\n", "fallback"), "Hello World");
    assert.equal(pageTitle("no heading\n", "fallback"), "fallback");
  });

  it("fails loudly on broken relative links and writes nothing", () => {
    const root = makeRoot({
      "README.md": "# Root\n\n[missing](docs/nope.md)\n",
      "ROADMAP.md": "# Map\n",
      "docs/ok.md": "# Ok\n",
    });
    const outDir = path.join(root, "site-out");
    assert.throws(() => buildSite({ root, outDir }), /broken relative link/i);
    assert.ok(!fs.existsSync(outDir), "no output may be written on link failure");
  });

  it("leaves out-of-site (but existing) .md links untouched without failing", () => {
    const root = makeRoot({
      "README.md": "# Root\n\n[extra](EXTRA.md)\n",
      "ROADMAP.md": "# Map\n",
      "EXTRA.md": "# Extra\n",
    });
    const { broken } = validateLinks(root, ["README.md", "ROADMAP.md"]);
    assert.deepEqual(broken, []);
    const outDir = path.join(root, "site-out");
    buildSite({ root, outDir });
    const index = fs.readFileSync(path.join(outDir, "readme.html"), "utf8");
    assert.ok(index.includes('href="EXTRA.md"'), "out-of-site link must not be rewritten to dead .html");
  });

  it("builds the real repo site deterministically (byte-identical twice)", () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "site-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "site-b-"));
    try {
      const a = buildSite({ root: REPO_ROOT, outDir: first });
      const b = buildSite({ root: REPO_ROOT, outDir: second });
      assert.equal(a.pages, b.pages);
      assert.ok(a.pages >= 10, `expected the full docs set, got ${a.pages}`);
      const treeA = listTree(first);
      const treeB = listTree(second);
      assert.deepEqual(treeA.map((f) => f.name), treeB.map((f) => f.name));
      for (let n = 0; n < treeA.length; n++) {
        assert.ok(treeA[n].bytes.equals(treeB[n].bytes), `${treeA[n].name} differs between runs`);
      }
      const names = treeA.map((f) => f.name);
      assert.ok(names.includes("index.html"), "navigation index missing");
      assert.ok(names.includes("style.css"), "stylesheet missing");
      const sorted = [...names].sort();
      assert.deepEqual(names, sorted, "output files must follow a fixed sort");
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it("escapes titles and URLs safely", () => {
    assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});
