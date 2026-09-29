const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

function createClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      if (force === true) { values.add(name); return true; }
      if (force === false) { values.delete(name); return false; }
      if (values.has(name)) { values.delete(name); return false; }
      values.add(name); return true;
    },
    contains(name) { return values.has(name); },
  };
}

function createElementMock() {
  const attributes = new Map();
  return {
    classList: createClassList(),
    textContent: "",
    hidden: false,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    querySelector() { return null; },
  };
}

function createSearchFixture(text, inputValue, selectedText, searchOutput = { replaceChildren() {} }) {
  const { editor } = createEditor(text);
  const input = { ...createElementMock(), value: inputValue, focus() {}, select() {}, blur() {} };
  const expandButton = createElementMock();
  const icon = { classList: createClassList() };
  expandButton.querySelector = (selector) => selector === "i" ? icon : null;
  editor.selectController = { containsSelected: selectedText };
  editor.cursorController.disable = () => {};
  editor.cursorController.isRowVisible = () => true;
  editor.cursorController.columnToX = () => 0;
  editor.cursorController.rowToY = () => 0;
  editor.cursorController.getViewPosition = (row, col) => ({ row, column: col });
  const elements = {
    ".editor-search-bar": createElementMock(),
    ".search-bar-input": input,
    ".search-bar-counter": createElementMock(),
    ".search-bar-previous": createElementMock(),
    ".search-bar-next": createElementMock(),
    ".search-bar-close": createElementMock(),
    ".search-bar-expand": expandButton,
    ".search-bar-replace-input": { ...createElementMock(), value: "", focus() {}, blur() {} },
    ".search-bar-replace-container": createElementMock(),
    ".search-bar-replace-actions": createElementMock(),
    ".search-bar-replace": createElementMock(),
    ".search-bar-replace-next": createElementMock(),
    ".search-bar-replace-all": createElementMock(),
  };
  editor.domManager.getElement = (selector) => elements[selector];
  editor.searchOutput = searchOutput;
  const TAB_TYPES = loadGlobal("src/js/types/Tab.js", "TAB_TYPES");
  const SearchController = loadGlobal("src/js/controller/SearchController.js", "SearchController", {
    addEvent() {}, HTMLInputElement: function () {}, TAB_TYPES,
  });
  const search = new SearchController(editor);
  search.query = input.value;
  return { editor, input, search };
}

test("Find prefills with single-line selection when useSelection is true", () => {
  const { search, input } = createSearchFixture("const userName = getUserName();", "old", "userName", null);

  search.open({ useSelection: true });
  assert.equal(
    input.value,
    "userName",
    "Should prefill input with single-line selection",
  );
});

test("Find ignores multi-line selection", () => {
  const { search, input } = createSearchFixture("code", "existing", "line1\nline2");

  search.open({ useSelection: true });
  assert.equal(input.value, "existing", "Should ignore multi-line selection");
});

test("Find ignores empty or whitespace selection", () => {
  const { search, input } = createSearchFixture("text", "previous", "   ");

  search.open({ useSelection: true });
  assert.equal(
    input.value,
    "previous",
    "Should ignore whitespace-only selection",
  );
});

test("Find without useSelection option keeps existing query", () => {
  const { search, input } = createSearchFixture("test", "existing", "userName");

  search.open({ useSelection: false });
  assert.equal(input.value, "existing", "Should keep existing query");
});

test("control_find passes useSelection: true", () => {
  const toggleCalls = [];
  const { editor } = createEditor("test");

  editor.searchController = {
    toggle(options) {
      toggleCalls.push(options);
    },
  };

  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {});
  const kb = new KeyBinding(editor);
  kb.control_find();

  assert.equal(toggleCalls.length, 1);
  assert.equal(
    toggleCalls[0].useSelection,
    true,
    "Should pass useSelection: true",
  );
});

test("Find without active file does not crash", () => {
  const { editor, search } = createSearchFixture("text", "", "selection");

  editor.tabManager.activeFile = null;

  assert.doesNotThrow(
    () => search.open({ useSelection: true }),
    "Should not crash without active file",
  );
});
