const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const {
  SettingsManager,
  normalizeKeybinding,
} = require("../dist/ts/manager/SettingsManager.js");

const settingsPath = path.join(__dirname, "../src/config/Settings.js");
const applicationPath = path.join(__dirname, "../src/config/Application.js");
const settingsViewPath = path.join(__dirname, "../src/js/view/SettingsView.js");

const settingsCode = fs.readFileSync(settingsPath, "utf-8");
const applicationCode = fs.readFileSync(applicationPath, "utf-8");
const settingsViewCode = fs.readFileSync(settingsViewPath, "utf-8");

function createTestContext(platform = "darwin") {
  const sandbox = {
    window: {
      api: {
        platform,
        setSetting: async (key, value) => true,
      },
    },
    console,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(applicationCode + "\n" + settingsCode, context);

  return context;
}

function createMockElement(tagName = "div") {
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  const children = [];

  const element = {
    tagName: tagName.toUpperCase(),
    style: {},
    dataset: {},
    hidden: false,
    id: "",
    type: "",
    title: "",
    tabIndex: 0,
    value: "",
    checked: false,
    _textContent: "",
    _className: "",
    get className() {
      return this._className;
    },
    set className(val) {
      this._className = String(val);
      classes.clear();
      this._className
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
    get textContent() {
      if (children.length > 0) {
        return children
          .map((c) => (typeof c === "string" ? c : c.textContent))
          .join("");
      }
      return this._textContent;
    },
    set textContent(val) {
      children.length = 0;
      this._textContent = String(val);
    },
    set innerHTML(val) {
      children.length = 0;
      if (val.includes("settings-search")) {
        const searchWrap = createMockElement("div");
        const searchInput = createMockElement("input");
        searchInput.classList.add("settings-search");
        searchWrap.append(searchInput);
        const layout = createMockElement("div");
        layout.classList.add("settings-layout");
        const nav = createMockElement("nav");
        nav.classList.add("settings-nav");
        const content = createMockElement("main");
        content.classList.add("settings-content");
        layout.append(nav, content);
        this.append(searchWrap, layout);
      } else {
        this._textContent = val;
      }
    },
    classList: {
      add: (...cls) => cls.forEach((c) => classes.add(c)),
      remove: (...cls) => cls.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
    },
    setAttribute: (name, val) => {
      attributes[name] = String(val);
    },
    getAttribute: (name) => attributes[name] || null,
    hasAttribute: (name) => name in attributes,
    addEventListener: (type, handler) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    removeEventListener: (type, handler) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((h) => h !== handler);
      }
    },
    dispatchEvent: (event) => {
      if (!event.target) event.target = element;
      const handlers = (listeners[event.type] || []).slice();
      for (const h of handlers) h(event);
      return !event.defaultPrevented;
    },
    click: () => {
      element.dispatchEvent({
        type: "click",
        target: element,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
      });
    },
    append: (...nodes) => {
      for (const node of nodes) {
        if (typeof node === "string") {
          children.push({ textContent: node });
        } else {
          children.push(node);
          node.parentNode = element;
        }
      }
    },
    appendChild: (node) => {
      children.push(node);
      node.parentNode = element;
      return node;
    },
    replaceChildren: (...nodes) => {
      children.length = 0;
      element._textContent = "";
      element.append(...nodes);
    },
    remove: () => {
      if (element.parentNode) {
        const idx = element.parentNode.children.indexOf(element);
        if (idx !== -1) element.parentNode.children.splice(idx, 1);
        element.parentNode = null;
      }
    },
    contains: (node) => {
      if (node === element) return true;
      for (const child of children) {
        if (child.contains && child.contains(node)) return true;
      }
      return false;
    },
    querySelector: (selector) => {
      for (const child of children) {
        if (matches(child, selector)) return child;
        if (child.querySelector) {
          const found = child.querySelector(selector);
          if (found) return found;
        }
      }
      return null;
    },
    querySelectorAll: (selector) => {
      const results = [];
      for (const child of children) {
        if (matches(child, selector)) results.push(child);
        if (child.querySelectorAll) {
          results.push(...child.querySelectorAll(selector));
        }
      }
      return results;
    },
    get children() {
      return children;
    },
  };

  function matches(el, selector) {
    if (!el || typeof el !== "object") return false;
    if (selector.startsWith("."))
      return el.classList?.contains(selector.slice(1));
    if (selector.startsWith("#")) return el.id === selector.slice(1);
    return el.tagName === selector.toUpperCase();
  }

  return element;
}

