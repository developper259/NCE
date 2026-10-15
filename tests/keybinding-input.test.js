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
        activeElement: options.activeElement || null,
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
    terminalPanel: options.terminalPanel || null,
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
      getModifierState: () => false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  };
}

function terminalTarget() {
  const xterm = { classList: { contains: (name) => name === "xterm" } };
  return {
    closest(selector) {
      if (selector === ".terminal-panel, .bottom-panel-terminal-actions-slot")
        return this;
      if (selector === ".xterm") return xterm;
      return null;
    },
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

test("printable shortcuts stay as text in native inputs and contenteditable controls", () => {
  const cases = [
    { key: " ", shortcut: "Space", shiftKey: false, altKey: false },
    { key: " ", shortcut: "Shift+Space", shiftKey: true, altKey: false },
    { key: " ", shortcut: "Alt+Space", shiftKey: false, altKey: true },
    { key: "a", shortcut: "a", shiftKey: false, altKey: false },
  ];

  for (const target of [new HTMLInputElement(), new HTMLTextAreaElement()]) {
    for (const item of cases) {
      const { manager, calls } = fixture(
        { action: "open_folder", in_editor: false },
        {},
        item.shortcut,
      );
      const event = keyboardEvent(target, {
        key: item.key,
        metaKey: false,
        ctrlKey: false,
        shiftKey: item.shiftKey,
        altKey: item.altKey,
      });

      manager.onKey(event);

      assert.deepEqual(calls, [], `${item.shortcut} remains text in a native input`);
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.propagationStopped, false);
    }
  }

  const editable = new HTMLElement();
  editable.isContentEditable = true;
  const { manager, calls } = fixture(
    { action: "open_folder", in_editor: false },
    {},
    "Space",
  );
  const event = keyboardEvent(editable, {
    key: " ",
    metaKey: false,
    ctrlKey: false,
  });
  manager.onKey(event);
  assert.deepEqual(calls, []);
  assert.equal(event.defaultPrevented, false);
});

test("native controls preserve navigation keys while allowing configured function keys", () => {
  for (const [key, shortcut, shiftKey] of [
    ["ArrowUp", "Shift+ArrowUp", true],
    ["ArrowLeft", "ArrowLeft", false],
    ["Backspace", "Backspace", false],
    ["Delete", "Delete", false],
    ["Enter", "Enter", false],
    ["Tab", "Tab", false],
  ]) {
    const { manager, calls } = fixture(
      { action: "open_folder", in_editor: false },
      {},
      shortcut,
    );
    const event = keyboardEvent(new HTMLInputElement(), {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey,
    });

    manager.onKey(event);

    assert.deepEqual(calls, [], `${shortcut} stays native in a text control`);
    assert.equal(event.defaultPrevented, false);
  }

  const functionKey = fixture(
    { action: "open_command", in_editor: false },
    {},
    "F5",
  );
  const event = keyboardEvent(new HTMLInputElement(), {
    key: "F5",
    metaKey: false,
    ctrlKey: false,
  });
  functionKey.manager.onKey(event);
  assert.deepEqual(functionKey.calls, ["open_command"]);
  assert.equal(event.defaultPrevented, true);
});

test("IME composition and AltGraph text are never dispatched as shortcuts", () => {
  const composing = fixture({ action: "open_folder", in_editor: false }, {}, "Meta+p");
  const composingEvent = keyboardEvent(new HTMLInputElement(), {
    key: "p",
    isComposing: true,
  });
  composing.manager.onKey(composingEvent);
  assert.deepEqual(composing.calls, []);
  assert.equal(composingEvent.defaultPrevented, false);

  const altGraph = fixture(
    { action: "open_folder", in_editor: false },
    {},
    "Ctrl+Alt+q",
  );
  const altGraphEvent = keyboardEvent(new HTMLInputElement(), {
    key: "q",
    metaKey: false,
    ctrlKey: true,
    altKey: true,
    getModifierState: (modifier) => modifier === "AltGraph",
  });
  altGraph.manager.onKey(altGraphEvent);
  assert.deepEqual(altGraph.calls, []);
  assert.equal(altGraphEvent.defaultPrevented, false);
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

test("terminal edit shortcuts dispatch to xterm and ordinary keys stay terminal input", () => {
  for (const [action, key] of [
    ["copy", "c"],
    ["cut", "x"],
    ["paste", "v"],
    ["select_all", "a"],
  ]) {
    const terminalActions = [];
    const activeElement = terminalTarget();
    const { manager, calls } = fixture(
      { action, in_editor: true },
      {
        activeElement,
        terminalPanel: {
          handleKeybinding(terminalAction) {
            terminalActions.push(terminalAction);
            return true;
          },
        },
      },
      `Ctrl+${key}`,
    );
    const event = keyboardEvent({ closest: (selector) => selector === ".xterm"
      ? { classList: { contains: (name) => name === "xterm" } }
      : null }, {
      key,
      ctrlKey: true,
      metaKey: false,
    });
    manager.onKey(event);
    assert.deepEqual(terminalActions, [action]);
    assert.deepEqual(calls, [], `${action} must not run against the editor`);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }

  const terminalActions = [];
  const { manager } = fixture(
    { action: "copy", in_editor: true },
    { terminalPanel: { handleKeybinding(action) { terminalActions.push(action); return false; } } },
    "Ctrl+c",
  );
  const interrupt = keyboardEvent(terminalTarget(), {
    key: "c",
    ctrlKey: true,
    metaKey: false,
  });
  manager.onKey(interrupt);
  assert.deepEqual(terminalActions, ["copy"]);
  assert.equal(interrupt.defaultPrevented, false, "Ctrl+C without a selection remains a shell interrupt");
});

test("Shift+Arrow selects terminal output while unmodified arrows remain shell input", () => {
  const calls = [];
  const terminalPanel = {
    handleShiftArrow(key) { calls.push(["select", key]); return true; },
    resetKeyboardSelection() { calls.push(["reset"]); },
  };
  const { manager } = fixture(
    { action: "move_left", in_editor: false },
    { terminalPanel },
  );
  const shifted = keyboardEvent(terminalTarget(), {
    key: "ArrowLeft",
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
  });

  manager.onKey(shifted);

  assert.deepEqual(calls, [["select", "ArrowLeft"]]);
  assert.equal(shifted.defaultPrevented, true);
  assert.equal(shifted.propagationStopped, true);

  const ordinary = keyboardEvent(terminalTarget(), {
    key: "ArrowLeft",
    metaKey: false,
    ctrlKey: false,
  });
  manager.onKey(ordinary);

  assert.deepEqual(calls, [["select", "ArrowLeft"], ["reset"]]);
  assert.equal(ordinary.defaultPrevented, false);
  assert.equal(ordinary.propagationStopped, false);
});

test("native menu edit actions stay scoped to a focused terminal", () => {
  const terminalActions = [];
  const { manager, calls } = fixture(
    { action: "undo", in_editor: true },
    {
      activeElement: terminalTarget(),
      terminalPanel: {
        handleKeybinding(action) { terminalActions.push(action); return false; },
      },
    },
  );

  assert.equal(manager.executeAction("undo"), true);
  assert.deepEqual(terminalActions, ["undo"]);
  assert.deepEqual(calls, [], "Undo must not alter the file behind the terminal");
});

test("Space, Shift+Space and repeated spaces stay with terminal input", () => {
  for (const [key, shiftKey, shortcut] of [
    [" ", false, "Space"],
    [" ", true, "Shift+Space"],
  ]) {
    const { manager, calls } = fixture(
      { action: "open_folder", in_editor: false },
      {},
      shortcut,
    );
    for (let repeat = 0; repeat < 3; repeat++) {
      const event = keyboardEvent(terminalTarget(), {
        key,
        shiftKey,
        metaKey: false,
        repeat: repeat > 0,
      });
      manager.onKey(event);
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.propagationStopped, false);
    }
    assert.deepEqual(calls, [], `${shortcut} must not open a folder in xterm`);
  }
});

test("terminal printable characters and shell navigation keys reach xterm", () => {
  for (const key of ["e", "Backspace", "Enter", "Tab", "ArrowLeft", "ArrowUp"]) {
    const { manager, calls } = fixture(
      { action: "open_folder", in_editor: false },
      {},
      "Ctrl+Shift+O",
    );
    const event = keyboardEvent(terminalTarget(), {
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    manager.onKey(event);
    assert.deepEqual(calls, [], `${key} must remain terminal input`);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
  }
});

test("terminal session shortcuts still run when explicitly modified", () => {
  const tabActions = [];
  const { manager, calls } = fixture(
    { action: "next_tab", in_editor: false },
    { terminalPanel: { handleTabKeybinding(action) { tabActions.push(action); } } },
    "Ctrl+Tab",
  );
  const event = keyboardEvent(terminalTarget(), {
    key: "Tab",
    ctrlKey: true,
    metaKey: false,
  });

  manager.onKey(event);

  assert.deepEqual(tabActions, ["next_tab"]);
  assert.deepEqual(calls, []);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});

test("configured function-key shortcuts work from the terminal without modifiers", () => {
  const { manager, calls } = fixture(
    { action: "open_command", in_editor: false },
    {},
    "F5",
  );
  const event = keyboardEvent(terminalTarget(), {
    key: "F5",
    metaKey: false,
    ctrlKey: false,
  });

  manager.onKey(event);

  assert.deepEqual(calls, ["open_command"]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
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

test("terminal focus routes tab management shortcuts to terminal sessions", () => {
  for (const shortcut of [
    { action: "new_file", key: "n", shiftKey: false },
    { action: "close_file", key: "w", shiftKey: false },
    { action: "close_all_file", key: "w", shiftKey: true },
    { action: "next_tab", key: "Tab", shiftKey: false },
    { action: "previous_tab", key: "Tab", shiftKey: true },
  ]) {
    const terminalCalls = [];
    const { manager, calls } = fixture(
      { action: shortcut.action, in_editor: false },
      { terminalPanel: {
        handleTabKeybinding(action) { terminalCalls.push(action); return true; },
      } },
      `Ctrl+${shortcut.shiftKey ? "Shift+" : ""}${shortcut.key}`,
    );
    const target = {
      closest(selector) {
        return selector.includes(".terminal-panel") ? {} : null;
      },
    };
    const event = keyboardEvent(target, {
      key: shortcut.key,
      keyCode: shortcut.key === "Tab" ? 9 : undefined,
      ctrlKey: true,
      metaKey: false,
      shiftKey: shortcut.shiftKey,
    });

    manager.onKey(event);

    assert.deepEqual(terminalCalls, [shortcut.action]);
    assert.deepEqual(calls, [], "terminal tab commands must not reach the editor tab manager");
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }
});
