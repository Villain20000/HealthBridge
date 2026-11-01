#!/usr/bin/env node
/**
 * HealthBridge OS docs site generator (Phase F).
 *
 * Builds a static, offline-capable HTML site from `docs/*.md`, `README.md`
 * and `ROADMAP.md` into `docs/site/`. Dependency-free: Node.js builtins only.
 *
 * Usage:
 *   node scripts/docs-site.mjs [--out <dir>] [--root <dir>]
 *   npm run docs:site
 *
 * Guarantees:
 * - Deterministic output: fixed file sort, no timestamps, no random ids, LF
 *   newlines. Running twice produces byte-identical output.
 * - Offline-capable: one local `style.css`, no external scripts, fonts or
 *   stylesheets. Remote images/badges stay as-is (they degrade gracefully
 *   offline; nothing is fetched at build time).
 * - HTML is escaped everywhere; fenced code blocks are preserved verbatim.
 * - Navigation index (`index.html`) plus a full page nav on every page.
 * - Loud failure on broken relative links between docs pages: any
 *   `.md` link target that does not exist on disk aborts the build with a
 *   non-zero exit before anything is written, instead of emitting a dead
 *   link. Links to `.md` files that exist but are outside the site input set
 *   are left untouched (with a stderr warning) so no dead `.html` link is
 *   ever emitted.
 *
 * Exit codes: 0 success, 1 broken-link/content failure, 2 usage/IO error.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT = path.join("docs", "site");

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** True for URIs with a scheme or protocol-relative URLs (never rewritten). */
function isExternalTarget(target) {
  return /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(target);
}

/**
 * Split a markdown link destination into { path, anchor }. The anchor keeps
 * its leading `#`, query strings stay part of `path` for resolution.
 */
function splitAnchor(dest) {
  const hash = dest.indexOf("#");
  if (hash === -1) return { path: dest, anchor: "" };
  return { path: dest.slice(0, hash), anchor: dest.slice(hash) };
}

/** Collect reference definitions `[label]: destination` from raw markdown. */
export function collectReferences(lines) {
  const refs = new Map();
  const defRe = /^\s{0,3}\[([^\]]+)\]:\s*(\S+?)(?:\s+["'(][^"')]*["')])?\s*$/;
  for (const line of lines) {
    const m = defRe.exec(line);
    if (m) refs.set(m[1].toLowerCase(), m[2]);
  }
  return refs;
}

/**
 * Find every link destination in a markdown source (inline, reference and
 * image forms). Returns { raw, line } entries for validation.
 */
export function collectLinkTargets(source) {
  const lines = source.split("\n");
  const refs = collectReferences(lines);
  const targets = [];
  // Strip fenced code blocks: links inside code are literal text, not links.
  const stripped = stripFencedCode(source);
  const push = (raw, line) => {
    if (raw) targets.push({ raw, line });
  };
  const inlineRe = /!?\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let m;
  const lineOf = (index) => stripped.slice(0, index).split("\n").length;
  while ((m = inlineRe.exec(stripped)) !== null) push(m[2], lineOf(m.index));
  const refRe = /!?\[([^\]]*)\]\[([^\]]*)\]/g;
  while ((m = refRe.exec(stripped)) !== null) {
    const label = (m[2] || m[1]).toLowerCase();
    if (refs.has(label)) push(refs.get(label), lineOf(m.index));
  }
  return targets;
}

/** Replace fenced code block contents with blanks (keeps line numbers). */
function stripFencedCode(source) {
  const lines = source.split("\n");
  let inFence = null;
  return lines
    .map((line) => {
      const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (inFence === null) inFence = fence[1][0];
        else if (line.includes(inFence.repeat(3))) inFence = null;
        return "";
      }
      return inFence === null ? line : "";
    })
    .join("\n");
}

/**
 * Validate relative `.md` links for every input page.
 * Returns { pages, broken, warnings } where `broken` lists
 * "file:line: target" strings. `pages` maps absolute source paths to
 * { rel, outName, title } for existing, in-site targets.
 */
