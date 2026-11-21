const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.id = "";
    this.htmlFor = "";
    this.textContent = "";
    this.hidden = false;
    this.title = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.style = {};
  }

  get options() {
    return this.children.filter((child) => child.tagName === "OPTION");
  }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener() {}
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() {
    return {
      x: 0, y: 0, width: 0, height: 0,
      left: 0, top: 0, right: 0, bottom: 0,
    };
  }
  focus() {}
}

function loadSettingsView() {
  return loadGlobal("src/js/view/SettingsView.js", "SettingsView", {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    },
    window: { api: {} },
    SETTINGS_GET: (key) => {
      if (key === "appearance.theme") return "dark";
      if (key === "editor.tabWidth") return 2;
      return undefined;
    },
    SETTINGS_SET: async () => true,
  });
}

function createView(SettingsView) {
  const view = Object.create(SettingsView.prototype);
  view.editor = { api: {} };
  return view;
}

function findSetting(SettingsView, key) {
  return SettingsView.getSettings().find((setting) => setting.key === key);
}

function rowTitle(row) {
  return row.children[0].children[0];
}

test("button-based setting titles do not activate their controls", () => {
  const SettingsView = loadSettingsView();
  const view = createView(SettingsView);
  for (const key of ["appearance.theme", "git.path", "git.mainBranch", "editor.tabWidth"]) {
    const title = rowTitle(view.createRow(findSetting(SettingsView, key)));
    assert.equal(title.tagName, "SPAN", key);
    assert.equal(title.htmlFor, "", key);
    assert.equal(
      title.id,
      `setting-${key.replace(/\./g, "-")}-label`,
      key,
    );
  }
});

test("native input titles keep label activation", () => {
  const SettingsView = loadSettingsView();
  const view = createView(SettingsView);
  for (const key of ["files.autoSave", "terminal.shell"]) {
    const title = rowTitle(view.createRow(findSetting(SettingsView, key)));
    assert.equal(title.tagName, "LABEL", key);
    assert.equal(title.htmlFor, `setting-${key.replace(/\./g, "-")}`, key);
  }
});

test("button controls stay named by their title", () => {
  const SettingsView = loadSettingsView();
  const view = createView(SettingsView);

  const themeRow = view.createRow(findSetting(SettingsView, "appearance.theme"));
  const themeTitle = rowTitle(themeRow);
  const themeTrigger = themeRow.children[1].children[0].children[1];
  assert.equal(themeTitle.tagName, "SPAN");
  assert.equal(themeTrigger.getAttribute("aria-labelledby"), themeTitle.id);

  const tabRow = view.createRow(findSetting(SettingsView, "editor.tabWidth"));
  const tabTitle = rowTitle(tabRow);
  const tabButton = tabRow.children[1].children[0].children[0];
  assert.equal(tabTitle.tagName, "SPAN");
  assert.equal(tabButton.getAttribute("aria-labelledby"), tabTitle.id);

  const recentRow = view.createRow(findSetting(SettingsView, "files.openRecentIn"));
  const recentTitle = rowTitle(recentRow);
  const recentTrigger = recentRow.children[1].children[0].children[1];
  assert.equal(recentTitle.tagName, "SPAN");
  assert.equal(recentTrigger.getAttribute("aria-labelledby"), recentTitle.id);
});
