const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

test("Find prefills with single-line selection when useSelection is true", () => {
  const { editor } = createEditor("const userName = getUserName();");
  const classes = { add() {}, remove() {} };
  const input = { value: "old", focus() {}, select() {}, blur() {} };

  editor.selectController = { containsSelected: "userName" };
  editor.cursorController.disable = () => {};
  editor.cursorController.isRowVisible = () => true;
  editor.cursorController.columnToX = () => 0;
  editor.cursorController.rowToY = () => 0;
  editor.cursorController.getViewPosition = (row, col) => ({
    row,
    column: col,
  });
  editor.domManager.getElement = (selector) => {
    if (selector === ".editor-search-bar") return { classList: classes };
    if (selector === ".search-bar-input") return input;
    return { classList: classes, textContent: "" };
  };
  editor.searchOutput = null; // Disable DOM updates in test

  const SearchController = loadGlobal(
    "src/js/controller/SearchController.js",
    "SearchController",
    {
      addEvent() {},
      HTMLInputElement: function () {},
    },
  );
  const search = new SearchController(editor);

  search.open({ useSelection: true });
  assert.equal(
    input.value,
    "userName",
    "Should prefill input with single-line selection",
  );
});

test("Find ignores multi-line selection", () => {
  const { editor } = createEditor("code");
  const classes = { add() {}, remove() {} };
  const input = { value: "existing", focus() {}, select() {}, blur() {} };

  editor.selectController = { containsSelected: "line1\nline2" };
  editor.cursorController.disable = () => {};
  editor.domManager.getElement = (selector) => {
    if (selector === ".editor-search-bar") return { classList: classes };
    if (selector === ".search-bar-input") return input;
    return { classList: classes, textContent: "" };
  };
  editor.searchOutput = { replaceChildren() {} };

  const SearchController = loadGlobal(
    "src/js/controller/SearchController.js",
    "SearchController",
    {
      addEvent() {},
      HTMLInputElement: function () {},
    },
  );
  const search = new SearchController(editor);

  search.open({ useSelection: true });
  assert.equal(input.value, "existing", "Should ignore multi-line selection");
});

test("Find ignores empty or whitespace selection", () => {
  const { editor } = createEditor("text");
  const classes = { add() {}, remove() {} };
  const input = { value: "previous", focus() {}, select() {}, blur() {} };

  editor.selectController = { containsSelected: "   " };
  editor.cursorController.disable = () => {};
  editor.domManager.getElement = (selector) => {
    if (selector === ".editor-search-bar") return { classList: classes };
    if (selector === ".search-bar-input") return input;
    return { classList: classes, textContent: "" };
  };
  editor.searchOutput = { replaceChildren() {} };

  const SearchController = loadGlobal(
    "src/js/controller/SearchController.js",
    "SearchController",
    {
      addEvent() {},
      HTMLInputElement: function () {},
    },
  );
  const search = new SearchController(editor);

  search.open({ useSelection: true });
  assert.equal(
    input.value,
    "previous",
    "Should ignore whitespace-only selection",
  );
});

test("Find without useSelection option keeps existing query", () => {
  const { editor } = createEditor("test");
  const classes = { add() {}, remove() {} };
  const input = { value: "existing", focus() {}, select() {}, blur() {} };

  editor.selectController = { containsSelected: "userName" };
  editor.cursorController.disable = () => {};
  editor.domManager.getElement = (selector) => {
    if (selector === ".editor-search-bar") return { classList: classes };
    if (selector === ".search-bar-input") return input;
    return { classList: classes, textContent: "" };
  };
  editor.searchOutput = { replaceChildren() {} };

  const SearchController = loadGlobal(
    "src/js/controller/SearchController.js",
    "SearchController",
    {
      addEvent() {},
      HTMLInputElement: function () {},
    },
  );
  const search = new SearchController(editor);

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
  const { editor } = createEditor("text");
  const classes = { add() {}, remove() {} };
  const input = { value: "", focus() {}, select() {}, blur() {} };

  editor.tabManager.activeFile = null;
  editor.selectController = { containsSelected: "selection" };
  editor.cursorController.disable = () => {};
  editor.domManager.getElement = (selector) => {
    if (selector === ".editor-search-bar") return { classList: classes };
    if (selector === ".search-bar-input") return input;
    return { classList: classes, textContent: "" };
  };
  editor.searchOutput = { replaceChildren() {} };

  const SearchController = loadGlobal(
    "src/js/controller/SearchController.js",
    "SearchController",
    {
      addEvent() {},
      HTMLInputElement: function () {},
    },
  );
  const search = new SearchController(editor);

  assert.doesNotThrow(
    () => search.open({ useSelection: true }),
    "Should not crash without active file",
  );
});
