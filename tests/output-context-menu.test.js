const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadGlobal, root } = require("./helpers/runtime");

function setup() {
  const commands = [];
  const pathCopies = [];
  const reveals = [];
  const searches = [];
  const bindings = {
    undo: "Mod+Z",
    redo: "Mod+Shift+Z",
    cut: "Mod+X",
    copy: "Mod+C",
    paste: "Mod+V",
    select_all: "Mod+A",
    find: "Mod+F",
    go_to_line: "Mod+G",
    open_command: "Mod+Shift+P",
  };
  const history = { undo: false, redo: false };
  const editor = {
    keyBinding: { exec(item) { commands.push(item.action); } },
    historyController: {
      canUndo() { return history.undo; },
      canRedo() { return history.redo; },
    },
    fileExplorer: {
      fileOperations: {
        copyPathToClipboard(...args) { pathCopies.push(args); },
        revealInExplorer(filePath) { reveals.push(filePath); },
      },
    },
    sidebarManager: { openMenu(id) { searches.push(["open", id]); } },
    searchSidebar: {
      query: "",
      runSearch() { searches.push(["search", this.query]); },
    },
  };
  const NCEPath = {
    normalize(value) {
      return String(value || "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "");
    },
    isInside(value, workspace) {
      const filePath = this.normalize(value);
      const rootPath = this.normalize(workspace);
      return Boolean(rootPath) &&
        (filePath === rootPath || filePath.startsWith(`${rootPath}/`));
    },
  };
  const buildOutputContextMenu = loadGlobal(
    "src/js/contextMenu/Output.ContextMenu.js",
    "buildOutputContextMenu",
    {
      NCEPath,
      CONFIG_KEYBINDING_GET_ACTION: (action) => ({ key: bindings[action] }),
    },
  );
  return {
    editor,
    menu: buildOutputContextMenu(editor),
    commands,
    history,
    pathCopies,
    reveals,
    searches,
  };
}

const fileContext = {
  isFile: true,
  file: { id: 1 },
  filePath: "/workspace/src/App.js",
  rootPath: "/workspace",
  selectedText: "TabManager",
};

test("Output context menu exposes the exact native action order", () => {
  const { menu } = setup();
  assert.deepEqual(Object.keys(menu), [
    "undo",
    "redo",
    "sep1",
    "cut",
    "copy",
    "paste",
    "sep2",
    "selectAll",
    "sep3",
    "find",
    "goToLine",
    "openCommandPalette",
    "searchSelection",
    "sep4",
    "copyFilePath",
    "copyRelativePath",
    "revealInFileExplorer",
  ]);
});

test("selection and history control contextual editing states", () => {
  const { menu, history } = setup();
  const noSelection = { ...fileContext, selectedText: "" };
  assert.equal(menu.cut.enabled(noSelection), false);
  assert.equal(menu.copy.enabled(noSelection), false);
  assert.equal(menu.searchSelection.enabled(noSelection), false);
  assert.equal(menu.undo.enabled(fileContext), false);
  assert.equal(menu.redo.enabled(fileContext), false);

  history.undo = true;
  history.redo = true;
  assert.equal(menu.cut.enabled(fileContext), true);
  assert.equal(menu.copy.enabled(fileContext), true);
  assert.equal(menu.searchSelection.enabled(fileContext), true);
  assert.equal(menu.undo.enabled(fileContext), true);
  assert.equal(menu.redo.enabled(fileContext), true);
});

test("editing, Find, Go to Line and Command Palette reuse keybinding commands", () => {
  const { menu, commands } = setup();
  for (const action of [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
    "find",
    "goToLine",
    "openCommandPalette",
  ]) {
    menu[action].callback(fileContext);
  }
  assert.deepEqual(commands, [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "select_all",
    "find",
    "go_to_line",
    "open_command",
  ]);
});

test("Search Selection opens workspace search with the selected text", () => {
  const { editor, menu, searches } = setup();
  menu.searchSelection.callback(fileContext);
  assert.equal(editor.searchSidebar.query, "TabManager");
  assert.deepEqual(searches, [
    ["open", "search"],
    ["search", "TabManager"],
  ]);
});

test("file path actions use existing clipboard and secure reveal operations", () => {
  const { menu, pathCopies, reveals } = setup();
  menu.copyFilePath.callback(fileContext);
  menu.copyRelativePath.callback(fileContext);
  menu.revealInFileExplorer.callback(fileContext);
  assert.deepEqual(pathCopies, [
    [fileContext.filePath, fileContext.rootPath, false],
    [fileContext.filePath, fileContext.rootPath, true],
  ]);
  assert.deepEqual(reveals, [fileContext.filePath]);
});

test("untitled, missing workspace, outside workspace and Settings disable file actions", () => {
  const { menu } = setup();
  const untitled = { ...fileContext, filePath: "" };
  assert.equal(menu.copyFilePath.enabled(untitled), false);
  assert.equal(menu.copyRelativePath.enabled(untitled), false);
  assert.equal(menu.revealInFileExplorer.enabled(untitled), false);

  const noWorkspace = { ...fileContext, rootPath: "" };
  assert.equal(menu.copyRelativePath.enabled(noWorkspace), false);
  assert.equal(menu.searchSelection.enabled(noWorkspace), false);
  assert.equal(
    menu.copyRelativePath.enabled({
      ...fileContext,
      filePath: "/elsewhere/App.js",
    }),
    false,
  );

  const settings = { isFile: false, selectedText: "TabManager" };
  for (const action of Object.values(menu)) {
    if (action.type !== "separator") {
      assert.equal(action.enabled(settings), false);
    }
  }
});

test("ContextMenuManager resolves current configurable accelerators", async () => {
  let payload;
  const window = {
    api: {
      onContextMenuTriggered() {},
      async openContextMenu(actions) { payload = actions; },
    },
  };
  const ContextMenuManager = loadGlobal(
    "src/js/manager/ContextMenuManager.js",
    "ContextMenuManager",
    { window },
  );
  const manager = new ContextMenuManager();
  manager.setMenu("output", {
    copy: { name: "Copy", keys: (context) => context.key },
  });
  await manager.openContextMenu("output", { key: "CommandOrControl+C" });
  assert.equal(payload[0].keys, "CommandOrControl+C");
});

test("Editor right click snapshots the active file context", () => {
  const source = fs.readFileSync(path.join(root, "src/js/main/Editor.js"), "utf8");
  assert.match(source, /this\.output\.addEventListener\("contextmenu"/);
  assert.match(source, /openContextMenu\("output", \{/);
  for (const property of ["isFile", "filePath", "rootPath", "selectedText"]) {
    assert.match(source, new RegExp(`${property}:`));
  }
});
