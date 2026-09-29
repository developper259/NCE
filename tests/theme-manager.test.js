const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function setup(preference = "system", matches = true, saveResult = true) {
  const classes = new Set();
  const listeners = new Set();
  const mediaQuery = {
    matches,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    emit(next) {
      this.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
  const root = { dataset: {} };
  const editor = {
    editorOBJ: {
      classList: {
        add(...values) { values.forEach((value) => classes.add(value)); },
        remove(...values) { values.forEach((value) => classes.delete(value)); },
      },
    },
  };
  let stored = preference;
  const globals = loadGlobal("src/js/manager/ThemeManager.js", "ThemeManager", {
    SETTINGS_GET: () => stored,
    SETTINGS_SET: async (_key, value) => {
      if (saveResult) stored = value;
      return saveResult;
    },
    document: { documentElement: root },
    window: { matchMedia: () => mediaQuery },
  });
  return { ThemeManager: globals, editor, root, classes, mediaQuery };
}

test("ThemeManager applies dark and light syntax themes", async () => {
  for (const theme of ["dark", "light"]) {
    const setupState = setup(theme);
    const manager = new setupState.ThemeManager(setupState.editor).init();
    assert.equal(manager.getResolvedTheme(), theme);
    assert.equal(setupState.root.dataset.theme, theme);
    assert.equal(setupState.classes.has(`nsh-theme-${theme}`), true);
    manager.destroy();
  }
});

test("system resolves and follows the OS only in system mode", () => {
  const state = setup("system", true);
  const manager = new state.ThemeManager(state.editor).init();
  assert.equal(manager.getResolvedTheme(), "dark");
  state.mediaQuery.emit(false);
  assert.equal(manager.getResolvedTheme(), "light");
  manager.setTheme("dark");
  state.mediaQuery.emit(true);
  assert.equal(manager.getResolvedTheme(), "dark");
});

test("invalid and failed preferences do not change the applied theme", async () => {
  const state = setup("dark");
  const manager = new state.ThemeManager(state.editor).init();
  assert.equal(await manager.setTheme("purple"), false);
  assert.equal(manager.getPreference(), "dark");
  const failed = setup("dark", true, false);
  const failedManager = new failed.ThemeManager(failed.editor).init();
  assert.equal(await failedManager.setTheme("light"), false);
  assert.equal(failedManager.getPreference(), "dark");
  assert.equal(failed.root.dataset.theme, "dark");
  manager.destroy();
  assert.doesNotThrow(() => manager.destroy());
});

test("destroy removes the system listener", () => {
  const state = setup("system", true);
  const manager = new state.ThemeManager(state.editor).init();
  manager.destroy();
  state.mediaQuery.emit(false);
  assert.equal(state.root.dataset.theme, "dark");
});