export function validateLinks(root, inputFiles) {
  const inSite = new Set(inputFiles.map((f) => path.resolve(root, f)));
  const pages = new Map();
  for (const rel of inputFiles) {
    const abs = path.resolve(root, rel);
    const base = path.basename(rel, ".md").toLowerCase();
    const outName = `${base === "readme" || base === "roadmap" ? base : base}.html`;
    pages.set(abs, { rel, outName });
  }
  const broken = [];
  const warnings = [];
  const sorted = [...inSite].sort();
  for (const abs of sorted) {
    const rel = path.relative(root, abs);
    const source = fs.readFileSync(abs, "utf8");
    for (const { raw, line } of collectLinkTargets(source)) {
      const { path: destPath } = splitAnchor(raw.trim());
      if (!destPath || destPath.startsWith("#") || isExternalTarget(destPath)) continue;
      const clean = destPath.split("?")[0];
      if (!/\.md$/i.test(clean)) continue;
      const target = destPath.startsWith("/")
        ? path.join(root, destPath)
        : path.resolve(path.dirname(abs), clean);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        broken.push(`${rel}:${line}: ${raw} (resolves to ${path.relative(root, target)})`);
      } else if (!inSite.has(target)) {
        warnings.push(`${rel}:${line}: ${raw} points outside the site input set; left as-is`);
      }
    }
  }
  return { pages, broken, warnings };
}