describe("Keyboard Shortcut Conflict Detection", () => {
  test("1. Valid unique assignment succeeds", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({
      keybindings: { save: "Mod+S", quick_open: "Mod+P" },
    });
    const result = await ctx.SETTINGS_SET("keybindings.new_file", "Mod+N");

    assert.equal(result.success, true);
  });

  test("2. Duplicate conflict is refused", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({
      keybindings: { save: "Mod+S", quick_open: "Mod+P" },
    });
    const result = await ctx.SETTINGS_SET("keybindings.new_file", "Mod+P");

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.equal(result.error.conflictAction, "quick_open");
  });

  test("3. Old shortcut is preserved after conflict", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({
      keybindings: { save: "Mod+S", quick_open: "Mod+P" },
    });
    await ctx.SETTINGS_SET("keybindings.save", "Mod+P"); // conflict

    assert.equal(ctx.SETTINGS_GET("keybindings.save"), "Mod+S");
    assert.equal(ctx.SETTINGS_GET("keybindings.quick_open"), "Mod+P");
  });

  test("4. Same action reassignment succeeds (no-op)", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({ keybindings: { save: "Mod+S" } });
    const result = await ctx.SETTINGS_SET("keybindings.save", "Mod+Alt+S");

    assert.equal(result.success, true);
    assert.equal(ctx.SETTINGS_GET("keybindings.save"), "Mod+Alt+S");
  });

  test("5. Conflict with different modifier order", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({ keybindings: { save: "Mod+Shift+S" } });
    const result = await ctx.SETTINGS_SET(
      "keybindings.quick_open",
      "Shift+Mod+S",
    );

    assert.equal(result.success, false);
    assert.equal(result.error.conflictAction, "save");
  });

  test("6. Conflict with different casing", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({ keybindings: { save: "Mod+s" } });
    const result = await ctx.SETTINGS_SET("keybindings.quick_open", "mod+S");

    assert.equal(result.success, false);
    assert.equal(result.error.conflictAction, "save");
  });

  test("7. Delete shortcut (null) is always valid", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({ keybindings: { save: "Mod+S" } });
    const result = await ctx.SETTINGS_SET("keybindings.save", null);

    assert.equal(result.success, true);
    assert.equal(ctx.SETTINGS_GET("keybindings.save"), null);
  });

  test("8. Reset default without conflict succeeds", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({ keybindings: { save: "Mod+Alt+S" } });
    // Reset to default 'Mod+S'
    const result = await ctx.SETTINGS_SET("keybindings.save", "Mod+S");

    assert.equal(result.success, true);
    assert.equal(ctx.SETTINGS_GET("keybindings.save"), "Mod+S");
  });

  test("9. Reset default WITH conflict is refused", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({
      keybindings: { save: "Mod+Alt+S", quick_open: "Mod+S" },
    });
    // Try to reset save to its default (Mod+S) — should conflict with quick_open
    const result = await ctx.SETTINGS_SET("keybindings.save", "Mod+S");

    assert.equal(result.success, false);
    assert.equal(result.error.conflictAction, "quick_open");
    assert.equal(ctx.SETTINGS_GET("keybindings.save"), "Mod+Alt+S");
  });

  test("10. Conflict is not persisted in SettingsManager or settings.json", async () => {
    const rootDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "nce-conflict-"),
    );
    try {
      const manager = new SettingsManager(rootDir);
      await manager.initialize();

      assert.equal(manager.get("keybindings.quick_open"), "Mod+P");
      assert.equal(manager.get("keybindings.go_to_line"), "Mod+G");

      // Try assigning go_to_line to Mod+P (conflict)
      const success = await manager.set("keybindings.go_to_line", "Mod+P");
      assert.equal(success, false, "Conflicting assignment must return false");

      // In-memory state unchanged
      assert.equal(manager.get("keybindings.go_to_line"), "Mod+G");
      assert.equal(manager.get("keybindings.quick_open"), "Mod+P");

      // Disk file unchanged
      const disk = JSON.parse(
        await fs.promises.readFile(path.join(rootDir, "settings.json"), "utf8"),
      );
      assert.equal(disk.keybindings.go_to_line, "Mod+G");
      assert.equal(disk.keybindings.quick_open, "Mod+P");
    } finally {
      await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
  });

  test("11. Valid state preserved after SettingsManager restart", async () => {
    const rootDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "nce-conflict-"),
    );
    try {
      const first = new SettingsManager(rootDir);
      await first.initialize();

      assert.equal(
        await first.set("keybindings.new_file", "Mod+Shift+N"),
        true,
      );
      assert.equal(await first.set("keybindings.go_to_line", "Mod+P"), false);

      const restarted = new SettingsManager(rootDir);
      await restarted.initialize();

      assert.equal(restarted.get("keybindings.new_file"), "Mod+Shift+N");
      assert.equal(restarted.get("keybindings.go_to_line"), "Mod+G");
      assert.equal(restarted.get("keybindings.quick_open"), "Mod+P");
    } finally {
      await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
  });

  test("12. One action per normalized shortcut invariant", async () => {
    const ctx = createTestContext();

    ctx.SETTINGS_INITIALIZE({
      keybindings: {
        save: "Mod+S",
        quick_open: "Mod+P",
        new_file: "Mod+N",
        find: "Mod+F",
      },
    });

    // Try to reassign existing actions to conflicting shortcuts
    const r1 = await ctx.SETTINGS_SET("keybindings.find", "Mod+S");
    const r2 = await ctx.SETTINGS_SET("keybindings.new_file", "mod+p");
    const r3 = await ctx.SETTINGS_SET("keybindings.save", "MOD+N");

    // All conflicts should be refused
    assert.equal(
      r1?.success,
      false,
      "find conflict with save should be refused",
    );
    assert.equal(
      r2?.success,
      false,
      "new_file conflict with quick_open should be refused",
    );
    assert.equal(
      r3?.success,
      false,
      "save conflict with new_file should be refused",
    );

    // Verify original shortcuts are preserved - this is the invariant test
    assert.equal(ctx.SETTINGS_GET("keybindings.find"), "Mod+F");
    assert.equal(ctx.SETTINGS_GET("keybindings.new_file"), "Mod+N");
    assert.equal(ctx.SETTINGS_GET("keybindings.save"), "Mod+S");
    assert.equal(ctx.SETTINGS_GET("keybindings.quick_open"), "Mod+P");

    // Verify no duplicates exist by checking each pair
    const actions = ["save", "quick_open", "new_file", "find"];
    for (let i = 0; i < actions.length; i++) {
      for (let j = i + 1; j < actions.length; j++) {
        const shortcut1 = ctx.SETTINGS_GET(`keybindings.${actions[i]}`);
        const shortcut2 = ctx.SETTINGS_GET(`keybindings.${actions[j]}`);
        if (shortcut1 && shortcut2) {
          const norm1 = ctx.CONFIG_KEYBINDING_NORMALIZE(shortcut1);
          const norm2 = ctx.CONFIG_KEYBINDING_NORMALIZE(shortcut2);
          if (norm1 === norm2) {
            assert.fail(
              `Duplicate normalized shortcut "${norm1}" found for ${actions[i]} and ${actions[j]}`,
            );
          }
        }
      }
    }
  });

  test("13. Corrupted settings.json on disk with duplicates is sanitized on initialize", async () => {
    const rootDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "nce-conflict-"),
    );
    try {
      await fs.promises.writeFile(
        path.join(rootDir, "settings.json"),
        JSON.stringify({
          editor: { tabWidth: 2 },
          files: { autoSave: false },
          keybindings: {
            save: "Mod+S",
            go_to_line: "Mod+P", // duplicates quick_open Mod+P!
            quick_open: "Mod+P",
          },
        }),
      );

      const manager = new SettingsManager(rootDir);
      await manager.initialize();

      const k1 = manager.get("keybindings.go_to_line");
      const k2 = manager.get("keybindings.quick_open");
      const norm1 = normalizeKeybinding(k1);
      const norm2 = normalizeKeybinding(k2);

      assert.notEqual(
        norm1,
        norm2,
        "Sanitized shortcuts must have distinct normalized forms",
      );
    } finally {
      await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
  });

  test("14. Normalization handles spaces, aliases, and platform modifier mapping", () => {
    // darwin (Meta)
    assert.equal(
      normalizeKeybinding(" Mod + Shift + p ", "darwin"),
      "meta+shift+p",
    );
    assert.equal(
      normalizeKeybinding("Shift + mod + P", "darwin"),
      "meta+shift+p",
    );
    assert.equal(
      normalizeKeybinding("Command + Shift + P", "darwin"),
      "meta+shift+p",
    );
    assert.equal(
      normalizeKeybinding("cmd + shift + p", "darwin"),
      "meta+shift+p",
    );

    // linux / win32 (Ctrl)
    assert.equal(
      normalizeKeybinding("Mod + Shift + P", "linux"),
      "ctrl+shift+p",
    );
    assert.equal(
      normalizeKeybinding("Shift + Ctrl + P", "linux"),
      "ctrl+shift+p",
    );
    assert.equal(
      normalizeKeybinding("Control + Shift + P", "win32"),
      "ctrl+shift+p",
    );

    // Empty / null / whitespace
    assert.equal(normalizeKeybinding(null), "");
    assert.equal(normalizeKeybinding(undefined), "");
    assert.equal(normalizeKeybinding(""), "");
    assert.equal(normalizeKeybinding("   "), "");
  });

  test("15. SettingsView UI rejects conflicting input, displays formatted error, and preserves old shortcut", async () => {
    const docListeners = {};
    const mockDoc = {
      createElement: (tag) => createMockElement(tag),
      addEventListener: (type, handler) => {
        docListeners[type] = docListeners[type] || [];
        docListeners[type].push(handler);
      },
      removeEventListener: (type, handler) => {
        if (docListeners[type]) {
          docListeners[type] = docListeners[type].filter((h) => h !== handler);
        }
      },
      dispatchEvent: (event) => {
        const handlers = (docListeners[event.type] || []).slice();
        for (const h of handlers) h(event);
      },
    };

    const host = createMockElement("div");
    host.classList.add("settings-view-host");

    const context = {
      document: mockDoc,
      window: {
        api: {
          platform: "darwin",
          setSetting: async () => true,
        },
      },
      console,
      setTimeout: (fn) => setTimeout(fn, 0),
      clearTimeout,
      Object,
      String,
      Number,
      Boolean,
      Set,
    };

    vm.createContext(context);
    vm.runInContext(
      applicationCode +
        "\n" +
        settingsCode +
        "\n" +
        settingsViewCode +
        "\nthis.SettingsView = SettingsView;",
      context,
    );

    context.SETTINGS_INITIALIZE({
      keybindings: {
        quick_open: "Mod+P",
        go_to_line: "Mod+G",
      },
    });

    const mockEditor = {
      domManager: {
        getElement: (sel) => (sel === ".settings-view-host" ? host : null),
      },
      bottomBar: { refreshScrollers: () => {} },
      setAutoSaveState: () => {},
      getAutoSaveState: () => false,
    };

    const view = new context.SettingsView(mockEditor);
    view.category = "Shortcuts";
    view.render();

    // Find Go to Line button
    const goToLineBtn = host.querySelector("#setting-keybindings-go_to_line");
    assert.ok(goToLineBtn, "Go to Line button should exist");
    assert.equal(goToLineBtn.textContent, "⌘ G");

    // Click Go to Line to start listening
    goToLineBtn.click();
    assert.equal(goToLineBtn.classList.contains("listening"), true);

    // Send Mod+P keydown (conflict with Quick Open)
    const keyEvent = {
      type: "keydown",
      key: "P",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    };

    mockDoc.dispatchEvent(keyEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Button should still display old shortcut
    assert.equal(goToLineBtn.textContent, "⌘ G");

    // Error message element should be visible with platform-formatted shortcut
    const errorEl = host.querySelector(".setting-shortcut-error");
    assert.ok(errorEl, "Error element should appear");
    assert.equal(errorEl.textContent, "⌘ P is already assigned to Quick Open.");

    // State in SETTINGS_GET is preserved
    assert.equal(context.SETTINGS_GET("keybindings.go_to_line"), "Mod+G");
    assert.equal(context.SETTINGS_GET("keybindings.quick_open"), "Mod+P");

    // Test Delete button clears shortcut and removes error
    const row = goToLineBtn.parentNode.parentNode; // .setting-shortcut-wrap -> .setting-shortcut-container
    const deleteBtn = row.querySelector(".setting-shortcut-delete");
    assert.ok(deleteBtn, "Delete button should exist");
    deleteBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(goToLineBtn.textContent, "Not set");
    assert.equal(host.querySelector(".setting-shortcut-error"), null);
    assert.equal(context.SETTINGS_GET("keybindings.go_to_line"), null);
  });
});
