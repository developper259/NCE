const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const CursorController = loadGlobal(
  "src/js/controller/CursorController.js",
  "CursorController",
  { document: { fonts: null }, window: {} },
);
const HistoryController = loadGlobal(
  "src/js/controller/HistoryController.js",
  "HistoryController",
);
const WriterController = loadGlobal(
  "src/js/controller/WriterController.js",
  "WriterController",
);
const SelectController = loadGlobal(
  "src/js/controller/SelectController.js",
  "SelectController",
  { addEvent() {} },
);

function createCursorController(activeFile) {
  const displays = [];
  const editor = {
    cD: {},
    posY: 19,
    domManager: {
      wrapFastNode: () => ({
        setDisplay(value) { displays.push(value); },
        setHeight() {},
        setStyle() {},
        setLeft() {},
        setTop() {},
      }),
    },
    tabManager: { activeFile },
  };
  const controller = new CursorController(editor);
  return { controller, editor, displays };
}

test("CursorController suppresses the caret while a diff view is active", () => {
  const activeFile = { isDiffView: true, row: 1, column: 0 };
  const { controller, editor, displays } = createCursorController(activeFile);
  controller.enable();
  assert.equal(displays.at(-1), "none");
  controller.disable();
  controller.enable();
  assert.equal(displays.at(-1), "none", "click focus cannot reveal the caret in a diff");
  controller.updateCaretPosition();
  assert.equal(displays.at(-1), "none", "caret updates stay hidden without geometry work");

  editor.tabManager.activeFile = { isDiffView: false, row: 1, column: 0 };
  controller.enable();
  assert.equal(displays.at(-1), "block", "normal files must get their caret back");
});

test("HistoryController refuses undo and redo on a diff buffer", async () => {
  const history = Object.create(HistoryController.prototype);
  history.editor = { tabManager: { activeFile: { isDiffView: true } } };
  assert.equal(await history.undo(), false);
  assert.equal(await history.redo(), false);
});

test("WriterController mutations are ignored on a diff buffer", () => {
  const writer = Object.create(WriterController.prototype);
  let touched = false;
  writer.editor = {
    tabManager: { activeFile: { isDiffView: true } },
    keyBinding: {},
    lineController: {
      get lines() { touched = true; return []; },
    },
  };
  assert.equal(writer.write("x"), undefined);
  assert.equal(writer.replaceRange("x", 1, 0, 1, 0), null);
  assert.equal(writer.deleteSelection(), null);
  assert.equal(writer.insertTextAt("x", 1, 0), null);
  assert.equal(writer.applyRangeEdit({ row: 1, column: 0 }, { row: 1, column: 0 }, "x"), null);
  assert.equal(touched, false, "no line buffer may be read or mutated");
});

test("Alt-click cannot add editing cursors inside a diff view", () => {
  let added = 0;
  let prevented = false;
  const select = Object.create(SelectController.prototype);
  select.stopAutoScroll = () => {};
  select.editor = {
    tabManager: { activeFile: { isDiffView: true } },
    multiCursorController: {
      isEligible: () => true,
      addCursorAtClientCoordinates() { added += 1; },
    },
  };
  select.mouseDown({
    altKey: true,
    button: 0,
    clientX: 10,
    clientY: 10,
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  assert.equal(added, 0);
  assert.equal(prevented, true);
});

test("Diff focus styling dims context and accents changed lines with theme tokens", () => {
  const variables = fs.readFileSync(path.join(root, "src/css/var.css"), "utf8");
  const editorCss = fs.readFileSync(path.join(root, "src/css/editor.css"), "utf8");
  assert.match(variables, /--diff-focus-context-opacity:\s*0\.72/);
  assert.match(variables, /--diff-focus-context-opacity:\s*0\.68/);
  assert.match(variables, /--diff-focus-added-bg:\s*rgba\(95, 191, 127/);
  assert.match(variables, /--diff-focus-removed-bg:\s*rgba\(201, 60, 71/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-unchanged\s*\{\s*opacity:\s*var\(--diff-focus-context-opacity\)/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-added\s*\{[\s\S]*?var\(--diff-focus-added-bg\)[\s\S]*?inset 2px 0 0 var\(--git-added\)/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-removed\s*\{[\s\S]*?var\(--diff-focus-removed-bg\)[\s\S]*?inset 2px 0 0 var\(--git-deleted\)/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-number-added::after\s*\{[\s\S]*?content:\s*"\+"/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-number-removed::after\s*\{[\s\S]*?content:\s*"−"/);
  assert.doesNotMatch(editorCss, /\.editor-git-diff-active \.line-unchanged\s*\{[^}]*color:/s,
    "syntax colors must not be replaced for context lines");
});