/** Deterministic heading id: lowercase slug with per-page dedupe suffixes. */
function slugify(text, seen) {
  let slug =
    text
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "section";
  if (seen.has(slug)) {
    let n = 2;
    while (seen.has(`${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }
  seen.add(slug);
  return slug;
}

/** Plain-text rendering of inline markdown (used for titles and slugs). */
function plainText(source, refs) {
  return source
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]*)\]\[([^\]]*)\]/g, (m, t) => t)
    .replaceAll(/`([^`]*)`/g, "$1")
    .replaceAll(/(\*\*|__)(.*?)\1/g, "$2")
    .replaceAll(/(\*|_)(.*?)\1/g, "$2")
    .replaceAll(/~~(.*?)~~/g, "$1");
}

/**
 * Render inline markdown to HTML. `rewrite` maps an in-site absolute `.md`
 * path to its output `.html` name; out-of-site and external targets pass
 * through unchanged (validation already rejected dead targets).
 */
export function renderInline(source, refs, rewrite, sourceDir, root) {
  let out = "";
  let i = 0;
  const linkUrl = (dest) => {
    const { path: destPath, anchor } = splitAnchor(dest.trim());
    if (!destPath || destPath.startsWith("#") || isExternalTarget(destPath)) {
      return escapeHtml(dest) + "";
    }
    const clean = destPath.split("?")[0];
    if (!/\.md$/i.test(clean)) return escapeHtml(dest);
    const target = destPath.startsWith("/")
      ? path.join(root, destPath)
      : path.resolve(sourceDir, clean);
    const mapped = rewrite.get(target);
    if (!mapped) return escapeHtml(dest);
    return escapeHtml(mapped + destPath.slice(clean.length) + anchor);
  };
  while (i < source.length) {
    const rest = source.slice(i);
    if (rest.startsWith("![")) {
      const img = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (img) {
        out += `<img src="${escapeHtml(img[2])}" alt="${escapeHtml(img[1])}">`;
        i += img[0].length;
        continue;
      }
    }
    if (rest.startsWith("[")) {
      const inline = /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (inline) {
        out += `<a href="${linkUrl(inline[2])}">${renderInline(inline[1], refs, rewrite, sourceDir, root)}</a>`;
        i += inline[0].length;
        continue;
      }
      const ref = /^\[([^\]]*)\]\[([^\]]*)\]/.exec(rest);
      if (ref) {
        const dest = refs.get((ref[2] || ref[1]).toLowerCase());
        if (dest !== undefined) {
          out += `<a href="${linkUrl(dest)}">${renderInline(ref[1], refs, rewrite, sourceDir, root)}</a>`;
        } else {
          out += escapeHtml(ref[0]);
        }
        i += ref[0].length;
        continue;
      }
    }
    if (rest.startsWith("<")) {
      const auto = /^<(https?:[^<>\s]+|mailto:[^<>\s]+)>/.exec(rest);
      if (auto) {
        out += `<a href="${escapeHtml(auto[1])}">${escapeHtml(auto[1])}</a>`;
        i += auto[0].length;
        continue;
      }
    }
    const codeOpen = /^(`+)/.exec(rest);
    if (codeOpen) {
      const run = codeOpen[1];
      const close = rest.indexOf(run, run.length);
      if (close !== -1) {
        out += `<code>${escapeHtml(rest.slice(run.length, close))}</code>`;
        i += close + run.length;
        continue;
      }
      out += escapeHtml(rest[0]);
      i += 1;
      continue;
    }
    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong) {
      out += `<strong>${renderInline(strong[2], refs, rewrite, sourceDir, root)}</strong>`;
      i += strong[0].length;
      continue;
    }
    const em = /^(\*|_)(.+?)\1/.exec(rest);
    if (em && !/^\*\*|^__/.test(rest)) {
      out += `<em>${renderInline(em[2], refs, rewrite, sourceDir, root)}</em>`;
      i += em[0].length;
      continue;
    }
    const del = /^~~(.+?)~~/.exec(rest);
    if (del) {
      out += `<del>${renderInline(del[1], refs, rewrite, sourceDir, root)}</del>`;
      i += del[0].length;
      continue;
    }
    out += escapeHtml(rest[0]);
    i += 1;
  }
  return out.replaceAll(/  \n/g, "<br>\n");
}

/** True when a line is a GFM table separator (`| --- | :-: |`). */
function isTableSeparator(line) {
  const cells = line.trim().replaceAll(/^\||\|$/g, "").split("|");
  return (
    cells.length > 0 &&
    cells.every((cell) => /^\s*:?-{1,}:?\s*$/.test(cell))
  );
}

/** Split a GFM table row into cells (trims outer pipes, unescapes `\|`). */
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.replaceAll("\\|", "|").trim());
}

/**
 * Render a markdown document body to HTML. `ctx` carries refs, rewrite map,
 * sourceDir, root and the per-page slug registry.
 */
export function renderBody(source, ctx) {
  const lines = source.split("\n");
  const refs = collectReferences(lines);
  // Drop reference-definition lines: they are metadata, not content.
  const defRe = /^\s{0,3}\[[^\]]+\]:\s*\S+?(?:\s+["'(][^"')]*["')])?\s*$/;
  const body = lines.filter((line) => !defRe.test(line));
  const html = [];
  const slugSeen = new Set();
  let i = 0;

  const renderPara = (text) =>
    `<p>${renderInline(text.trim(), refs, ctx.rewrite, ctx.sourceDir, ctx.root)}</p>`;

  while (i < body.length) {
    const line = body[i];
    // Fenced code block: preserved verbatim, HTML-escaped.
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2];
      const code = [];
      i++;
      while (i < body.length && !new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(body[i])) {
        code.push(body[i]);
        i++;
      }
      i++; // consume closing fence (or run off the end)
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      html.push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    // ATX heading.
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      const level = atx[1].length;
      const id = slugify(plainText(atx[2], refs), slugSeen);
      html.push(
        `<h${level} id="${id}">${renderInline(atx[2], refs, ctx.rewrite, ctx.sourceDir, ctx.root)}</h${level}>`,
      );
      i++;
      continue;
    }
    // Setext heading.
    if (i + 1 < body.length && line.trim() !== "" && /^\s{0,3}(=+|-+)\s*$/.test(body[i + 1])) {
      const level = body[i + 1].trim().startsWith("=") ? 1 : 2;
      const id = slugify(plainText(line, refs), slugSeen);
      html.push(
        `<h${level} id="${id}">${renderInline(line.trim(), refs, ctx.rewrite, ctx.sourceDir, ctx.root)}</h${level}>`,
      );
      i += 2;
      continue;
    }
    // Horizontal rule.
    if (/^\s{0,3}(?:\*[ \t]*){3,}$|^\s{0,3}(?:-[ \t]*){3,}$|^\s{0,3}(?:_[ \t]*){3,}$/.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }
    // Blockquote (recursively rendered).
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < body.length && /^\s{0,3}>/.test(body[i])) {
        quoted.push(body[i].replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      html.push(
        `<blockquote>\n${renderBody(quoted.join("\n"), { ...ctx, nested: true })}\n</blockquote>`,
      );
      continue;
    }
    // GFM table.
    if (
      line.includes("|") &&
      i + 1 < body.length &&
      isTableSeparator(body[i + 1])
    ) {
      const header = splitRow(line);
      const aligns = body[i + 1]
        .trim()
        .replaceAll(/^\||\|$/g, "")
        .split("|")
        .map((cell) => {
          const c = cell.trim();
          if (c.startsWith(":") && c.endsWith(":")) return ' align="center"';
          if (c.endsWith(":")) return ' align="right"';
          if (c.startsWith(":")) return ' align="left"';
          return "";
        });
      const rows = [];
      i += 2;
      while (i < body.length && body[i].trim() !== "" && body[i].includes("|")) {
        rows.push(splitRow(body[i]));
        i++;
      }
      const th = header
        .map(
          (cell, n) =>
            `<th${aligns[n] ?? ""}>${renderInline(cell, refs, ctx.rewrite, ctx.sourceDir, ctx.root)}</th>`,
        )
        .join("");
      const tb = rows
        .map(
          (row) =>
            `<tr>${row.map((cell, n) => `<td${aligns[n] ?? ""}>${renderInline(cell, refs, ctx.rewrite, ctx.sourceDir, ctx.root)}</td>`).join("")}</tr>`,
        )
        .join("");
      html.push(`<table>\n<thead>\n<tr>${th}</tr>\n</thead>\n<tbody>\n${tb}\n</tbody>\n</table>`);
      continue;
    }
    // Lists (ordered, unordered, nested by indent).
    const listMatch = /^\s{0,3}(?:([-*+])|(\d+)[.)])\s+/.exec(line);
    if (listMatch) {
      const list = renderList(body, i, refs, ctx);
      html.push(list.html);
      i = list.next;
      continue;
    }
    // Indented code block (4 spaces, after a blank line).
    if (/^(?:    |\t)/.test(line) && (i === 0 || body[i - 1].trim() === "")) {
      const code = [];
      while (i < body.length && (/^(?:    |\t)/.test(body[i]) || body[i].trim() === "")) {
        if (body[i].trim() === "") {
          if (i + 1 < body.length && /^(?:    |\t)/.test(body[i + 1])) code.push("");
          i++;
          continue;
        }
        code.push(body[i].replace(/^(?:    |\t)/, ""));
        i++;
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    // Blank line: paragraph separator.
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph (lazy continuation lines).
    const para = [line];
    i++;
    while (
      i < body.length &&
      body[i].trim() !== "" &&
      !/^\s{0,3}(#{1,6}\s|`{3,}|~{3,}|>|(\*|-|_)( \*| -| _)*\s*$)/.test(body[i]) &&
      !/^\s{0,3}(?:([-*+])|(\d+)[.)])\s+/.test(body[i]) &&
      !(body[i].includes("|") && i + 1 < body.length && isTableSeparator(body[i + 1]))
    ) {
      para.push(body[i]);
      i++;
    }
    html.push(renderPara(para.join("\n")));
  }
  return html.join("\n");
}

