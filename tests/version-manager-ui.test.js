const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.document = document;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.isConnected = true;
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      toggle: (name, force) => {
        const want = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (want) this._classes.add(name);
        else this._classes.delete(name);
        return want;
      },
      contains: (name) => this._classes.has(name),
    };
  }

  get className() { return [...this._classes].join(" "); }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  append(...children) {
    for (const child of flattenChildren(children)) {
      child.parent = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  focus() { this.document.activeElement = this; }

  remove() {
    this.isConnected = false;
    if (this.parent)
      this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  dispatch(type, event = {}) {
    let stopped = false;
    const payload = {
      target: this,
      defaultPrevented: false,
      preventDefault() { payload.defaultPrevented = true; },
      stopPropagation() { stopped = true; },
      ...event,
    };
    let node = this;
    while (node && !stopped) {
      for (const listener of [...(node.listeners.get(type) || [])]) listener(payload);
      node = node.parent;
    }
    return payload;
  }

  click() { return this.dispatch("click"); }
}

function flattenChildren(children) {
  const out = [];
  for (const child of children) {
    if (child?.isFragment) out.push(...child.children);
    else out.push(child);
  }
  return out;
}

function createDocument() {
  const document = { activeElement: null, created: 0 };
  document.createElement = (tagName) => {
    document.created += 1;
    return new FakeElement(tagName, document);
  };
  document.createDocumentFragment = () => {
    const fragment = new FakeElement("#fragment", document);
    fragment.isFragment = true;
    return fragment;
  };
  document.body = new FakeElement("body", document);
  return document;
}

function createTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeout(fn, delay = 0) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    tick(delay) {
      for (const [id, timer] of [...pending]) {
        if (timer.delay <= delay) {
          pending.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function descendants(node) {
  return [node, ...(node.children || []).flatMap(descendants)];
}

function textOf(node) {
  return descendants(node).map((child) => child.textContent || "").filter(Boolean).join(" ");
}

function byFocusKey(rootNode, key) {
  return descendants(rootNode).find((node) => node.dataset?.focusKey === key) || null;
}

function buttonWithLabel(rootNode, label) {
  return descendants(rootNode).find((node) =>
    node.tagName === "button" && textOf(node).includes(label)) || null;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function gitPackage(overrides = {}) {
  return {
    id: "git",
    name: "Git",
    description: "Distributed version control system",
    publisher: "dugite-native",
    homepage: "https://git-scm.com",
    categories: ["git"],
    icon: "fi-rr-code-branch",
    platforms: ["darwin", "linux", "win32"],
    capabilities: ["install", "uninstall", "verify"],
    state: "not-installed",
    supported: true,
    installableVersion: "2.56.1",
    managedSettings: ["git.path"],
    installations: [],
    external: undefined,
    lastError: undefined,
    ...overrides,
  };
}

function gitRecord(overrides = {}) {
  return {
    id: "a1b2c3d4",
    version: "2.56.1",
    state: "installed",
    installDir: "/userData/tools/git/2.56.1",
    executable: "/userData/tools/git/2.56.1/bin/git",
    platform: "darwin",
    arch: "x64",
    installedAt: Date.UTC(2026, 10, 1),
    verifiedAt: Date.UTC(2026, 10, 2),
    source: {
      url: "https://example.com/git.tar.gz",
      checksum: "ab".repeat(32),
      checksumAlgorithm: "sha256",
    },
    ...overrides,
  };
}

function createApiFixture(packages = [gitPackage()]) {
  const state = {
    snapshot: { version: 1, packages, operations: [] },
    getStateCalls: 0,
    installs: [],
    uninstalls: [],
    verifies: [],
    cancels: [],
    listeners: new Set(),
    getStateError: null,
  };
  const api = {
    async getState() {
      state.getStateCalls += 1;
      if (state.getStateError) throw state.getStateError;
      return state.snapshot;
    },
    async install(packageId) { state.installs.push(packageId); return { success: true }; },
    async uninstall(installationId) { state.uninstalls.push(installationId); return { success: true }; },
    async verify(installationId) { state.verifies.push(installationId); return { success: true }; },
    async cancel(packageId) { state.cancels.push(packageId); return true; },
    onEvent(callback) {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
  };
  state.emit = (event) => {
    for (const callback of [...state.listeners]) callback(event);
  };
  return { api, state };
}

function runningOperation(overrides = {}) {
  return {
    id: "op-1",
    packageId: "git",
    kind: "install",
    state: "running",
    startedAt: Date.UTC(2026, 10, 17),
    ...overrides,
  };
}

function setup(packages) {
  const document = createDocument();
  const timers = createTimers();
  const { api, state } = createApiFixture(packages);
  const VersionManager = loadGlobal("src/js/view/VersionManager.js", "VersionManager", {
    document,
    window: {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const manager = new VersionManager({ api: { versionManager: api } });
  return { document, timers, api, state, manager };
}

test("Version Manager stays uncreated until first open, then loads and focuses", async () => {
  const { document, timers, state, manager } = setup();
  assert.equal(document.created, 0);
  assert.equal(state.getStateCalls, 0);
  assert.equal(manager.host, null);

  const outsideButton = document.createElement("button");
  document.body.appendChild(outsideButton);
  outsideButton.focus();

  assert.equal(manager.show(), true);
  assert.ok(document.created > 0);
  assert.equal(state.getStateCalls, 1);
  assert.equal(manager.host.hidden, false);
  assert.match(textOf(manager.main), /Loading inventory…/);
  timers.tick(0);
  assert.equal(manager.host.classList.contains("nce-vm-open"), true);
  assert.equal(document.activeElement, manager.closeButton);

  await flush();
  assert.match(textOf(manager.main), /Managed packages/);
  assert.match(textOf(manager.main), /Functional installations/);
  assert.match(textOf(manager.main), /Needs attention/);
  assert.match(textOf(manager.main), /No operations yet/);

  assert.equal(manager.hide(), true);
  assert.equal(state.listeners.size, 0);
  timers.tick(160);
  assert.equal(manager.host.hidden, true);
  assert.equal(manager.host.getAttribute("aria-hidden"), "true");
  assert.equal(document.activeElement, outsideButton);

  manager.destroy();
  assert.equal(document.body.children.includes(manager.host), false);
  assert.equal(document.body.children.length, 1);
});

test("Escape and outside click close the popup; inside clicks do not", async () => {
  const { document, timers, manager } = setup();
  manager.show();
  await flush();

  manager.dialog.dispatch("click");
  assert.equal(manager.host.hidden, false, "a click inside the dialog must not close it");

  const escape = manager.host.dispatch("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  timers.tick(160);
  assert.equal(manager.host.hidden, true);

  manager.show();
  await flush();
  timers.tick(0);
  manager.host.dispatch("click");
  timers.tick(160);
  assert.equal(manager.host.hidden, true, "a backdrop click closes the popup");
});

test("Tab focus is trapped inside the dialog and wraps in both directions", async () => {
  const { document, manager } = setup();
  manager.show();
  await flush();

  const focusable = manager.focusableElements();
  assert.ok(focusable.length >= 2);
  assert.ok(focusable.every((element) => descendants(manager.dialog).includes(element)));

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  last.focus();
  const forward = manager.host.dispatch("keydown", { key: "Tab" });
  assert.equal(forward.defaultPrevented, true);
  assert.equal(document.activeElement, first);

  const backward = manager.host.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.equal(backward.defaultPrevented, true);
  assert.equal(document.activeElement, last);
});

test("navigation covers every section with honest Updates and empty categories", async () => {
  const { manager } = setup();
  manager.show();
  await flush();

  byFocusKey(manager.dialog, "vm-nav-available").click();
  assert.match(textOf(manager.main), /Packages NCE can really install today/);
  assert.match(textOf(manager.main), /Git/);
  assert.ok(byFocusKey(manager.main, "vm-install-git"), "Git offers a real Install action");

  byFocusKey(manager.dialog, "vm-nav-updates").click();
  assert.match(textOf(manager.main), /Update checking is not available yet/);
  assert.doesNotMatch(textOf(manager.main), /No updates available/);
  assert.doesNotMatch(textOf(manager.main), /up to date/i);

  byFocusKey(manager.dialog, "vm-nav-category:language").click();
  assert.match(textOf(manager.main), /No languages tools yet/);
  assert.doesNotMatch(textOf(manager.main), /Install/);

  byFocusKey(manager.dialog, "vm-nav-category:git").click();
  assert.match(textOf(manager.main), /Git/);
  assert.ok(byFocusKey(manager.main, "vm-install-git"));

  byFocusKey(manager.dialog, "vm-nav-installed").click();
  assert.match(textOf(manager.main), /No managed installations yet/);
  buttonWithLabel(manager.main, "Browse available").click();
  assert.match(textOf(manager.main), /Packages NCE can really install today/);
});

test("Installed lists real installations and search filters them without losing focus", async () => {
  const record = gitRecord();
  const { document, manager } = setup([gitPackage({
    state: "installed",
    installations: [record],
  })]);
  manager.show();
  await flush();
  byFocusKey(manager.dialog, "vm-nav-installed").click();

  const row = byFocusKey(manager.main, `vm-installation-${record.id}`);
  assert.ok(row);
  assert.match(textOf(row), /Git/);
  assert.match(textOf(row), /2\.56\.1/);
  assert.match(textOf(row), /\/userData\/tools\/git\/2\.56\.1/);

  const search = byFocusKey(manager.main, "vm-search");
  search.value = "zzz-no-match";
  search.dispatch("input");
  assert.match(textOf(manager.main), /No installations match “zzz-no-match”/);
  assert.equal(document.activeElement.dataset.focusKey, "vm-search");
  assert.equal(document.activeElement.value, "zzz-no-match");

  document.activeElement.value = "2.56.1";
  document.activeElement.dispatch("input");
  assert.ok(byFocusKey(manager.main, `vm-installation-${record.id}`));

  document.activeElement.value = "git";
  document.activeElement.dispatch("input");
  assert.ok(byFocusKey(manager.main, `vm-installation-${record.id}`), "category names are searchable");
});

test("details show real fields, provenance, verify, and a read-only external panel", async () => {
  const record = gitRecord();
  const { state, manager } = setup([gitPackage({
    state: "installed",
    installations: [record],
    external: { executable: "/usr/bin/git", version: "2.39.5", detectedAt: Date.UTC(2026, 10, 1) },
  })]);
  manager.show();
  await flush();
  byFocusKey(manager.dialog, "vm-nav-installed").click();
  byFocusKey(manager.main, `vm-installation-${record.id}`).click();

  const text = textOf(manager.main);
  assert.match(text, /Managed by NCE/);
  assert.match(text, /\/userData\/tools\/git\/2\.56\.1/);
  assert.match(text, /\/userData\/tools\/git\/2\.56\.1\/bin\/git/);
  assert.match(text, /darwin \/ x64/);
  assert.match(text, /https:\/\/example\.com\/git\.tar\.gz/);
  assert.match(text, /External — not managed by NCE/);
  assert.match(text, /\/usr\/bin\/git/);
  assert.match(text, /never modifies or uninstalls external tools/);

  const uninstallButtons = descendants(manager.main).filter((node) =>
    node.tagName === "button" && textOf(node).includes("Uninstall"));
  assert.equal(uninstallButtons.length, 1, "only the managed installation offers Uninstall");

  byFocusKey(manager.main, `vm-verify-${record.id}`).click();
  await flush();
  assert.deepEqual(state.verifies, [record.id]);

  byFocusKey(manager.main, "vm-back").click();
  assert.match(textOf(manager.main), /Installations owned by NCE/);
});

test("uninstall asks a specific confirmation and only then calls the API", async () => {
  const record = gitRecord();
  const { document, state, manager } = setup([gitPackage({
    state: "installed",
    installations: [record],
  })]);
  manager.show();
  await flush();
  manager.openDetail("git");

  byFocusKey(manager.main, `vm-uninstall-${record.id}`).click();
  const confirmText = textOf(manager.main);
  assert.match(confirmText, /Uninstall Git 2\.56\.1\?/);
  assert.match(confirmText, /This permanently removes \/userData\/tools\/git\/2\.56\.1\./);
  assert.match(confirmText, /Settings pointing at this installation will be cleared\./);
  assert.equal(document.activeElement.dataset.focusKey, `vm-confirm-uninstall-${record.id}`);
  assert.deepEqual(state.uninstalls, []);

  byFocusKey(manager.main, `vm-cancel-uninstall-${record.id}`).click();
  assert.doesNotMatch(textOf(manager.main), /This permanently removes/);
  assert.deepEqual(state.uninstalls, []);

  byFocusKey(manager.main, `vm-uninstall-${record.id}`).click();
  byFocusKey(manager.main, `vm-confirm-uninstall-${record.id}`).click();
  await flush();
  assert.deepEqual(state.uninstalls, [record.id]);

  state.emit({ type: "operation", operation: runningOperation({ kind: "uninstall" }) });
  await flush();
  assert.match(textOf(manager.main), /Uninstalling…/);
  assert.equal(manager.footerCancel.hidden, true, "uninstall cannot be cancelled mid-flight");
  assert.equal(buttonWithLabel(manager.main, "Verify"), null);

  state.snapshot.packages[0].installations = [];
  state.snapshot.packages[0].state = "not-installed";
  state.emit({ type: "operation", operation: runningOperation({ kind: "uninstall", state: "completed", finishedAt: Date.UTC(2026, 10, 17) }) });
  await flush();
  assert.match(textOf(manager.main), /Not installed/);
  assert.ok(byFocusKey(manager.main, "vm-install-git"), "retry install is offered after removal");
});

test("install progress drives the footer, survives navigation, and can be cancelled", async () => {
  const record = gitRecord();
  const { state, manager } = setup([gitPackage({
    state: "installed",
    installations: [record],
  })]);
  manager.show();
  await flush();
  byFocusKey(manager.dialog, "vm-nav-available").click();
  byFocusKey(manager.main, "vm-details-git").click();
  assert.equal(byFocusKey(manager.main, `vm-verify-${record.id}`).disabled, false);
  byFocusKey(manager.main, "vm-back").click();
  byFocusKey(manager.dialog, "vm-nav-available").click();

  manager.install("git");
  await flush();
  assert.deepEqual(state.installs, ["git"]);

  const before = state.getStateCalls;
  state.emit({ type: "operation", operation: runningOperation({ progress: { percent: 42, step: "Downloading" } }) });
  await flush();
  assert.equal(state.getStateCalls, before + 1, "operation start refreshes the inventory");
  assert.match(manager.footerStatus.textContent, /Install Git · Downloading/);
  assert.equal(manager.footerProgress.hidden, false);
  assert.equal(manager.footerProgressLabel.textContent, "42%");
  assert.equal(manager.footerProgressFill.style.width, "42%");
  assert.equal(manager.footerCancel.hidden, false);

  state.emit({ type: "operation", operation: runningOperation({ progress: { percent: 80, step: "Extracting" } }) });
  assert.equal(state.getStateCalls, before + 1, "progress updates do not reload the inventory");
  assert.equal(manager.footerProgressLabel.textContent, "80%");

  byFocusKey(manager.dialog, "vm-nav-overview").click();
  assert.match(manager.footerStatus.textContent, /Install Git/);
  byFocusKey(manager.dialog, "vm-nav-available").click();
  assert.ok(descendants(manager.main).some((node) => node.classList.contains("nce-vm-badge-installing")));
  assert.ok(byFocusKey(manager.main, "vm-row-cancel-git"), "the running row offers Cancel");

  manager.openDetail("git");
  assert.equal(byFocusKey(manager.main, `vm-verify-${record.id}`).disabled, true, "actions are disabled while busy");
  assert.equal(byFocusKey(manager.main, `vm-uninstall-${record.id}`).disabled, true);
  byFocusKey(manager.main, "vm-back").click();

  state.emit({ type: "operation", operation: runningOperation() });
  assert.equal(manager.footerProgressLabel.textContent, "Working…");
  assert.equal(manager.footerProgressFill.classList.contains("nce-vm-progress-indeterminate"), true);

  manager.footerCancel.click();
  assert.deepEqual(state.cancels, ["git"]);

  state.emit({ type: "operation", operation: runningOperation({ state: "cancelled", finishedAt: Date.UTC(2026, 10, 17) }) });
  await flush();
  assert.equal(manager.footerProgress.hidden, true);
  assert.equal(manager.footerCancel.hidden, true);
  assert.match(manager.footerStatus.textContent, /1 package\(s\) · 1 installation\(s\)/);
});

test("closing during an operation asks first and the operation continues in background", async () => {
  const { timers, state, manager } = setup();
  manager.show();
  await flush();
  state.emit({ type: "operation", operation: runningOperation({ progress: { percent: 10 } }) });
  await flush();

  manager.host.dispatch("keydown", { key: "Escape" });
  assert.equal(manager.host.hidden, false, "Escape is guarded while an operation runs");
  assert.match(manager.footerStatus.textContent, /Close the Version Manager anyway\?/);
  assert.ok(buttonWithLabel(manager.footer, "Close anyway"));
  assert.ok(buttonWithLabel(manager.footer, "Keep open"));

  buttonWithLabel(manager.footer, "Keep open").click();
  assert.match(manager.footerStatus.textContent, /Install Git/);

  manager.host.dispatch("keydown", { key: "Escape" });
  buttonWithLabel(manager.footer, "Close anyway").click();
  assert.equal(state.listeners.size, 0, "hidden popup unsubscribes from events");
  timers.tick(160);
  assert.equal(manager.host.hidden, true);

  const callsWhileHidden = state.getStateCalls;
  state.emit({ type: "operation", operation: runningOperation({ state: "completed", finishedAt: Date.UTC(2026, 10, 17) }) });
  await flush();
  assert.equal(state.getStateCalls, callsWhileHidden, "backend events do not reload a hidden popup");

  manager.show();
  await flush();
  assert.equal(state.listeners.size, 1);
  assert.equal(state.getStateCalls, callsWhileHidden + 1);
});

test("inventory-changed events refresh the displayed installations", async () => {
  const { state, manager } = setup();
  manager.show();
  await flush();
  byFocusKey(manager.dialog, "vm-nav-installed").click();
  assert.match(textOf(manager.main), /No managed installations yet/);

  state.snapshot.packages[0].installations = [gitRecord()];
  state.snapshot.packages[0].state = "installed";
  state.emit({ type: "inventory-changed" });
  await flush();
  assert.equal(state.getStateCalls, 2);
  assert.ok(byFocusKey(manager.main, "vm-installation-a1b2c3d4"));
});

test("failures surface a clear error with retry, and load errors are not hidden", async () => {
  const { state, manager } = setup([gitPackage({
    state: "failed",
    lastError: { code: "CHECKSUM_MISMATCH", message: "checksum mismatch", at: Date.UTC(2026, 10, 17) },
  })]);
  manager.show();
  await flush();
  manager.openDetail("git");
  assert.match(textOf(manager.main), /Operation failed \(CHECKSUM_MISMATCH\)/);
  assert.match(textOf(manager.main), /checksum mismatch/);
  byFocusKey(manager.main, "vm-retry-git").click();
  await flush();
  assert.deepEqual(state.installs, ["git"]);

  const broken = setup();
  broken.state.getStateError = new Error("IPC channel closed");
  broken.manager.show();
  await flush();
  assert.match(textOf(broken.manager.main), /Version Manager unavailable/);
  assert.match(textOf(broken.manager.main), /IPC channel closed/);
  assert.match(broken.manager.footerStatus.textContent, /IPC channel closed/);

  const apiLess = setup();
  apiLess.manager.editor = {};
  apiLess.manager.show();
  await flush();
  assert.match(textOf(apiLess.manager.main), /The Version Manager API is unavailable\./);
});

test("Version Manager is registered in the Command Palette and opens lazily", async () => {
  let panelOptions;
  let opened = 0;
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    USERCONFIG_KEYBINDING: [],
    CONFIG_KEYBINDING_DISPLAY: (key) => key,
  });
  const editor = {
    tabManager: { activeFile: null },
    quickPanel: { isOpen: () => false, open(options) { panelOptions = options; } },
    openVersionManager() { opened += 1; return true; },
  };
  const keyBinding = new KeyBinding(editor);
  keyBinding.control_open_command();
  const command = panelOptions.items.find((item) => item.id === "open-version-manager");
  assert.equal(command.label, "Version Manager");
  assert.equal(command.data.versionManager, true);
  assert.equal(await keyBinding.executeCommandItem(command), true);
  assert.equal(opened, 1);
});

test("Editor creates one VersionManager instance only when opened", () => {
  let constructed = 0;
  class VersionManagerStub {
    constructor(editor) { this.editor = editor; constructed += 1; }
    show() { return true; }
  }
  const Editor = loadGlobal("src/js/main/Editor.js", "Editor", {
    document: { addEventListener() {} },
    window: {},
    VersionManager: VersionManagerStub,
  });
  const editor = Object.create(Editor.prototype);
  editor._versionManager = null;

  assert.equal(constructed, 0);
  assert.equal(editor.openVersionManager(), true);
  assert.equal(constructed, 1);
  assert.equal(editor.getVersionManager(), editor._versionManager);
  assert.equal(constructed, 1);
});

test("bundle, stylesheet, sidebar and icon wiring stay consistent", () => {
  const manifest = JSON.parse(read("src/js/main/renderer-scripts.json"));
  const viewIndex = manifest.indexOf("js/view/VersionManager.js");
  assert.ok(viewIndex >= 0, "the view is bundled");
  assert.ok(viewIndex < manifest.indexOf("js/main/Editor.js"), "the view loads before Editor");

  const html = read("src/html/index.html");
  assert.match(html, /css\/versionManager\.css/);

  const sidebar = read("src/js/manager/SidebarManager.js");
  assert.match(sidebar, /sidebar-version-manager-icon/);
  assert.match(sidebar, /this\.editor\.openVersionManager\?\.\(\)/);
  assert.match(sidebar, /settingsContainer\.append\(versionManagerButton, settingsButton\)/);

  const source = read("src/js/view/VersionManager.js");
  const css = read("src/css/versionManager.css");
  const usedClasses = new Set([...source.matchAll(/nce-vm-[a-z0-9-]+/g)].map((match) => match[0]));
  for (const name of usedClasses)
    assert.ok(css.includes(`.${name}`), `stylesheet is missing .${name}`);
  for (const state of ["not-installed", "installed", "installing", "uninstalling", "failed", "corrupted", "external", "unknown", "running", "completed", "cancelled"])
    assert.ok(css.includes(`.nce-vm-badge-${state}`), `stylesheet is missing badge ${state}`);

  const icons = read("src/assets/flaticon/all.css");
  const usedIcons = new Set([...source.matchAll(/fi-rr-[a-z-]+/g)].map((match) => match[0]));
  for (const icon of usedIcons)
    assert.ok(new RegExp(`\\.${icon}(?![a-z-])`).test(icons), `icon subset is missing ${icon}`);
});