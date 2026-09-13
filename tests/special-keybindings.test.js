const test = require("node:test");
const assert = require("node:assert/strict");

const { loadGlobal } = require("./helpers/runtime");
const { loadMain } = require("./helpers/main-runtime");

test("French dead-key events resolve to bindable circumflex and diaeresis keys", () => {
  const resolveKey = loadGlobal(
    "src/config/Application.js",
    "CONFIG_KEYBINDING_EVENT_KEY",
  );

  assert.equal(
    resolveKey({ key: "Dead", code: "BracketLeft", shiftKey: false }),
    "^",
  );
  assert.equal(
    resolveKey({ key: "Dead", code: "BracketLeft", shiftKey: true }),
    "¨",
  );
  assert.equal(resolveKey({ key: "^", code: "BracketLeft" }), "^");
  assert.equal(resolveKey({ key: "Dead", code: "Quote" }), "");
});

test("native menu shortcuts can be suspended only while Settings captures a key", () => {
  const ignoredStates = [];
  const { Window } = loadMain("dist/ts/Window.js", {
    electron: {},
    "./addon/FileManager": { FileManager: class {} },
    "./addon/Watcher": { Watcher: class {} },
    "./addon/Menu": { AppMenu: class {} },
    "./addon/ContextMenu": { ContextMenu: class {} },
    "./addon/WorkspaceSearch": { WorkspaceSearch: class {} },
    "./App": { App: class {} },
  });
  const window = new Window({});
  window.window = {
    webContents: {
      setIgnoreMenuShortcuts: (ignored) => ignoredStates.push(ignored),
    },
  };

  assert.equal(window.setMenuShortcutsIgnored(true), true);
  assert.equal(window.setMenuShortcutsIgnored(false), true);
  assert.deepEqual(ignoredStates, [true, false]);
  assert.equal(window.setMenuShortcutsIgnored("true"), false);
});