/** Match a list marker; returns { ordered, text } or null. */
function listMarker(line) {
  const m = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  return { ordered: m[3] !== undefined, text: m[4] };
}

/** Render a (possibly nested) list starting at `start`; returns { html, next }. */
function renderList(lines, start, refs, ctx) {
  const first = listMarker(lines[start]);
  const ordered = first.ordered;
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let i = start;
  const baseIndent = indentOf(lines[start]);
  const dedent = new RegExp(`^ {0,${baseIndent + 1}}`);
  let current = null;
  const flush = () => {
    if (!current) return;
    let itemHtml = renderInline(current.text, refs, ctx.rewrite, ctx.sourceDir, ctx.root);
    if (current.nested.length > 0) {
      // Nested content keeps its relative structure; render as blocks so
      // continuation paragraphs and sublists both work.
      itemHtml += `\n${renderBody(current.nested.join("\n"), ctx)}`;
    }
    items.push(`<li>${itemHtml}</li>`);
    current = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") break;
    const lm = listMarker(line);
    if (lm && indentOf(line) === baseIndent && lm.ordered === ordered) {
      flush();
      current = { text: lm.text, nested: [] };
      i++;
      continue;
    }
    if (current && indentOf(line) > baseIndent) {
      current.nested.push(line.replace(dedent, ""));
      i++;
      continue;
    }
    break;
  }
  flush();
  return { html: `<${tag}>\n${items.join("\n")}\n</${tag}>`, next: i };
}

