#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultSourcePath = path.resolve(__dirname, "../用-WARP-落地解决-Claude-app-Cloudflare-验证闪跳.md");
const sourcePath = process.argv[2] || process.env.SOURCE_MARKDOWN || defaultSourcePath;

const source = fs.readFileSync(sourcePath, "utf8");
const { frontmatter, body } = splitFrontmatter(source);
const meta = parseFrontmatter(frontmatter);
const lines = body.split(/\r?\n/);
const headings = collectHeadings(lines);
const title = headings.find((heading) => heading.level === 1)?.text || "Claude WARP 排障手册";
const intro = extractIntro(lines);

const state = {
  headings,
  headingCursor: 0,
  headingByText: new Map(headings.map((heading) => [normalizeHeading(heading.text), heading.slug])),
};

const article = renderBlocks(lines, state);
const html = renderPage({ article, headings, title, intro, meta });

fs.writeFileSync(path.join(__dirname, "index.html"), html, "utf8");
fs.writeFileSync(path.join(__dirname, ".nojekyll"), "", "utf8");
fs.writeFileSync(
  path.join(__dirname, "README.md"),
  [
    "# Claude WARP 排障手册静态页",
    "",
    "这个目录由 `build-site.mjs` 从 Obsidian Markdown 生成，可直接用 GitHub Pages 发布。",
    "",
    "重新生成时传入本地 Obsidian 笔记路径：",
    "",
    "```bash",
    "node build-site.mjs /path/to/用-WARP-落地解决-Claude-app-Cloudflare-验证闪跳.md",
    "```",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Generated ${path.join(__dirname, "index.html")}`);

function splitFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: "", body: markdown };
  return {
    frontmatter: match[1],
    body: markdown.slice(match[0].length),
  };
}

function parseFrontmatter(text) {
  const meta = {};
  let currentKey = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const listItem = line.match(/^\s*-\s+(.*)$/);

    if (keyValue) {
      currentKey = keyValue[1];
      meta[currentKey] = keyValue[2] || [];
      continue;
    }

    if (listItem && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(listItem[1]);
    }
  }

  return meta;
}

function collectHeadings(rawLines) {
  const headings = [];
  const slugCounts = new Map();
  let inFence = false;

  for (const line of rawLines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    if (inFence) continue;

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;

    const level = match[1].length;
    const text = stripInlineSyntax(match[2].trim());
    const baseSlug = slugify(text);
    const seen = slugCounts.get(baseSlug) || 0;
    slugCounts.set(baseSlug, seen + 1);

    headings.push({
      level,
      text,
      slug: seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`,
    });
  }

  return headings;
}

