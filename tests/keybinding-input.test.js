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

function fixture(binding, options = {}, mappedShortcut = "Meta+p") {
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
      CONFIG_KEYBINDING_EVENT_KEY: (event) => event.key,
      CONFIG_KEYBINDING_CONTAINSKEY: (key) => key === mappedShortcut,
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

function keyboardEvent(target = new HTMLInputElement(), overrides = {}) {
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
    ...overrides,
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

test("Save As shortcut dispatches from native inputs with each platform modifier", () => {
  for (const shortcut of [
    { key: "Meta+Shift+S", modifiers: { metaKey: true, shiftKey: true } },
    {
      key: "Ctrl+Shift+S",
      modifiers: { metaKey: false, ctrlKey: true, shiftKey: true },
    },
  ]) {
    const { manager, calls } = fixture(
      { action: "save_as", in_editor: false },
      {},
      shortcut.key,
    );
    const event = keyboardEvent(new HTMLInputElement(), {
      key: "S",
      ...shortcut.modifiers,
    });

    manager.onKey(event);

    assert.deepEqual(calls, ["save_as"]);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }
});

test("Ctrl+Tab shortcuts dispatch next and previous tab actions from native inputs", () => {
  for (const shortcut of [
    { key: "Ctrl+Tab", action: "next_tab", shiftKey: false },
    { key: "Ctrl+Shift+Tab", action: "previous_tab", shiftKey: true },
  ]) {
    const { manager, calls } = fixture(
      { action: shortcut.action, in_editor: false },
      {},
      shortcut.key,
    );
    const event = keyboardEvent(new HTMLInputElement(), {
      key: "Tab",
      keyCode: 9,
      ctrlKey: true,
      metaKey: false,
      shiftKey: shortcut.shiftKey,
    });

    manager.onKey(event);

    assert.deepEqual(calls, [shortcut.action]);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }
});

test("repeated global shortcuts are ignored while editor shortcuts remain repeatable", () => {
  const global = fixture({ action: "toggle_agent", in_editor: false });
  const repeatedGlobal = keyboardEvent();
  repeatedGlobal.repeat = true;
  global.manager.onKey(repeatedGlobal);
  assert.deepEqual(global.calls, []);

  const editor = fixture({ action: "editor_action", in_editor: true });
  editor.manager.editor.selected = true;
  const repeatedEditor = keyboardEvent(new HTMLElement());
  repeatedEditor.repeat = true;
  editor.manager.onKey(repeatedEditor);
  assert.equal(repeatedEditor.defaultPrevented, true);
  assert.deepEqual(editor.calls, ["editor_action"]);
});

test("repeated tab navigation shortcuts remain repeatable", () => {
  const navigation = fixture({ action: "next_tab", in_editor: false });
  const repeatedNavigation = keyboardEvent();
  repeatedNavigation.repeat = true;
  navigation.manager.onKey(repeatedNavigation);

  assert.equal(repeatedNavigation.defaultPrevented, true);
  assert.deepEqual(navigation.calls, ["next_tab"]);
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

test("terminal focus leaves Ctrl+C, Ctrl+V and ordinary keys to xterm", () => {
  for (const [action, key] of [["copy", "c"], ["paste", "v"], ["editor_action", "ArrowUp"]]) {
    const { manager, calls } = fixture({ action, in_editor: true }, {}, `Ctrl+${key}`);
    const event = keyboardEvent({ closest: (selector) => selector === ".xterm"
      ? { classList: { contains: (name) => name === "xterm" } }
      : null }, {
      key,
      ctrlKey: true,
      metaKey: false,
    });
    manager.onKey(event);
    assert.deepEqual(calls, [], `${action} must stay in xterm`);
    assert.equal(event.defaultPrevented, false);
  }
});

test("terminal focus still dispatches configured global commands and Toggle Terminal", () => {
  for (const [action, key] of [["toggle_terminal", "j"], ["open_command", "p"]]) {
    const { manager, calls } = fixture({ action, in_editor: false }, {}, `Ctrl+${key}`);
    const event = keyboardEvent({ closest: (selector) => selector === ".xterm"
      ? { classList: { contains: (name) => name === "xterm" } }
      : null }, {
      key,
      ctrlKey: true,
      metaKey: false,
    });
    manager.onKey(event);
    assert.deepEqual(calls, [action]);
    assert.equal(event.defaultPrevented, true);
  }
});