function indentOf(line) {
  const m = /^\s*/.exec(line);
  return (m[0].replaceAll("\t", "    ")).length;
}

const STYLE_CSS = `/* HealthBridge OS docs site. Local only: no external fetches. */
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #5b5b5b;
  --accent: #0b5cad;
  --border: #d8d8d8;
  --code-bg: #f4f4f4;
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 72rem;
  padding: 1.5rem;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg);
}
header nav ul {
  list-style: none;
  margin: 0 0 1.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  columns: 3;
}
header nav li { break-inside: avoid; }
header nav a { color: var(--accent); }
header nav [aria-current="page"] { font-weight: bold; color: var(--fg); }
a { color: var(--accent); }
pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1rem;
  overflow-x: auto;
}
code { font-family: ui-monospace, Consolas, monospace; }
p code, li code, td code, th code {
  background: var(--code-bg);
  padding: 0.1em 0.3em;
  border-radius: 0.25em;
}
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid var(--border); padding: 0.5rem 0.75rem; text-align: left; }
thead th { background: var(--code-bg); }
blockquote {
  margin: 1rem 0;
  padding: 0.25rem 1rem;
  border-left: 0.25rem solid var(--border);
  color: var(--muted);
}
footer { margin-top: 3rem; color: var(--muted); font-size: 0.875rem; }
`;

/** Full HTML shell for one page. */
export function renderPage({ title, body, nav, current }) {
  const items = nav
    .map(
      ({ outName, title: label }) =>
        `      <li${outName === current ? ' aria-current="page"' : ""}>` +
        (outName === current
          ? `<span>${escapeHtml(label)}</span>`
          : `<a href="${escapeHtml(outName)}">${escapeHtml(label)}</a>`) +
        `</li>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="style.css">
<title>${escapeHtml(title)}</title>
</head>
<body>
<header>
<nav aria-label="Documentation pages">
<ul>
${items}
</ul>
</nav>
</header>
<main>
${body}
</main>
<footer>
<p>HealthBridge OS documentation. Generated offline from the repository markdown sources.</p>
</footer>
</body>
</html>
`;
}

/** Navigation index page body: sorted list of every page. */
export function renderIndex(nav) {
  const items = nav
    .map(({ outName, title, source }) => `  <li><a href="${escapeHtml(outName)}">${escapeHtml(title)}</a> — <code>${escapeHtml(source)}</code></li>`)
    .join("\n");
  return `<h1 id="documentation">Documentation</h1>\n<p>${nav.length} pages generated from the repository markdown sources.</p>\n<ul>\n${items}\n</ul>`;
}

/** First `# ` heading of a document, else the file stem. */
export function pageTitle(source, fallback) {
  for (const line of source.split("\n")) {
    const m = /^\s{0,3}#\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) return plainText(m[1], new Map()).trim() || fallback;
  }
  return fallback;
}

/** Discover site inputs: README.md + ROADMAP.md + docs/*.md, sorted. */
export function discoverInputs(root) {
  const found = ["README.md", "ROADMAP.md"];
  const docsDir = path.join(root, "docs");
  if (fs.existsSync(docsDir)) {
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        found.push(path.join("docs", entry.name));
      }
    }
  }
  return found.filter((rel) => {
    const abs = path.resolve(root, rel);
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  });
}