function renderBlocks(rawLines, state) {
  let i = 0;
  const out = [];

  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const { html, next } = renderCodeBlock(rawLines, i);
      out.push(html);
      i = next;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const headingInfo = state.headings[state.headingCursor++] || {
        text: stripInlineSyntax(heading[2].trim()),
        slug: slugify(heading[2].trim()),
      };
      const anchor = `<a class="heading-anchor" aria-label="复制本节链接" href="#${escapeAttr(headingInfo.slug)}">#</a>`;
      out.push(
        `<h${level} id="${escapeAttr(headingInfo.slug)}">${renderInline(headingInfo.text, state)}${anchor}</h${level}>`,
      );
      i += 1;
      continue;
    }

    if (/^>\s*\[![A-Za-z]+\]/.test(line)) {
      const { html, next } = renderCallout(rawLines, i, state);
      out.push(html);
      i = next;
      continue;
    }

    if (line.startsWith(">")) {
      const quoteLines = [];
      while (i < rawLines.length && rawLines[i].startsWith(">")) {
        quoteLines.push(rawLines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoteLines, state)}</blockquote>`);
      continue;
    }

    if (isTableStart(rawLines, i)) {
      const { html, next } = renderTable(rawLines, i, state);
      out.push(html);
      i = next;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const { html, next } = renderList(rawLines, i, "ul", state);
      out.push(html);
      i = next;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const { html, next } = renderList(rawLines, i, "ol", state);
      out.push(html);
      i = next;
      continue;
    }

    const paragraphLines = [];
    while (i < rawLines.length && shouldContinueParagraph(rawLines, i)) {
      paragraphLines.push(rawLines[i].trim());
      i += 1;
    }
    out.push(`<p>${renderInline(paragraphLines.join(" "), state)}</p>`);
  }

  return out.join("\n");
}

function renderCodeBlock(rawLines, start) {
  const first = rawLines[start].trim();
  const language = first.replace(/^```/, "").trim() || "text";
  const code = [];
  let i = start + 1;

  while (i < rawLines.length && !rawLines[i].trim().startsWith("```")) {
    code.push(rawLines[i]);
    i += 1;
  }

  if (i < rawLines.length) i += 1;

  const label = language === "text" ? "text" : language;
  return {
    next: i,
    html: [
      `<div class="code-block" data-language="${escapeAttr(label)}">`,
      '<div class="code-toolbar">',
      `<span>${escapeHtml(label)}</span>`,
      '<button class="copy-code" type="button">复制</button>',
      "</div>",
      `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`,
      "</div>",
    ].join("\n"),
  };
}

function renderCallout(rawLines, start, state) {
  const first = rawLines[start].match(/^>\s*\[!([A-Za-z]+)\]\s*(.*)$/);
  const type = (first?.[1] || "note").toLowerCase();
  const title = first?.[2]?.trim() || calloutTitle(type);
  const content = [];
  let i = start + 1;

  while (i < rawLines.length && rawLines[i].startsWith(">")) {
    content.push(rawLines[i].replace(/^>\s?/, ""));
    i += 1;
  }

  return {
    next: i,
    html: [
      `<aside class="callout callout-${escapeAttr(type)}">`,
      `<div class="callout-title"><span>${calloutIcon(type)}</span>${renderInline(title, state)}</div>`,
      `<div class="callout-body">${renderBlocks(content, state)}</div>`,
      "</aside>",
    ].join("\n"),
  };
}

function renderList(rawLines, start, tag, state) {
  const items = [];
  let i = start;
  const matcher = tag === "ul" ? /^\s*[-*]\s+(.+)$/ : /^\s*\d+\.\s+(.+)$/;

  while (i < rawLines.length) {
    const match = rawLines[i].match(matcher);
    if (!match) break;
    items.push(`<li>${renderInline(match[1].trim(), state)}</li>`);
    i += 1;
  }

  return {
    next: i,
    html: `<${tag}>\n${items.join("\n")}\n</${tag}>`,
  };
}

function renderTable(rawLines, start, state) {
  const rows = [];
  let i = start;

  while (i < rawLines.length && rawLines[i].trim().startsWith("|")) {
    rows.push(rawLines[i]);
    i += 1;
  }

  const header = splitTableRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitTableRow);
  const headerHtml = header.map((cell) => `<th>${renderInline(cell, state)}</th>`).join("");
  const rowsHtml = bodyRows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, state)}</td>`).join("")}</tr>`)
    .join("\n");

  return {
    next: i,
    html: `<div class="table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`,
  };
}

function isTableStart(rawLines, index) {
  if (!rawLines[index]?.trim().startsWith("|")) return false;
  const next = rawLines[index + 1]?.trim();
  return Boolean(next && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next));
}

