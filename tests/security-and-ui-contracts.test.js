const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Markdown renderer disables unsafe HTML/images and validates links", () => {
  const source = read("src/js/addon/MarkdownRenderer.js");
  assert.match(source, /html:\s*false/);
  assert.match(source, /markdown\.disable\("image"\)/);
  assert.match(source, /\["http:", "https:", "mailto:"\]/);
  assert.match(source, /token\.className/);
  assert.match(source, /\^nsh-\[a-z0-9-\]\+\$/i);
});

test("Preload exposes the core IPC contract without node integration", () => {
  const preload = read("src/js/main/Preload.js");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("api"/);
  for (const method of ["rendererReady", "getNshEndpoint", "getFileContent", "saveFile", "startWatching", "searchInFiles", "onFileSystemChange"]) {
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
  const html = read("src/html/index.html");
  for (const script of [
    "agent/runtime/AgentRunner.js",
    "agent/tools/ToolRegistry.js",
    "agent/tools/ToolExecutor.js",
    "agent/files/ActiveFileManager.js",
    "agent/files/FileContextManager.js",
    "agent/files/LargeFileWriter.js",
  ]) {
    assert.match(html, new RegExp(`js/${script.replaceAll("/", "\\/")}`));
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
  const keybindings = read("src/config/User.js");
  const menu = read("src/ts/addon/Menu.ts");
  assert.match(html, /assets\/flaticon\/all\.css/);
  assert.match(read("src/js/manager/TabManager.js"), /assets\/icons\/close\.svg/);
  assert.match(html, /js\/types\/QuickPanel\.js/);
  assert.match(keybindings, /action:\s*"open_command"/);
  assert.doesNotMatch(keybindings, /action:\s*"replace"/);
  assert.doesNotMatch(menu, /label:\s*"(?:Replace|Documentation|Check for Updates)"/);
});

test("public UI and runtime expose no renderer reload or DevTools controls", () => {
  const titlebar = read("src/js/addon/TitleBar.js");
  const menu = read("src/ts/addon/Menu.ts");
  const windowTs = read("src/ts/Window.ts");
  const activeLines = (source) => source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  assert.doesNotMatch(activeLines(titlebar), /view\.devtools|Developer Tools/);
  assert.doesNotMatch(activeLines(menu), /Reload Window|Toggle Developer Tools|reloadWindow\(|openDevTools\(|CommandOrControl\+R|Ctrl\+Shift\+I|Alt\+Cmd\+I/);
  assert.doesNotMatch(activeLines(windowTs), /before-input-event|case "view\.devtools"|\.reload\(\)|\.openDevTools\(\)|\.closeDevTools\(\)/);
  assert.match(activeLines(titlebar), /view\.fullscreen/);
  assert.match(activeLines(windowTs), /case "view\.fullscreen"/);
  assert.match(activeLines(windowTs), /case "help\.about"/);
});