/**
 * Build the site. Throws an Error listing every broken link (nothing is
 * written in that case). Returns { pages, outDir }.
 */
export function buildSite({ root = DEFAULT_ROOT, outDir = path.join(DEFAULT_ROOT, DEFAULT_OUT) } = {}) {
  const inputFiles = discoverInputs(root);
  if (inputFiles.length === 0) throw new Error("docs-site: no input markdown files found");
  const { pages, broken, warnings } = validateLinks(root, inputFiles);
  for (const w of warnings) console.warn(`docs-site warning: ${w}`);
  if (broken.length > 0) {
    throw new Error(
      `docs-site: ${broken.length} broken relative link(s); site not written:\n` +
        broken.map((b) => `  - ${b}`).join("\n"),
    );
  }
  const rewrite = new Map();
  for (const [abs, info] of pages) rewrite.set(abs, info.outName);

  const nav = [];
  const rendered = [];
  const sortedAbs = [...pages.keys()].sort((a, b) =>
    pages.get(a).outName.localeCompare(pages.get(b).outName),
  );
  for (const abs of sortedAbs) {
    const rel = path.relative(root, abs);
    const source = fs.readFileSync(abs, "utf8").replaceAll("\r\n", "\n");
    const title = pageTitle(source, path.basename(rel, ".md"));
    nav.push({ outName: pages.get(abs).outName, title, source: rel });
    rendered.push({
      abs,
      outName: pages.get(abs).outName,
      title,
      body: renderBody(source, {
        rewrite,
        sourceDir: path.dirname(abs),
        root,
      }),
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "style.css"), STYLE_CSS + "\n");
  for (const page of rendered) {
    fs.writeFileSync(
      path.join(outDir, page.outName),
      renderPage({ title: page.title, body: page.body, nav, current: page.outName }) + "\n",
    );
  }
  const indexNav = [...nav, { outName: "index.html", title: "Documentation", source: "(index)" }].sort(
    (a, b) => a.outName.localeCompare(b.outName),
  );
  fs.writeFileSync(
    path.join(outDir, "index.html"),
    renderPage({ title: "Documentation", body: renderIndex(nav), nav: indexNav, current: "index.html" }) + "\n",
  );
  return { pages: rendered.length, outDir };
}

function parseArgs(argv) {
  const args = { out: undefined, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--out") args.out = argv[++i];
    else if (flag === "--root") args.root = path.resolve(argv[++i]);
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`docs-site: unknown argument: ${flag}`);
  }
  if (args.out === undefined) args.out = path.join(args.root, DEFAULT_OUT);
  return args;
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error("Usage: node scripts/docs-site.mjs [--out <dir>] [--root <dir>]");
    process.exit(2);
  }
  if (args.help) {
    console.log("Usage: node scripts/docs-site.mjs [--out <dir>] [--root <dir>]");
    console.log("Builds a static offline HTML site from docs/*.md + README.md + ROADMAP.md.");
    process.exit(0);
  }
  try {
    const result = buildSite({ root: args.root, outDir: args.out });
    console.log(`docs-site: ${result.pages} pages -> ${path.relative(process.cwd(), result.outDir) || "."}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
