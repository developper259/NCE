const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function fixture(lineCount = 5) {
  const calls = [];
  const scrollCalls = [];
  const panelCalls = [];
  const panel = {
    current: null,
    input: { focusCalls: 0, focus() { this.focusCalls++; } },
    isOpen(id) { return this.current === id; },
    open(options) { this.current = options.id; panelCalls.push(options); return true; },
  };
  const file = lineCount === null ? null : {
    lines: Array.from({ length: lineCount }, () => ({})),
    loadingState: { status: "loaded" },
  };
  const editor = {
    quickPanel: panel,
    tabManager: { activeFile: file },
    selectController: { clears: 0, unSelectAll() { this.clears++; } },
    lineController: {
      maxViewLines: 20,
      getDisplayIndexForCursor(row) { return row - 1; },
      scrollTo(displayIndex) { scrollCalls.push(displayIndex); },
    },
    cursorController: {
      isRowVisible() { return true; },
      setCursorPosition(row, column) { calls.push({ row, column }); },
    },
  };
  const GoToLine = loadGlobal("src/js/quickPanel/GoToLine.js", "GoToLine");
  return { goToLine: new GoToLine(editor), editor, file, panel, panelCalls, calls, scrollCalls };
}

test("Go to Line opens without a file and remains explicit", () => {
  const { goToLine, panelCalls } = fixture(null);
  assert.equal(goToLine.open(), true);
  assert.equal(panelCalls[0].message, "No file open.");
  assert.equal(panelCalls[0].validate("1"), "No file open.");
});

test("Go to Line uses one-based rows and clamps to the current last line", () => {
  const f = fixture(500);
  for (const [input, expected] of [["1", 1], ["2", 2], ["120", 120], ["500", 500], ["900", 500]]) {
    assert.equal(f.goToLine.navigate(input), true);
    assert.deepEqual(f.calls.at(-1), { row: expected, column: 0 });
  }
  assert.equal(f.editor.selectController.clears, 5);
});

test("Go to Line rejects invalid input and a file still loading", () => {
  const f = fixture(10);
  for (const input of ["", "0", "-1", "abc", "12abc", "1.5"])
    assert.equal(f.goToLine.navigate(input), false);
  f.file.loadingState.status = "loading";
  assert.equal(f.goToLine.validate("2"), "File is still loading.");
  assert.equal(f.calls.length, 0);
});

test("Go to Line reads the active tab and line count at validation time", () => {
  const f = fixture(3);
  f.goToLine.open();
  f.editor.tabManager.activeFile = {
    lines: Array.from({ length: 8 }, () => ({})), loadingState: { status: "loaded" },
  };
  assert.equal(f.goToLine.navigate("20"), true);
  assert.deepEqual(f.calls[0], { row: 8, column: 0 });
});

test("Go to Line centers a target outside the viewport without scrolling visible rows", () => {
  const f = fixture(500);
  f.editor.cursorController.isRowVisible = (row) => row < 20;
  assert.equal(f.goToLine.navigate("120"), true);
  assert.deepEqual(f.scrollCalls, [109]);
  assert.equal(f.goToLine.navigate("10"), true);
  assert.deepEqual(f.scrollCalls, [109]);
});

test("Go to Line keeps one panel instance and is centrally registered", () => {
  const f = fixture(2);
  f.goToLine.open();
  f.goToLine.open();
  assert.equal(f.panelCalls.length, 1);
  assert.equal(f.panel.input.focusCalls, 1);
  const config = fs.readFileSync(path.join(__dirname, "../src/ts/manager/SettingsManager.ts"), "utf8");
  const binding = fs.readFileSync(path.join(__dirname, "../src/js/addon/KeyBinding.js"), "utf8");
  assert.match(config, /go_to_line: "Mod\+G"/);
  assert.match(binding, /go_to_line: this\.control_go_to_line/);
});