function splitTableRow(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function shouldContinueParagraph(rawLines, index) {
  const line = rawLines[index];
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === "---" || trimmed === "***") return false;
  if (trimmed.startsWith("```")) return false;
  if (/^#{1,6}\s+/.test(line)) return false;
  if (/^>\s*/.test(line)) return false;
  if (/^\s*[-*]\s+/.test(line)) return false;
  if (/^\s*\d+\.\s+/.test(line)) return false;
  if (isTableStart(rawLines, index)) return false;
  return true;
}

function renderInline(raw, state) {
  const placeholders = [];
  let text = raw.replace(/`([^`]+)`/g, (_match, code) => {
    placeholders.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${placeholders.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  text = text.replace(/\[\[#([^|\]]+)\|([^\]]+)\]\]/g, (_match, target, label) => {
    const slug = state.headingByText.get(normalizeHeading(target)) || slugify(target);
    return `<a href="#${escapeAttr(slug)}">${escapeHtml(label)}</a>`;
  });

  text = text.replace(/\[\[#([^\]]+)\]\]/g, (_match, target) => {
    const slug = state.headingByText.get(normalizeHeading(target)) || slugify(target);
    return `<a href="#${escapeAttr(slug)}">${escapeHtml(target)}</a>`;
  });

  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label, href) => {
    return `<a href="${escapeAttr(href)}" rel="noopener noreferrer" target="_blank">${label}</a>`;
  });

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index) => placeholders[Number(index)] || "");

  return text;
}

function renderPage({ article, headings, title, intro, meta }) {
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const toc = headings.filter((heading) => heading.level >= 2 && heading.level <= 3);
  const updated = meta.updated || "2026-06-18";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(intro)}" />
  <style>
    :root {
      --bg: #f7f9f7;
      --paper: #ffffff;
      --ink: #17221d;
      --muted: #5f6a64;
      --soft: #eef3ef;
      --line: #d8e2db;
      --accent: #14766a;
      --accent-strong: #0d5f55;
      --accent-warm: #b85f26;
      --warn: #b33a33;
      --bug: #8b3e75;
      --code-bg: #111a18;
      --code-line: #2b3a36;
      --code-text: #e8f1ec;
      --shadow: 0 18px 50px rgba(16, 34, 27, 0.08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-size: 16px;
      line-height: 1.72;
      letter-spacing: 0;
    }

    a {
      color: var(--accent-strong);
      text-decoration-thickness: 1px;
      text-underline-offset: 0.18em;
    }

    .site-header {
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(130deg, rgba(20, 118, 106, 0.13), rgba(184, 95, 38, 0.11) 58%, rgba(255, 255, 255, 0.82)),
        var(--paper);
    }

    .header-inner {
      max-width: 1180px;
      margin: 0 auto;
      padding: 46px 24px 34px;
    }

    .eyebrow {
      margin: 0 0 12px;
      color: var(--accent-strong);
      font-size: 14px;
      font-weight: 700;
    }

    h1 {
      max-width: 900px;
      margin: 0;
      font-size: clamp(32px, 5vw, 56px);
      line-height: 1.08;
      letter-spacing: 0;
    }

    .subtitle {
      max-width: 860px;
      margin: 18px 0 0;
      color: #33423b;
      font-size: 18px;
      line-height: 1.65;
    }

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 22px;
      color: var(--muted);
      font-size: 14px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      padding: 4px 10px;
      border: 1px solid rgba(20, 118, 106, 0.18);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.76);
      color: #2d4940;
      font-weight: 650;
    }

    .page-shell {
      display: grid;
      grid-template-columns: minmax(190px, 250px) minmax(0, 880px);
      gap: 42px;
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }

    .toc {
      position: sticky;
      top: 18px;
      align-self: start;
      max-height: calc(100vh - 36px);
      overflow: auto;
      padding: 16px 0 16px 16px;
      border-left: 3px solid var(--line);
    }

    .toc strong {
      display: block;
      margin-bottom: 10px;
      color: #24332d;
      font-size: 14px;
    }

    .toc a {
      display: block;
      margin: 7px 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
      text-decoration: none;
    }

    .toc a:hover {
      color: var(--accent-strong);
    }

    .toc .toc-l3 {
      padding-left: 14px;
      font-size: 13px;
    }

    article {
      min-width: 0;
      padding-bottom: 20px;
    }

    article h1 {
      display: none;
    }

    article h2,
    article h3,
    article h4 {
      position: relative;
      letter-spacing: 0;
      scroll-margin-top: 24px;
    }

    article h2 {
      margin: 44px 0 14px;
      padding-top: 6px;
      font-size: 28px;
      line-height: 1.28;
    }

    article h3 {
      margin: 32px 0 12px;
      font-size: 22px;
      line-height: 1.32;
    }

    article h4 {
      margin: 24px 0 10px;
      font-size: 18px;
    }

    .heading-anchor {
      margin-left: 8px;
      color: #90a19a;
      font-size: 0.72em;
      text-decoration: none;
      opacity: 0;
    }

    h2:hover .heading-anchor,
    h3:hover .heading-anchor,
    h4:hover .heading-anchor {
      opacity: 1;
    }

    article p,
    article li {
      color: #25312c;
    }

    article p {
      margin: 13px 0;
    }

    article ul,
    article ol {
      padding-left: 1.35rem;
      margin: 14px 0;
    }

    article li + li {
      margin-top: 6px;
    }

    strong {
      color: #111c17;
      font-weight: 750;
    }

    hr {
      border: 0;
      border-top: 1px solid var(--line);
      margin: 34px 0;
    }

    code {
      border: 1px solid rgba(20, 118, 106, 0.18);
      border-radius: 6px;
      background: #edf5f1;
      color: #0f5f55;
      padding: 0.08em 0.34em;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 0.92em;
      overflow-wrap: anywhere;
    }

    .code-block {
      margin: 18px 0;
      overflow: hidden;
      border: 1px solid var(--code-line);
      border-radius: 8px;
      background: var(--code-bg);
      box-shadow: var(--shadow);
    }

    .code-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 10px 8px 14px;
      border-bottom: 1px solid var(--code-line);
      color: #a9bbb4;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }

    .copy-code {
      min-width: 58px;
      border: 1px solid rgba(232, 241, 236, 0.22);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      color: #e8f1ec;
      cursor: pointer;
      font: inherit;
      padding: 4px 8px;
    }

    .copy-code:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    pre {
      margin: 0;
      overflow-x: auto;
      padding: 16px;
      color: var(--code-text);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.62;
    }

    pre code {
      display: block;
      border: 0;
      background: transparent;
      color: inherit;
      padding: 0;
      white-space: pre;
      overflow-wrap: normal;
    }

    blockquote,
    .callout {
      margin: 18px 0;
      border-left: 4px solid var(--accent);
      background: #ffffff;
      box-shadow: 0 10px 30px rgba(16, 34, 27, 0.06);
    }

    blockquote {
      padding: 12px 16px;
      color: #33423b;
    }

    .callout {
      border-radius: 8px;
      overflow: hidden;
    }

    .callout-title {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 12px 16px;
      border-bottom: 1px solid rgba(20, 118, 106, 0.1);
      color: #16352f;
      font-weight: 760;
    }

    .callout-title span {
      display: inline-grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: rgba(20, 118, 106, 0.12);
      color: var(--accent-strong);
      font-size: 13px;
      flex: 0 0 auto;
    }

    .callout-body {
      padding: 12px 16px 14px;
    }

    .callout-body > :first-child {
      margin-top: 0;
    }

    .callout-body > :last-child {
      margin-bottom: 0;
    }

    .callout-warning {
      border-left-color: var(--accent-warm);
    }

    .callout-warning .callout-title span {
      background: rgba(184, 95, 38, 0.14);
      color: #91501e;
    }

    .callout-important,
    .callout-bug {
      border-left-color: var(--warn);
    }

    .callout-important .callout-title span,
    .callout-bug .callout-title span {
      background: rgba(179, 58, 51, 0.12);
      color: var(--warn);
    }

    .callout-tip {
      border-left-color: #30805c;
    }

    .table-wrap {
      width: 100%;
      margin: 18px 0;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--paper);
    }

    table {
      width: 100%;
      min-width: 760px;
      border-collapse: collapse;
      font-size: 14px;
    }

    th,
    td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      background: var(--soft);
      color: #26352f;
      font-weight: 760;
      white-space: nowrap;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .site-footer {
      max-width: 1180px;
      margin: 0 auto;
      padding: 0 24px 44px;
      color: var(--muted);
      font-size: 14px;
    }

    @media (max-width: 880px) {
      .header-inner {
        padding: 34px 18px 28px;
      }

      .subtitle {
        font-size: 16px;
      }

      .page-shell {
        display: block;
        padding: 22px 18px 54px;
      }

      .toc {
        position: static;
        max-height: none;
        margin-bottom: 22px;
        padding: 12px 0 12px 14px;
      }

      .toc a {
        display: inline-block;
        margin: 4px 12px 4px 0;
      }

      .toc .toc-l3 {
        padding-left: 0;
      }

      article h2 {
        font-size: 24px;
      }

      article h3 {
        font-size: 20px;
      }

      pre {
        font-size: 12px;
      }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <p class="eyebrow">Claude app / Claude Code 代理排障手册</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="subtitle">${escapeHtml(intro)}</p>
      <div class="meta-row">
        <span class="pill">更新：${escapeHtml(updated)}</span>
        ${tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("\n        ")}
      </div>
    </div>
  </header>
  <main class="page-shell">
    <nav class="toc" aria-label="目录">
      <strong>目录</strong>
      ${toc
        .map(
          (heading) =>
            `<a class="toc-l${heading.level}" href="#${escapeAttr(heading.slug)}">${escapeHtml(heading.text)}</a>`,
        )
        .join("\n      ")}
    </nav>
    <article>
      ${article}
    </article>
  </main>
  <footer class="site-footer">
    <p>公开分享版。命令中的私钥、secret、真实节点信息请按自己的环境替换，不要直接发布个人凭据。</p>
  </footer>
  <script>
    document.querySelectorAll(".copy-code").forEach(function(button) {
      button.addEventListener("click", async function() {
        const code = button.closest(".code-block").querySelector("code").innerText;
        try {
          await navigator.clipboard.writeText(code);
          const oldText = button.textContent;
          button.textContent = "已复制";
          setTimeout(function() { button.textContent = oldText; }, 1200);
        } catch (error) {
          button.textContent = "复制失败";
          setTimeout(function() { button.textContent = "复制"; }, 1200);
        }
      });
    });
  </script>
</body>
</html>
`;
}

