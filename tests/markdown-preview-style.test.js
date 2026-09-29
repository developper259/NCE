const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Markdown Preview typography and document rules stay scoped and theme-aware", () => {
  const css = read("src/css/markdownView.css");
  const html = read("src/html/index.html");
  const view = read("src/js/view/MarkdownView.js");

  assert.match(html, /<article class="markdown-preview-content"><\/article>/);
  assert.match(view, /querySelector\("\.markdown-preview-content"\)/);
  assert.doesNotMatch(html, /markdown-preview-content[^>]*agent-sidebar-markdown/);
  assert.doesNotMatch(css, /agent-sidebar-markdown/);

  assert.match(css, /\.markdown-preview-content\s*\{[^}]*font-family:\s*-apple-system,[\s\S]*font-size:\s*16px/s);
  assert.doesNotMatch(css, /\.markdown-preview-content\s*\{[^}]*font-family:[^;]*JetBrains Mono/s);
  assert.match(css, /\.markdown-preview-content\s*:not\(pre\)\s*>\s*code[\s\S]*font-family:\s*ui-monospace/);
  assert.match(css, /\.markdown-preview-content\s+pre\s*\{[^}]*overflow:\s*auto/s);
  assert.match(css, /\.markdown-preview-content\s+pre\s*>\s*code\s*\{[^}]*font-family:\s*inherit/s);

  assert.match(css, /\.markdown-preview-content h1\s*\{\s*font-size:\s*2em/);
  assert.match(css, /\.markdown-preview-content h2\s*\{\s*font-size:\s*1\.5em/);
  assert.match(css, /\.markdown-preview-content h1,[\s\S]*?\.markdown-preview-content h2\s*\{[^}]*border-bottom:\s*1px solid var\(--border-primary\)/);
  assert.match(css, /\.markdown-preview-content p\s*\{\s*margin:\s*0 0 16px/);
  assert.match(css, /\.markdown-preview-content li \+ li\s*\{\s*margin-top:\s*0\.25em/);
  const imageRule = css.match(/\.markdown-preview-content img\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(imageRule, /max-width:\s*100%/);
  assert.doesNotMatch(imageRule, /(?:^|;)\s*width\s*:/);
  assert.match(css, /\.markdown-preview-content \.markdown-table-wrapper\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /@media \(max-width:\s*700px\)[\s\S]*\.markdown-preview-content\s*\{\s*padding:\s*20px 20px 48px/);
  assert.match(css, /var\(--text-primary\)/);
  assert.match(css, /var\(--text-secondary\)/);
  assert.match(css, /var\(--border-primary\)/);
  assert.match(css, /var\(--accent-primary\)/);

  const selectors = [...css.matchAll(/(?:^|})\s*([^@{}]+)\s*\{/g)]
    .map((match) => match[1].trim())
    .flatMap((selectorGroup) => selectorGroup.split(",").map((selector) => selector.trim()));
  for (const selector of selectors) {
    assert.ok(
      selector.startsWith(".markdown-preview-content") ||
        selector.startsWith(".markdown-view-host") ||
        selector.startsWith(".editor-markdown-active"),
      `Markdown Preview CSS selector must stay scoped: ${selector}`,
    );
  }
});
