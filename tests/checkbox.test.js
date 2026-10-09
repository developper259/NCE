const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const settingsCss = fs.readFileSync(
  path.join(__dirname, "../src/css/settings.css"),
  "utf8",
);
const explorerCss = fs.readFileSync(
  path.join(__dirname, "../src/css/sidebar/fileExplorer.css"),
  "utf8",
);
const explorerSource = fs.readFileSync(
  path.join(__dirname, "../src/js/sidebar/FileExplorer.Sidebar.js"),
  "utf8",
);

test("NCE checkbox keeps a real accessible input and derives its mark from checked state", () => {
  assert.match(settingsCss, /\.nce-checkbox\s*>\s*input\[type="checkbox"\][^{]*\{[^}]*opacity:\s*0;[^}]*appearance:\s*none;/s);
  assert.doesNotMatch(settingsCss, /\.nce-checkbox\s*>\s*input\[type="checkbox"\][^{]*\{[^}]*(?:display:\s*none|visibility:\s*hidden)/s);
  assert.match(settingsCss, /input\[type="checkbox"\]:checked\s*\+\s*\.nce-checkbox-box/);
  assert.match(settingsCss, /input\[type="checkbox"\]:checked\s*\+\s*\.nce-checkbox-box svg\s*\{[^}]*opacity:\s*1/s);
  assert.match(explorerSource, /checkboxLabel\.append\(checkbox, checkboxBox, checkboxText\)/);
  assert.match(explorerSource, /const checkboxTick\s*=\s*document\.createElementNS\([\s\S]*?"path"/);
  assert.doesNotMatch(explorerSource, /[✓✔]/);
});

test("NCE checkbox styles hover, keyboard focus, disabled state, and reduced motion", () => {
  assert.match(settingsCss, /\.nce-checkbox:hover\s*>\s*input\[type="checkbox"\]:not\(:disabled\)\s*\+\s*\.nce-checkbox-box/);
  assert.match(settingsCss, /input\[type="checkbox"\]:focus-visible\s*\+\s*\.nce-checkbox-box/);
  assert.match(settingsCss, /\.nce-checkbox:has\(> input\[type="checkbox"\]:disabled\)/);
  assert.match(settingsCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(settingsCss, /transition: [^;]*140ms/);
  assert.match(settingsCss, /\.nce-checkbox-box\s*\{[^}]*background:\s*var\(--bg-primary\)/s);
  assert.match(settingsCss, /input\[type="checkbox"\]:checked\s*\+\s*\.nce-checkbox-box\s*\{[^}]*background:\s*var\(--bg-active\)/s);
  assert.doesNotMatch(explorerCss, /accent-color:/);
});