function extractIntro(rawLines) {
  const noteStart = rawLines.findIndex((line) => /^>\s*\[!note\]\s*/.test(line));
  if (noteStart >= 0 && rawLines[noteStart + 1]?.startsWith(">")) {
    return stripInlineSyntax(rawLines[noteStart + 1].replace(/^>\s?/, "")).slice(0, 210);
  }

  const paragraph = rawLines.find((line) => line.trim() && !line.startsWith("#") && !line.startsWith(">"));
  return stripInlineSyntax(paragraph || "Claude app 与 Claude Code 代理排障手册");
}

function stripInlineSyntax(text) {
  return text
    .replace(/\[\[#([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[#([^\]]+)\]\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
}

function normalizeHeading(text) {
  return stripInlineSyntax(text)
    .replace(/^#/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function slugify(text) {
  const slug = stripInlineSyntax(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[,.，。！？、：；（）()[\]{}"'“”‘’`~!@#$%^&*=+|\\/<>?]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function calloutTitle(type) {
  return (
    {
      note: "提示",
      warning: "注意",
      important: "重要",
      tip: "技巧",
      bug: "故障",
    }[type] || "提示"
  );
}

function calloutIcon(type) {
  return (
    {
      note: "i",
      warning: "!",
      important: "!",
      tip: "?",
      bug: "!",
    }[type] || "i"
  );
}
