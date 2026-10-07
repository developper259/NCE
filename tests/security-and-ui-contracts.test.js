const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Markdown renderer keeps strict default and isolates sanitized workspace preview", () => {
  const source = read("src/js/addon/MarkdownRenderer.js");
  assert.match(source, /STRICT:\s*"strict"/);
  assert.match(source, /WORKSPACE_PREVIEW:\s*"workspace-preview"/);
  assert.match(source, /createMarkdownEngine\(\{ html: false, images: false \}\)/);
  assert.match(source, /createMarkdownEngine\(\{ html: true, images: true \}\)/);
  assert.match(source, /if \(!images\) markdown\.disable\("image"\)/);
  assert.match(source, /sanitizePreviewFragment/);
  assert.match(source, /loadPreviewImages/);
  assert.match(source, /\["http:", "https:", "mailto:"\]/);
  assert.match(source, /token\.className/);
  assert.match(source, /\^nsh-\[a-z0-9-\]\+\$/i);
  assert.match(read("src/js/sidebar/Agent.Sidebar.js"), /new MarkdownRenderer\(/);
  assert.doesNotMatch(read("src/js/sidebar/Agent.Sidebar.js"), /WORKSPACE_PREVIEW/);
});

test("Preload exposes the core IPC contract without node integration", () => {
  const preload = read("src/js/main/Preload.js");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("api"/);
  for (const method of ["rendererReady", "getNshEndpoint", "getFileContent", "readFileForMerge", "saveFile", "saveRecoverySnapshot", "listRecoverySnapshots", "readRecoverySnapshot", "deleteRecoverySnapshot", "confirmRecoverySnapshot", "startWatching", "searchInFiles", "startWorkspaceSearch", "onWorkspaceSearchEvent", "onFileSystemChange"]) {
    assert.match(preload, new RegExp(`${method}`));
  }
  assert.doesNotMatch(preload, /require\("fs"\)|require\("path"\)/);
});

test("TabManager protects asynchronous focus changes and dirty close flows", () => {
  const source = read("src/js/manager/TabManager.js");
  assert.match(source, /focusGeneration/);
  assert.match(source, /await this\.setFocusFile\(file\)/);
  assert.match(source, /confirmClose\(id\)/);
  assert.match(source, /await file\.save\(\)/);
});

test("Agent tool surface is present and remains local-testable", () => {
  const rendererScripts = JSON.parse(read("src/js/main/renderer-agent-scripts.json"));
  for (const script of [
    "agent/runtime/AgentRunner.js",
    "agent/tools/ToolRegistry.js",
    "agent/tools/ToolExecutor.js",
    "agent/files/ActiveFileManager.js",
    "agent/files/FileContextManager.js",
    "agent/files/LargeFileWriter.js",
  ]) {
    assert.ok(rendererScripts.includes(`js/${script}`), script);
    assert.equal(fs.existsSync(path.join(root, "src/js", script)), true, script);
  }
  assert.doesNotMatch(read("src/js/agent/model/ModelClient.js"), /fetch\([^)]*openai\.com/);
});

