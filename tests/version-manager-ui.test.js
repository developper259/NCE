const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal, loadGlobals } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const versionManagerModules = () => {
  const manifest = JSON.parse(read("src/js/main/renderer-scripts.json"));
  return [
    ...manifest.filter((entry) => entry.startsWith("js/versionManager/")).map((entry) => `src/${entry}`),
    "src/js/view/VersionManager.js",
  ];
};

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

  contains(node) {
    for (let current = node; current; current = current.parent)
      if (current === this) return true;
    return false;
  }

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
    refreshCalls: 0,
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
    async refresh() {
      state.refreshCalls += 1;
      return api.getState();
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
  const VersionManager = loadGlobals(versionManagerModules(), "VersionManager", {
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
  const titles = descendants(manager.main)
    .filter((node) => node.classList?.contains("nce-vm-group-title"))
    .map((node) => node.textContent);
  assert.deepEqual(titles, ["Available"], "an empty Installed section is not rendered");
  assert.doesNotMatch(textOf(manager.main), /No packages installed yet\./);
  assert.match(textOf(manager.main), /Git/);
  assert.ok(byFocusKey(manager.headerControls, "vm-search"));
  assert.equal(byFocusKey(manager.headerControls, "vm-sort"), null, "there is no sort control");
  const filterKeys = descendants(manager.headerControls)
    .filter((node) => node.dataset?.focusKey?.startsWith("vm-filter-"))
    .map((node) => node.dataset.focusKey);
  assert.deepEqual(filterKeys, [
    "vm-filter-all",
    "vm-filter-languages",
    "vm-filter-tools",
    "vm-filter-other",
  ]);
  assert.match(manager.footerStatus.textContent, /0 installed · 1 available/);

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

test("the single page keeps Installed above Available and filters in the header", async () => {
  const { document, state, manager } = setup();
  manager.show();
  await flush();

  const sectionTitles = descendants(manager.main)
    .filter((node) => node.classList?.contains("nce-vm-group-title"))
    .map((node) => node.textContent);
  assert.deepEqual(sectionTitles, ["Available"], "an empty Installed section is hidden");
  assert.doesNotMatch(textOf(manager.main), /No packages installed yet\./);
  assert.match(textOf(manager.main), /Git/);
  assert.ok(byFocusKey(manager.main, "vm-install-git"), "Git offers a real Install action");
  assert.equal(descendants(manager.dialog)
    .filter((node) => node.dataset?.focusKey?.startsWith("vm-nav-")).length, 0,
    "there is no section navigation");
  assert.doesNotMatch(textOf(manager.main), /Update checking|up to date/i);

  const loads = state.getStateCalls;
  byFocusKey(manager.headerControls, "vm-filter-languages").click();
  assert.match(textOf(manager.main), /No language packages yet/);
  assert.equal(byFocusKey(manager.main, "vm-install-git"), null);
  assert.equal(state.getStateCalls, loads, "filters never reload the inventory");

  byFocusKey(manager.headerControls, "vm-filter-tools").click();
  assert.match(textOf(manager.main), /Git/);
  assert.ok(byFocusKey(manager.main, "vm-install-git"));

  const search = byFocusKey(manager.headerControls, "vm-search");
  search.value = "git";
  search.dispatch("input");
  assert.ok(byFocusKey(manager.main, "vm-install-git"));
  search.value = "zzz-no-match";
  search.dispatch("input");
  assert.match(textOf(manager.main), /No packages match “zzz-no-match”/);
  assert.equal(manager.filter, "tools", "searching keeps the active category filter");
  assert.equal(state.getStateCalls, loads);

  byFocusKey(manager.main, "vm-clear-filters").click();
  assert.equal(manager.filter, "all");
  assert.equal(manager.searchQuery, "");
  assert.equal(byFocusKey(manager.headerControls, "vm-search").value, "");
  assert.match(textOf(manager.main), /Git/);
  assert.equal(document.activeElement.dataset.focusKey, "vm-filter-all");
});

test("Installed and Available sections collapse independently", async () => {
  const { document, manager } = setup([
    gitPackage({ state: "installed", installations: [gitRecord()] }),
    gitPackage({ id: "node", name: "Node", categories: ["runtime"] }),
  ]);
  manager.show();
  await flush();

  const body = (id) => descendants(manager.main).find((node) => node.id === `nce-vm-section-${id}`);
  const toggle = (id) => byFocusKey(manager.main, `vm-collapse-${id}`);

  assert.equal(toggle("installed").getAttribute("aria-expanded"), "true");
  assert.equal(toggle("available").getAttribute("aria-expanded"), "true");
  assert.equal(body("installed").hidden, false);
  assert.equal(body("available").hidden, false);

  toggle("installed").click();
  assert.equal(manager.isSectionCollapsed("installed"), true);
  assert.equal(toggle("installed").getAttribute("aria-expanded"), "false");
  assert.equal(toggle("installed").getAttribute("aria-controls"), "nce-vm-section-installed");
  assert.equal(body("installed").hidden, true);
  assert.equal(document.activeElement, toggle("installed"));
  assert.equal(toggle("available").getAttribute("aria-expanded"), "true", "sections collapse independently");
  assert.equal(body("available").hidden, false);

  toggle("available").click();
  assert.equal(manager.isSectionCollapsed("available"), true);
  assert.equal(body("available").hidden, true);
  assert.equal(toggle("installed").getAttribute("aria-expanded"), "false");

  toggle("installed").click();
  assert.equal(manager.isSectionCollapsed("installed"), false);
  assert.equal(body("installed").hidden, false);

  toggle("installed").click();
  const search = byFocusKey(manager.headerControls, "vm-search");
  search.value = "git";
  search.dispatch("input");
  assert.equal(manager.isSectionCollapsed("installed"), true, "collapse state survives search rerenders");
  assert.equal(toggle("installed").getAttribute("aria-expanded"), "false");
});

test("Installed and Available share one card design and one search", async () => {
  const record = gitRecord();
  const { document, manager } = setup([gitPackage({
    state: "installed",
    installations: [record],
  })]);
  manager.show();
  await flush();

  const titles = descendants(manager.main)
    .filter((node) => node.classList?.contains("nce-vm-group-title"))
    .map((node) => node.textContent);
  assert.deepEqual(titles, ["Installed"], "an empty Available section is hidden");
  assert.doesNotMatch(textOf(manager.main), /No packages available\./);

  const card = byFocusKey(manager.main, "vm-details-git");
  assert.ok(card);
  assert.match(textOf(card), /Git/);
  assert.match(textOf(card), /2\.56\.1/);
  assert.match(textOf(card), /Installed/);
  assert.ok(byFocusKey(manager.main, "vm-manage-git"), "installed cards expose Manage");
  assert.equal(byFocusKey(manager.main, "vm-install-git"), null);
  assert.equal(descendants(manager.main)
    .filter((node) => node.classList?.contains("nce-vm-card")).length, 1);

  const search = byFocusKey(manager.headerControls, "vm-search");
  search.focus();
  search.value = "zzz-no-match";
  search.dispatch("input");
  assert.match(textOf(manager.main), /No packages match “zzz-no-match”/);
  assert.equal(document.activeElement.dataset.focusKey, "vm-search");
  assert.equal(document.activeElement.value, "zzz-no-match");

  search.value = "2.56.1";
  search.dispatch("input");
  assert.ok(byFocusKey(manager.main, "vm-details-git"));

  search.value = "Distributed version control";
  search.dispatch("input");
  assert.ok(byFocusKey(manager.main, "vm-details-git"), "descriptions are searchable");

  search.value = "git";
  search.dispatch("input");
  assert.ok(byFocusKey(manager.main, "vm-details-git"), "category names are searchable");
});

test("details show real fields, provenance, verify, and a read-only external panel", async () => {
  const record = gitRecord();
  const { document, state, manager } = setup([gitPackage({
    state: "installed",
    installations: [record],
    external: { executable: "/usr/bin/git", version: "2.39.5", detectedAt: Date.UTC(2026, 10, 1) },
  })]);
  manager.show();
  await flush();
  byFocusKey(manager.main, "vm-details-git").click();
  assert.equal(manager.headerControls.hidden, true,
    "the detail page hides the catalog search and filters");
  const back = byFocusKey(manager.main, "vm-back");
  assert.equal(back.className, "nce-vm-back", "the Back action keeps its dedicated style");
  assert.equal(descendants(back).find((node) => node.tagName === "i")?.className,
    "fi fi-rr-arrow-small-left", "the Back action points left with an arrow");

  const text = textOf(manager.main);
  assert.match(text, /Managed by NCE/);
  assert.match(text, /\/userData\/tools\/git\/2\.56\.1\/bin\/git/);
  assert.match(text, /darwin \/ x64/);
  assert.doesNotMatch(text, /Location/);
  assert.doesNotMatch(text, /example\.com\/git\.tar\.gz/);
  assert.doesNotMatch(text, /Checksum/);
  assert.match(text, /External/);
  assert.match(text, /\/usr\/bin\/git/);
  assert.match(text, /never modifies or uninstalls external tools/);

  const uninstallButtons = descendants(manager.main).filter((node) =>
    node.tagName === "button" && textOf(node).includes("Uninstall"));
  assert.equal(uninstallButtons.length, 2, "the header shortcut plus the managed installation block");
  const externalZone = descendants(manager.main).find((node) =>
    node.classList?.contains("nce-vm-install-zone-external"));
  assert.equal(descendants(externalZone).filter((node) => node.tagName === "button").length, 0,
    "the external installation offers no actions");

  byFocusKey(manager.main, `vm-verify-${record.id}`).click();
  await flush();
  assert.deepEqual(state.verifies, [record.id]);

  byFocusKey(manager.main, "vm-back").click();
  assert.equal(manager.headerControls.hidden, false,
    "closing the detail restores the catalog search and filters");
  const titles = descendants(manager.main)
    .filter((node) => node.classList?.contains("nce-vm-group-title"))
    .map((node) => node.textContent);
  assert.deepEqual(titles, ["Installed"]);
  assert.equal(document.activeElement?.dataset?.focusKey, "vm-details-git",
    "closing the detail returns focus to its card");
});

test("the detail page keeps two columns and honest zones through every state", async () => {
  const record = gitRecord();
  const external = { executable: "/usr/bin/git", version: "2.39.5", detectedAt: Date.UTC(2026, 10, 1) };
  const { state, manager } = setup([gitPackage({ external })]);
  manager.show();
  await flush();
  manager.openDetail("git");

  const columns = () => descendants(manager.main).filter((node) => node.classList?.contains("nce-vm-detail-col"));
  const left = () => columns()[0];
  const right = () => columns()[1];
  const uninstallButtons = () => descendants(manager.main).filter((node) =>
    node.tagName === "button" && textOf(node).includes("Uninstall"));
  assert.equal(columns().length, 2, "the detail is a two-column page");
  assert.match(textOf(left()), /State and installations/);
  assert.match(textOf(right()), /About/);
  assert.match(textOf(right()), /Information/);

  // State A + external detection: install lives in the header, left stays compact.
  const detailHeader = descendants(manager.main)
    .find((node) => node.classList?.contains("nce-vm-detail-header"));
  const installButton = byFocusKey(manager.main, "vm-install-git");
  assert.ok(installButton);
  assert.ok(detailHeader.contains(installButton), "the install action belongs to the detail header");
  assert.equal(installButton.parent.parent, detailHeader,
    "the install action sits beside the package name, not below it");
  assert.match(textOf(left()), /Not installed\. NCE can install this package into its managed tools directory\./);
  assert.match(textOf(left()), /External installation/);
  assert.match(textOf(left()), /\/usr\/bin\/git/);
  assert.match(textOf(left()), /never modifies or uninstalls external tools/);
  assert.equal(uninstallButtons().length, 0, "nothing is uninstallable before an NCE install");
  assert.equal(descendants(manager.main).filter((node) => node.classList?.contains("nce-vm-empty")).length, 0,
    "no big empty panel for the missing installation");

  // Right column: full description and only real metadata, homepage as a real link.
  assert.match(textOf(right()), /Distributed version control system/);
  assert.match(textOf(right()), /dugite-native/);
  assert.match(textOf(right()), /2\.56\.1/);
  assert.match(textOf(right()), /Tools/);
  assert.match(textOf(right()), /darwin, linux, win32/);
  const link = descendants(right()).find((node) => node.tagName === "a");
  assert.equal(link.getAttribute("href"), "https://git-scm.com");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.ok(manager.focusableElements().includes(link), "the homepage link is keyboard reachable");
  assert.equal(descendants(manager.main).filter((node) => node.classList?.contains("nce-vm-category-tag")).length, 0,
    "categories are not duplicated between header and columns");

  // States B and D: managed and external installations stay separate blocks.
  state.snapshot.packages[0] = gitPackage({ state: "installed", installations: [record], external });
  manager.reload();
  await flush();
  assert.equal(descendants(left()).filter((node) => node.classList?.contains("nce-vm-install-zone")).length, 2);
  assert.match(textOf(left()), /Managed by NCE/);
  assert.match(textOf(left()), /\/userData\/tools\/git\/2\.56\.1\/bin\/git/);
  assert.doesNotMatch(textOf(left()), /Location/);
  assert.doesNotMatch(textOf(left()), /example\.com\/git\.tar\.gz/);
  assert.doesNotMatch(textOf(left()), /Checksum/);
  assert.equal(uninstallButtons().length, 2, "header shortcut plus per-installation action");
  assert.ok(byFocusKey(manager.main, `vm-verify-${record.id}`));
  assert.ok(byFocusKey(manager.main, `vm-header-uninstall-${record.id}`));

  // State E: real progress inside the installation zone, package info stays visible.
  state.emit({ type: "operation", operation: runningOperation({ progress: { percent: 42, step: "Downloading" } }) });
  await flush();
  const progress = descendants(left()).find((node) => node.classList?.contains("nce-vm-install-progress"));
  assert.match(textOf(progress), /Downloading · 42%/);
  const fill = descendants(progress).find((node) => node.classList?.contains("nce-vm-progress-fill"));
  assert.equal(fill.style.width, "42%");
  assert.ok(byFocusKey(manager.main, "vm-cancel-install-git"));
  assert.match(textOf(right()), /Distributed version control system/, "the about column survives the operation");

  // State F: the error stays inside the installations column with a real retry.
  state.snapshot.packages[0] = gitPackage({
    external,
    lastError: { code: "INSTALL_FAILED", message: "checksum mismatch", at: Date.UTC(2026, 10, 17) },
  });
  state.emit({ type: "operation", operation: runningOperation({ state: "failed", finishedAt: Date.UTC(2026, 10, 17) }) });
  await flush();
  const errorPanel = descendants(left()).find((node) => node.classList?.contains("nce-vm-error"));
  assert.ok(errorPanel, "the error is presented in the concerned zone");
  assert.match(textOf(errorPanel), /INSTALL_FAILED/);
  assert.match(textOf(errorPanel), /checksum mismatch/);
  assert.ok(byFocusKey(manager.main, "vm-retry-git"));
  assert.equal(descendants(right()).some((node) => node.classList?.contains("nce-vm-error")), false,
    "a localized error does not paint the whole page");

  // Uninstalling: progress note in the zone, no verify or uninstall while busy.
  state.snapshot.packages[0] = gitPackage({ state: "installed", installations: [record], external });
  state.emit({ type: "operation", operation: runningOperation({ kind: "uninstall" }) });
  await flush();
  assert.match(textOf(left()), /Uninstalling…/);
  assert.equal(byFocusKey(manager.main, `vm-verify-${record.id}`), null);
  assert.equal(uninstallButtons().length, 0, "no uninstall action while one is running");
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

test("install progress drives the footer and can be cancelled from the card", async () => {
  const record = gitRecord();
  const { state, manager } = setup([gitPackage({
    state: "installed",
    installations: [record],
  })]);
  manager.show();
  await flush();
  byFocusKey(manager.main, "vm-details-git").click();
  assert.equal(byFocusKey(manager.main, `vm-verify-${record.id}`).disabled, false);
  byFocusKey(manager.main, "vm-back").click();

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

  assert.ok(descendants(manager.main).some((node) => node.classList.contains("nce-vm-badge-installing")));
  assert.ok(byFocusKey(manager.main, "vm-row-cancel-git"), "the running card offers Cancel");

  manager.openDetail("git");
  assert.match(manager.footerStatus.textContent, /Install Git/);
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
  assert.match(manager.footerStatus.textContent, /1 installed · 0 available/);
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

test("surface hooks close the popup immediately even while an operation runs", async () => {
  const { timers, state, manager } = setup();
  manager.show();
  await flush();
  state.emit({ type: "operation", operation: runningOperation({ progress: { percent: 10 } }) });
  await flush();

  assert.equal(manager.hide(), true);
  assert.equal(manager.confirmation, null, "hide() must not raise the close confirmation");
  assert.equal(state.listeners.size, 0);
  timers.tick(160);
  assert.equal(manager.host.hidden, true);

  const callsWhileHidden = state.getStateCalls;
  state.emit({ type: "operation", operation: runningOperation({ state: "completed", finishedAt: Date.UTC(2026, 10, 17) }) });
  await flush();
  assert.equal(state.getStateCalls, callsWhileHidden, "the operation keeps finishing in main, not in the hidden popup");
});

test("closing behind another surface never steals its focus", async () => {
  const { document, timers, manager } = setup();
  const outsideButton = document.createElement("button");
  document.body.appendChild(outsideButton);
  outsideButton.focus();
  manager.show();
  await flush();

  const panelInput = document.createElement("input");
  document.body.appendChild(panelInput);
  manager.hide();
  panelInput.focus();
  timers.tick(160);
  assert.equal(manager.host.hidden, true);
  assert.equal(document.activeElement, panelInput, "the surface that replaced the popup keeps focus");

  outsideButton.focus();
  manager.show();
  await flush();
  manager.hide();
  timers.tick(160);
  assert.equal(document.activeElement, outsideButton, "focus still returns when nothing else took it");
});

test("a reload in flight cannot reclaim focus after the popup closes", async () => {
  const { document, timers, api, manager } = setup();
  let resolveLoad;
  const pending = new Promise((resolve) => { resolveLoad = resolve; });
  const originalGetState = api.getState;
  api.getState = () => pending;
  manager.show();

  const panelInput = document.createElement("input");
  document.body.appendChild(panelInput);
  manager.hide();
  panelInput.focus();
  resolveLoad(originalGetState());
  await flush();
  timers.tick(160);
  assert.equal(manager.host.hidden, true);
  assert.equal(document.activeElement, panelInput, "the stale reload must not render or refocus the closing popup");
});

test("inventory-changed events refresh the displayed installations", async () => {
  const { state, manager } = setup();
  manager.show();
  await flush();
  const titles = () => descendants(manager.main)
    .filter((node) => node.classList?.contains("nce-vm-group-title"))
    .map((node) => node.textContent);
  assert.deepEqual(titles(), ["Available"], "no empty Installed section is shown");
  assert.doesNotMatch(textOf(manager.main), /No packages installed yet\./);

  state.snapshot.packages[0].installations = [gitRecord()];
  state.snapshot.packages[0].state = "installed";
  state.emit({ type: "inventory-changed" });
  await flush();
  assert.equal(state.getStateCalls, 2);
  assert.deepEqual(titles(), ["Installed"], "the section appears with the real installation");
  assert.ok(byFocusKey(manager.main, "vm-details-git"));
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

test("the page keeps non-empty sections in order and renders each package once", async () => {
  const available = setup();
  available.manager.show();
  await flush();
  const availableTitles = descendants(available.manager.main)
    .filter((node) => node.classList?.contains("nce-vm-group-title"))
    .map((node) => node.textContent);
  assert.deepEqual(availableTitles, ["Available"], "an empty Installed section is hidden");
  assert.doesNotMatch(textOf(available.manager.main), /No packages installed yet\./);
  assert.equal(descendants(available.manager.main)
    .filter((node) => node.classList?.contains("nce-vm-card")).length, 1);

  const installed = setup([gitPackage({ state: "installed", installations: [gitRecord()] })]);
  installed.manager.show();
  await flush();
  const installedTitles = descendants(installed.manager.main)
    .filter((node) => node.classList?.contains("nce-vm-group-title"))
    .map((node) => node.textContent);
  assert.deepEqual(installedTitles, ["Installed"], "an empty Available section is hidden");
  assert.doesNotMatch(textOf(installed.manager.main), /No packages available\./);
  assert.equal(descendants(installed.manager.main)
    .filter((node) => node.classList?.contains("nce-vm-card")).length, 1,
    "a package is rendered exactly once even when it has several categories");

  const both = setup([
    gitPackage({ state: "installed", installations: [gitRecord()] }),
    gitPackage({ id: "node", name: "Node", categories: ["runtime"], installations: [] }),
  ]);
  both.manager.show();
  await flush();
  const bothTitles = descendants(both.manager.main)
    .filter((node) => node.classList?.contains("nce-vm-group-title"))
    .map((node) => node.textContent);
  assert.deepEqual(bothTitles, ["Installed", "Available"], "Installed stays above Available");
  assert.equal(descendants(both.manager.main)
    .filter((node) => node.classList?.contains("nce-vm-card")).length, 2);
});

test("catalog model dedupes categories, sorts by name and searches real fields", () => {
  const Model = loadGlobals(
    ["src/js/versionManager/VersionManagerModel.js"],
    "VersionManagerModel",
  );
  const packages = [
    gitPackage({
      id: "zeta",
      name: "Zeta",
      categories: ["git", "other"],
      state: "installed",
      installations: [gitRecord({
        id: "z",
        installedAt: Date.UTC(2026, 9, 1),
        updatedAt: Date.UTC(2026, 11, 1),
      })],
    }),
    gitPackage({
      id: "alpha",
      name: "Alpha",
      categories: ["git"],
      state: "installed",
      installations: [gitRecord({ id: "a", installedAt: Date.UTC(2026, 10, 1) })],
    }),
    gitPackage({
      id: "beta",
      name: "Beta",
      categories: ["language"],
      installations: [],
    }),
  ];
  const all = Model.catalogSections(packages, { filter: "all" });
  assert.deepEqual(Array.from(all.installed, (entry) => entry.id), ["alpha", "zeta"]);
  assert.deepEqual(Array.from(all.available, (entry) => entry.id), ["beta"]);
  assert.equal(new Set([...all.installed, ...all.available].map((entry) => entry.id)).size, packages.length);

  const tools = Model.catalogSections(packages, { filter: "tools" });
  assert.deepEqual(Array.from(tools.installed, (entry) => entry.id), ["alpha", "zeta"]);
  assert.deepEqual(Array.from(tools.available), []);

  const other = Model.catalogSections(packages, { filter: "other" });
  assert.deepEqual(Array.from(other.installed), []);
  assert.deepEqual(Array.from(other.available), []);

  const languages = Model.catalogSections(packages, { filter: "languages" });
  assert.deepEqual(Array.from(languages.installed), []);
  assert.deepEqual(Array.from(languages.available, (entry) => entry.id), ["beta"]);

  const runtime = gitPackage({ id: "runtime", name: "Runtime", categories: ["runtime"], installations: [] });
  const runtimeOther = Model.catalogSections([runtime], { filter: "other" });
  assert.deepEqual(Array.from(runtimeOther.available, (entry) => entry.id), ["runtime"]);
  assert.deepEqual(Array.from(Model.catalogSections([runtime], { filter: "tools" }).available), []);
  assert.deepEqual(Array.from(Model.catalogSections([runtime], { filter: "languages" }).available), []);

  const searched = Model.catalogSections(packages, { filter: "all", query: "tools" });
  assert.deepEqual(Array.from(searched.installed, (entry) => entry.id), ["alpha", "zeta"]);
  const versionSearch = Model.catalogSections(packages, { filter: "all", query: "2.56.1" });
  assert.equal(Array.from(versionSearch.installed).length, 2);

  const stale = gitPackage({ state: "installed", installations: [] });
  assert.equal(Model.isInstalled(stale), false, "installation records define ownership, not stale state");
  assert.equal(Model.packageVersion(packages[1]), "2.56.1");
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
  assert.equal(editor.versionManager, null, "the nullable accessor must not create the view");
  assert.equal(constructed, 0);
  assert.equal(editor.openVersionManager(), true);
  assert.equal(constructed, 1);
  assert.equal(editor.getVersionManager(), editor._versionManager);
  assert.equal(editor.versionManager, editor._versionManager);
  assert.equal(constructed, 1);
});

test("the root keydown route claims Escape and Tab before KeyBindingManager can swallow them", async () => {
  const { document, timers, manager } = setup();
  const Events = loadGlobal("src/js/core/Event.js", "Events", { document, window: {} });
  const calls = [];
  const events = new Events({
    get versionManager() { return manager; },
    fileExplorer: null,
    gitSidebar: null,
    searchSidebar: null,
    quickPanel: null,
    keyBindingManager: {
      onKey(event) { calls.push("keyBinding"); event.stopPropagation(); },
    },
  });
  const makeEvent = (key) => {
    const payload = {
      key,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { payload.defaultPrevented = true; },
      stopPropagation() { payload.stopped = true; },
    };
    return payload;
  };

  manager.show();
  await flush();
  timers.tick(0);

  const escape = makeEvent("Escape");
  events.onKeyDown(escape);
  assert.deepEqual(calls, [], "the global key binder must not see Escape while the popup is open");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.stopped, true);
  timers.tick(160);
  assert.equal(manager.host.hidden, true);

  const escapeWhileClosed = makeEvent("Escape");
  events.onKeyDown(escapeWhileClosed);
  assert.deepEqual(calls, ["keyBinding"], "a closed popup leaves the global route untouched");

  manager.show();
  await flush();
  const focusable = manager.focusableElements();
  focusable[focusable.length - 1].focus();
  const tab = makeEvent("Tab");
  events.onKeyDown(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(tab.stopped, true);
  assert.equal(document.activeElement, focusable[0]);
  assert.deepEqual(calls, ["keyBinding"], "Tab is trapped without reaching the global binder");

  const letter = makeEvent("a");
  events.onKeyDown(letter);
  assert.equal(letter.stopped, true, "unclaimed keys still flow to the global binder");
  assert.deepEqual(calls, ["keyBinding", "keyBinding"]);
});

test("out-of-order inventory responses cannot resurrect a finished operation", async () => {
  const { api, manager } = setup();
  const stale = {
    version: 1,
    packages: [gitPackage({ state: "installed", installations: [gitRecord()] })],
    operations: [runningOperation({ kind: "uninstall" })],
  };
  const fresh = {
    version: 1,
    packages: [gitPackage()],
    operations: [runningOperation({ state: "completed", finishedAt: Date.UTC(2026, 10, 17) })],
  };
  let resolveStale;
  const staleResponse = new Promise((resolve) => { resolveStale = resolve; });
  let calls = 0;
  api.getState = async () => {
    calls += 1;
    return calls === 1 ? staleResponse : fresh;
  };

  const first = manager.reload();
  const second = manager.reload();
  await second;
  assert.equal(manager.snapshot, fresh);
  assert.equal(manager.activeOperation(), null);

  resolveStale(stale);
  await first;
  assert.equal(manager.snapshot, fresh, "a stale response must never overwrite a newer snapshot");
  assert.equal(manager.activeOperation(), null, "Escape must not be blocked by a stale running operation");

  let rejectStale;
  const staleFailure = new Promise((_resolve, reject) => { rejectStale = reject; });
  api.getState = async () => {
    calls += 1;
    return calls === 3 ? staleFailure : fresh;
  };
  const third = manager.reload();
  const fourth = manager.reload();
  await fourth;
  rejectStale(new Error("stale failure"));
  await third;
  assert.equal(manager.loadError, null, "a stale failure must not surface after a newer success");
  assert.equal(manager.snapshot, fresh);
});

test("focus returns to the dialog when a re-render removes the focused control", async () => {
  const { document, manager } = setup();
  manager.show();
  await flush();

  const stray = document.createElement("button");
  manager.main.appendChild(stray);
  stray.focus();
  manager.render();
  assert.equal(document.activeElement, manager.closeButton,
    "a modal must not leave focus on body after its focused control disappears");
});

test("bundle, stylesheet, sidebar and icon wiring stay consistent", () => {
  const manifest = JSON.parse(read("src/js/main/renderer-scripts.json"));
  const viewIndex = manifest.indexOf("js/view/VersionManager.js");
  assert.ok(viewIndex >= 0, "the view is bundled");
  assert.ok(viewIndex < manifest.indexOf("js/main/Editor.js"), "the view loads before Editor");
  const modulePaths = manifest.filter((entry) => entry.startsWith("js/versionManager/"));
  assert.ok(modulePaths.length >= 8, "the Version Manager is split into modules");
  assert.ok(
    modulePaths.every((entry) => manifest.indexOf(entry) < viewIndex),
    "every Version Manager module loads before the root view",
  );
  assert.ok(
    !modulePaths.some((entry) => /Navigation|Overview|Installed\.js|Updates\.js/.test(entry)),
    "the single page has no section navigation modules",
  );
  assert.ok(
    modulePaths.indexOf("js/versionManager/VersionManagerModel.js") <
      modulePaths.indexOf("js/versionManager/VersionManagerUI.js"),
    "the model defines labels and icons before the UI helper uses them",
  );
  assert.ok(
    modulePaths.indexOf("js/versionManager/VersionManagerUI.js") <
      modulePaths.indexOf("js/versionManager/VersionManagerHeader.js"),
    "shared UI helpers load before the header controls",
  );
  assert.ok(
    modulePaths.indexOf("js/versionManager/VersionManagerUI.js") <
      modulePaths.indexOf("js/versionManager/VersionManagerCatalog.js"),
    "shared UI helpers load before the views",
  );

  const html = read("src/html/index.html");
  assert.match(html, /css\/versionManager\.css/);

  const sidebar = read("src/js/manager/SidebarManager.js");
  assert.match(sidebar, /sidebar-version-manager-icon/);
  assert.match(sidebar, /this\.editor\.openVersionManager\?\.\(\)/);
  assert.match(sidebar, /settingsContainer\.append\(versionManagerButton, settingsButton\)/);

  const sidebarCss = read("src/css/sidebar.css");
  assert.match(
    sidebarCss,
    /\.sidebar-version-manager-icon\s*\{[^}]*background:\s*transparent/,
    "the Version Manager icon button must not keep the native light button chrome",
  );

  const eventSource = read("src/js/core/Event.js");
  const claimIndex = eventSource.indexOf("versionManager?.handleKeyDown");
  assert.ok(claimIndex >= 0, "the root keydown route claims the Version Manager");
  assert.ok(claimIndex < eventSource.indexOf("keyBindingManager?.onKey"),
    "the popup claims keys before the global binder can stop propagation");

  const sources = [
    ...modulePaths.map((entry) => read(`src/${entry}`)),
    read("src/js/view/VersionManager.js"),
  ];
  const rootSource = sources[sources.length - 1];
  assert.match(rootSource, /VersionManagerHeader/);
  assert.match(rootSource, /VersionManagerCatalog/);
  assert.doesNotMatch(rootSource, /VersionManagerNavigation|VersionManagerOverview/);
  const css = read("src/css/versionManager.css");
  assert.match(css, /width:\s*min\(900px/, "the popup keeps its compact width cap");
  assert.match(css, /height:\s*min\(600px/, "the popup keeps its compact height cap");
  assert.doesNotMatch(css, /\.nce-vm-nav|\.nce-vm-stat/);
  const usedClasses = new Set(
    sources.flatMap((source) => [...source.matchAll(/nce-vm-[a-z0-9-]+/g)].map((match) => match[0])),
  );
  for (const name of usedClasses)
    assert.ok(css.includes(`.${name}`), `stylesheet is missing .${name}`);
  for (const state of ["not-installed", "available", "unavailable", "installed", "installing", "uninstalling", "failed", "corrupted", "external", "unknown", "running", "completed", "cancelled"])
    assert.ok(css.includes(`.nce-vm-badge-${state}`), `stylesheet is missing badge ${state}`);

  const icons = read("src/assets/flaticon/all.css");
  const usedIcons = new Set(
    sources.flatMap((source) => [...source.matchAll(/fi-rr-[a-z-]+/g)].map((match) => match[0])),
  );
  for (const icon of usedIcons)
    assert.ok(new RegExp(`\\.${icon}(?![a-z-])`).test(icons), `icon subset is missing ${icon}`);
});

test("every surface that opens a tab, sidebar or quick panel dismisses the Version Manager", () => {
  const hooks = [
    ["src/js/types/QuickPanel.js", "open(options"],
    ["src/js/quickPanel/GoToLine.js", "open()"],
    ["src/js/manager/SidebarManager.js", "openSidebar(position)"],
    ["src/js/manager/TabManager.js", "setFocusTab(tab)"],
    ["src/js/view/PerformanceDashboard.js", "show()"],
  ];
  for (const [file, method] of hooks) {
    const source = read(file);
    const methodIndex = source.indexOf(method);
    assert.ok(methodIndex >= 0, `${file} defines ${method}`);
    assert.ok(
      source.indexOf("this.editor.versionManager?.hide()", methodIndex) >= 0,
      `${file} hides the Version Manager when ${method} runs`,
    );
  }
  const goToLine = read("src/js/quickPanel/GoToLine.js");
  assert.ok(
    goToLine.indexOf("this.editor.versionManager?.hide()") < goToLine.indexOf('isOpen("go-to-line")'),
    "the hook runs before the already-open early return",
  );
});