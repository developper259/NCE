const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function createBinding(activeFile) {
  let resolveClipboard;
  const clipboard = new Promise((resolve) => { resolveClipboard = resolve; });
  const writes = [];
  const edits = [];
  const document = { hasFocus: () => true };
  const navigator = {
    clipboard: {
      readText: () => clipboard,
      writeText: () => clipboard,
    },
  };
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    document,
    navigator,
    window: { api: {} },
  });
  const binding = Object.create(KeyBinding.prototype);
  const editor = {
    tabManager: { activeFile },
    multiCursorController: {
      getSelections: () => [],
      isSelected: () => false,
    },
    selectController: {
      hasActiveSelection: () => true,
      getSelectedText: () => "selected",
    },
    writerController: {
      getSelectionRange: () => ({
        start: { row: 1, column: 0 },
        end: { row: 1, column: 8 },
      }),
      applyBatchEdits: (value) => {
        edits.push(value);
        return { row: 1, column: 0 };
      },
      deleteRange: (...args) => writes.push(["delete", ...args]),
      write: (text) => writes.push(["write", text]),
    },
    cursorController: { row: 1 },
    lineController: { lines: [{ getText: () => "selected" }] },
  };
  binding.editor = editor;
  binding.getClipboardText = () => "selected";
  return {
    binding,
    editor,
    writes,
    edits,
    finishClipboard: () => resolveClipboard(),
  };
}

test("Ctrl+X does not delete text after the active tab changed during the clipboard write", async () => {
  const first = { id: "first", _multiCursorPrimaryId: "first" };
  const second = { id: "second", _multiCursorPrimaryId: "second" };
  const fixture = createBinding(first);
  const pending = fixture.binding.control_cut();
  fixture.editor.tabManager.activeFile = second;
  fixture.finishClipboard();
  assert.equal(await pending, false);
  assert.equal(fixture.edits.length, 0);
  assert.equal(fixture.writes.length, 0);
});

test("Ctrl+V does not paste into a tab selected during the clipboard read", async () => {
  const first = { id: "first" };
  const second = { id: "second" };
  const fixture = createBinding(first);
  const pending = fixture.binding.control_paste();
  fixture.editor.tabManager.activeFile = second;
  fixture.finishClipboard();
  await pending;
  assert.equal(fixture.writes.length, 0);
});
