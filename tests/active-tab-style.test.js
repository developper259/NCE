const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");

test("active tabs cover the tab-bar divider with the editor surface", async () => {
  const [html, css] = await Promise.all([
    fs.readFile("src/html/index.html", "utf8"),
    fs.readFile("src/css/tabManager.css", "utf8"),
  ]);
  const tabBar = html.match(/<div class="file-manager ([^"]*)">/);
  const tabList = css.match(/\.file-manager \.files-ul\s*\{([^}]*)\}/s)?.[1] || "";
  const tab = css.match(/\.file-manager \.files-ul \.file-el\s*\{([^}]*)\}/s)?.[1] || "";
  const activeTab = css.match(/\.file-manager \.files-ul \.file-active\s*\{([^}]*)\}/s)?.[1] || "";

  assert.ok(tabBar, "tab bar shell should be present");
  assert.equal(tabBar[1].split(/\s+/).includes("box-bottom"), false);
  assert.match(tabList, /box-shadow:\s*inset 0 -1px 0 var\(--border-primary\)/);
  assert.match(tab, /border-bottom:\s*1px solid var\(--border-primary\)/);
  assert.match(activeTab, /background-color:\s*var\(--bg-secondary\)/);
  assert.match(activeTab, /border-bottom-color:\s*var\(--bg-secondary\)/);
  assert.match(activeTab, /z-index:\s*2/);
});