test("titlebar full wrapper and internal safe content area stay structurally separated", () => {
  const html = read("src/html/index.html");
  const css = read("src/css/titlebar.css");
  const windowTs = read("src/ts/Window.ts");
  const vars = read("src/css/var.css");
  assert.match(html, /<header class="nce-titlebar">[\s\S]*<div class="nce-titlebar-content">/);
  assert.match(css, /\.nce-titlebar::after/);
  assert.match(css, /\.nce-titlebar-content\s*\{/);
  assert.match(css, /top:\s*var\(--titlebar-controls-height\)/);
  assert.match(css, /height:\s*var\(--titlebar-controls-height\)/);
  assert.match(css, /height:\s*var\(--titlebar-height\)/);
  assert.match(css, /padding-left:\s*0/);
  assert.match(css, /margin-left:\s*0/);
  assert.match(windowTs, /TITLEBAR_CONTROLS_HEIGHT\s*=\s*35/);
  assert.match(windowTs, /height:\s*TITLEBAR_CONTROLS_HEIGHT/);
  assert.match(vars, /--titlebar-controls-height:\s*35px/);
  assert.match(vars, /--titlebar-height:\s*36px/);
  assert.match(css, /left:\s*env\(titlebar-area-x,\s*0\)/);
  assert.doesNotMatch(css, /^\.nce-titlebar \{[^}]*left:\s*env\(titlebar-area-x/);
  assert.doesNotMatch(css, /^\.nce-titlebar \{[^}]*width:\s*env\(titlebar-area-width/);
});

test("asset and command availability contracts stay aligned", () => {
  const html = read("src/html/index.html");
  const rendererScripts = JSON.parse(read("src/js/main/renderer-scripts.json"));
  const keybindings = read("src/config/Application.js");
  const menu = read("src/ts/addon/Menu.ts");
  assert.match(html, /assets\/flaticon\/all\.css/);
  const tabManager = read("src/js/manager/TabManager.js");
  assert.match(tabManager, /assets\/icons\/close\.svg/);
  assert.match(tabManager, /img\.draggable\s*=\s*false/);
  assert.match(
    read("src/css/tabManager.css"),
    /\.file-el-btn img\s*\{[^}]*-webkit-user-drag:\s*none/s,
  );
  assert.ok(rendererScripts.includes("js/types/QuickPanel.js"));
  assert.ok(rendererScripts.includes("js/core/ThreeWayMerge.js"));
  assert.match(keybindings, /action:\s*"open_command"/);
  assert.match(keybindings, /action:\s*"reload_window"/);
  assert.match(keybindings, /action:\s*"quit_app"/);
  assert.doesNotMatch(keybindings, /action:\s*"replace"/);
  assert.doesNotMatch(menu, /label:\s*"(?:Replace|Documentation|Check for Updates)"/);
});

test("Quick Panel keeps Command Palette and Quick Open compact with a custom virtual scroller", () => {
  const css = read("src/css/quickPanel.css");
  const rendererScripts = JSON.parse(read("src/js/main/renderer-scripts.json"));
  assert.match(css, /\.quick-panel-input\s*\{[\s\S]*?height:\s*30px/);
  assert.match(css, /\.quick-panel-item\s*\{[\s\S]*?height:\s*var\(--quick-panel-row-height\)/);
  assert.match(css, /data-panel-id="command-palette"[\s\S]*?padding-top:\s*2px/);
  assert.doesNotMatch(css, /data-panel-id="quick-open"/);
  assert.match(css, /\.quick-panel-list\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /--quick-panel-row-height:\s*30px/);
  assert.doesNotMatch(css, /quick-panel-list::-webkit-scrollbar|scrollbar-width/);
  assert.ok(rendererScripts.includes("js/scrollers/QuickPanel.Scroller.js"));
  assert.match(css, /max-height:\s*min\(420px, calc\(100vh - 60px\)\)/);
  assert.doesNotMatch(css, /border-color:\s*var\(--border-accent\)/);
});

test("reload is keybinding-backed while DevTools remain unavailable", () => {
  const titlebar = read("src/js/addon/TitleBar.js");
  const keybindings = read("src/config/Application.js");
  const menu = read("src/ts/addon/Menu.ts");
  const windowTs = read("src/ts/Window.ts");
  const activeLines = (source) => source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  assert.doesNotMatch(activeLines(titlebar), /view\.devtools|Developer Tools/);
  assert.doesNotMatch(activeLines(menu), /Toggle Developer Tools|openDevTools\(|CommandOrControl\+R|Ctrl\+Shift\+I|Alt\+Cmd\+I/);
  assert.doesNotMatch(activeLines(windowTs), /before-input-event|case "view\.devtools"|\.openDevTools\(\)|\.closeDevTools\(\)/);
  assert.match(activeLines(keybindings), /action:\s*"reload_window"/);
  assert.match(activeLines(titlebar), /\["Reload Window", "reload_window"\]/);
  assert.match(activeLines(menu), /this\.getAccelerator\("reload_window"\)/);
  assert.match(activeLines(windowTs), /case "view\.reload"/);
  assert.match(activeLines(titlebar), /view\.fullscreen/);
  assert.match(activeLines(windowTs), /case "view\.fullscreen"/);
  assert.match(activeLines(windowTs), /case "help\.about"/);
});
