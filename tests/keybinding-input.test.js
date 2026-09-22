const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGlobal } = require("./helpers/runtime");

class Element {
  closest() { return null; }
}
class HTMLElement extends Element {
  constructor() {
    super();
    this.isContentEditable = false;
  }
}
class HTMLInputElement extends HTMLElement {}
class HTMLTextAreaElement extends HTMLElement {
  constructor() {
    super();
    this.value = "hello";
    this.selectionStart = 5;
    this.selectionEnd = 5;
  }
  closest() { return this; }
  setRangeText(text, start, end) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
  dispatchEvent() {}
}
class HTMLSelectElement extends HTMLElement {}

function fixture(binding, options = {}) {
  const calls = [];
  const KeyBindingManager = loadGlobal(
    "src/js/manager/KeyBindingManager.js",
    "KeyBindingManager",
    {
      Element,
      HTMLElement,
      HTMLInputElement,
      HTMLTextAreaElement,
      HTMLSelectElement,
      addEvent() {},
      document: {
        hasFocus: () => true,
        querySelector: () => null,
        execCommand: () => options.execCommandResult !== false,
      },
      navigator: { clipboard: { readText: async () => {
        if (options.clipboardFailure) throw new Error("denied");
        return " world";
      } } },
      window: { api: { readClipboardText: options.readClipboardText } },
      Event: class {},
      CONFIG_KEYBINDING_EVENT_KEY: () => "p",
      CONFIG_KEYBINDING_CONTAINSKEY: (key) => key === "Meta+p",
      CONFIG_KEYBINDING_GET_KEY: () => binding,
      CONFIG_KEYBINDING_GET_ACTION: (action) => ({ action }),
    },
  );
  const editor = {
    selected: false,
    tabManager: { activeFile: null },
    keyBinding: { exec(item) { calls.push(item.action); } },
  };
  return { manager: new KeyBindingManager(editor), calls };
}

function keyboardEvent(target = new HTMLInputElement()) {
  return {
    target,
    key: "p",
    keyCode: 80,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

test("global shortcuts work from an input when no file is open", () => {
  const { manager, calls } = fixture({ action: "quick_open", in_editor: false });
  const event = keyboardEvent();
  manager.onKey(event);
  assert.deepEqual(calls, ["quick_open"]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});

test("repeated global shortcuts are ignored while editor shortcuts remain repeatable", () => {
  const global = fixture({ action: "toggle_agent", in_editor: false });
  const repeatedGlobal = keyboardEvent();
  repeatedGlobal.repeat = true;
  global.manager.onKey(repeatedGlobal);
  assert.deepEqual(global.calls, []);

  const editor = fixture({ action: "editor_action", in_editor: true });
  const repeatedEditor = keyboardEvent();
  repeatedEditor.repeat = true;
  editor.manager.onKey(repeatedEditor);
  assert.equal(repeatedEditor.defaultPrevented, true);
});

test("named shortcut keys retain modifiers and modifier-only keys stay sane", () => {
  const { manager } = fixture({ action: "unused", in_editor: false });
  assert.equal(manager.getShortcutKey("Enter", { ctrlKey: true }), "Ctrl+Enter");
  assert.equal(manager.getShortcutKey("Tab", { shiftKey: true }), "Shift+Tab");
  assert.equal(manager.getShortcutKey("ArrowLeft", { ctrlKey: true }), "Ctrl+ArrowLeft");
  assert.equal(manager.getShortcutKey("Control", { ctrlKey: true }), "Control");
});

test("failed execCommand is not swallowed and clipboard IPC is the paste fallback", async () => {
  const copy = fixture({ action: "copy", in_editor: true }, { execCommandResult: false });
  const copyEvent = keyboardEvent(new HTMLTextAreaElement());
  copy.manager.onKey(copyEvent);
  assert.equal(copyEvent.defaultPrevented, false);

  const paste = fixture(
    { action: "paste", in_editor: true },
    { clipboardFailure: true, readClipboardText: async () => " fallback" },
  );
  const input = new HTMLTextAreaElement();
  paste.manager.onKey(keyboardEvent(input));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.value, "hello fallback");
});

test("native menu actions execute through KeyBindingManager", () => {
  const executions = [];
  const { manager } = fixture({ action: "quick_open", in_editor: false });
  manager.editor.keyBinding.exec = (item, event) =>
    executions.push([item.action, event.shiftKey]);

  assert.equal(manager.executeAction("save", { shiftKey: true }), true);
  assert.deepEqual(executions, [["save", true]]);
});

test("native input editing shortcuts are handled without reaching the editor", () => {
  const { manager, calls } = fixture({ action: "copy", in_editor: true });
  const event = keyboardEvent(new HTMLTextAreaElement());
  manager.onKey(event);
  assert.deepEqual(calls, []);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});

test("Meta+V pastes into the focused native input through KeyBindingManager", async () => {
  const { manager, calls } = fixture({ action: "paste", in_editor: true });
  const input = new HTMLTextAreaElement();
  const event = keyboardEvent(input);

  manager.onKey(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(input.value, "hello world");
  assert.deepEqual(calls, []);
  assert.equal(event.defaultPrevented, true);
});
