"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobals } = require("./helpers/runtime");
const { createDocument, walk, byFocusKey } = require("./helpers/vm-dom.js");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const textOf = (node) => walk(node, () => true)
  .map((child) => child.textContent)
  .filter(Boolean)
  .join(" ");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/js/main/renderer-scripts.json"), "utf8"));
const modules = [
  ...manifest.filter((entry) => entry.startsWith("js/versionManager/")).map((entry) => `src/${entry}`),
  "src/js/view/VersionManager.js",
];

const languageView = {
  id: "python",
  name: "Python",
  description: "Python language",
  categories: ["language"],
  icon: "fi fi-brands-python",
  fileExtensions: [".py"],
  components: [
    {
      id: "python.runtime", name: "Python Runtime", description: "Interpreter",
      type: "runtime", packageId: "python", platforms: ["darwin"],
      installableVersion: "3.12.16", supported: true, defaultSelected: true,
    },
    {
      id: "python.lsp", name: "Pyright", description: "Language server",
      type: "language-server", packageId: "pyright", platforms: ["darwin"],
      installableVersion: "1.1.414", supported: true, dependencies: ["python.runtime"],
    },
  ],
  selected: ["python.runtime", "python.lsp"],
  plan: {
    toInstall: ["python.runtime", "python.lsp"],
    toUninstall: [], unchanged: [], dependenciesToInstall: [], blockers: [], unsupported: [],
  },
};

function setup(options = {}) {
  const document = createDocument();
  const calls = { languages: 0, views: [], apply: [] };
  const languages = options.languages || [{ id: "python", name: "Python" }];
  const views = options.views || { python: languageView };
  const packages = options.packages || [
    { id: "python", name: "Python", categories: ["language"], state: "not-installed", supported: true, installations: [], capabilities: ["install"], installableVersion: "3.12.16" },
    { id: "pyright", name: "Pyright", categories: ["language-server"], state: "not-installed", supported: true, installations: [], capabilities: ["install"], installableVersion: "1.1.414" },
  ];
  const api = {
    async getState() {
      return {
        version: 1,
        packages,
        operations: [],
      };
    },
    async refresh() { return api.getState(); },
    async languages() { calls.languages += 1; return languages; },
    async languageView(languageId, selected) {
      calls.views.push({ languageId, selected });
      return views[languageId] || null;
    },
    async applyComponents(languageId, selected) {
      calls.apply.push({ languageId, selected });
      return { success: true };
    },
    onEvent() { return () => {}; },
    install: async () => ({ success: true }),
    uninstall: async () => ({ success: true }),
    verify: async () => ({ success: true }),
    cancel: async () => true,
  };
  const VersionManager = loadGlobals(modules, "VersionManager", {
    document, window: {}, setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
  });
  const manager = new VersionManager({ api: { versionManager: api } });
  return { document, manager, calls };
}

function languageComponent(id, name, type, packageId, overrides = {}) {
  return {
    id, name, description: name, type, packageId,
    platforms: ["darwin"], installableVersion: "1.0.0", supported: true,
    ...overrides,
  };
}

function emptyPlan() {
  return {
    toInstall: [], toUninstall: [], unchanged: [],
    dependenciesToInstall: [], blockers: [], unsupported: [],
  };
}

function javascriptLanguageView() {
  return {
    id: "javascript",
    name: "JavaScript & TypeScript",
    description: "JavaScript and TypeScript language",
    categories: ["language"],
    icon: "fi fi-brands-js",
    fileExtensions: [".js", ".ts"],
    components: [
      languageComponent("javascript.runtime", "JavaScript Runtime", "runtime", "node", {
        installableVersion: "24.22.3", defaultSelected: true,
      }),
      languageComponent("javascript.typescript", "TypeScript Compiler", "compiler", "typescript", {
        installableVersion: "5.9.3", dependencies: ["javascript.runtime"], defaultSelected: true,
      }),
      languageComponent("javascript.lsp", "TypeScript Language Server", "language-server", "typescript-language-server", {
        installableVersion: "6.1.0", dependencies: ["javascript.typescript"], defaultSelected: true,
      }),
    ],
    selected: ["javascript.runtime", "javascript.typescript", "javascript.lsp"],
    plan: emptyPlan(),
  };
}

function packageInfo(overrides = {}) {
  return {
    id: "node", name: "Node.js", description: "Node.js runtime",
    categories: ["language", "runtime"], state: "not-installed", supported: true,
    installations: [], capabilities: ["install"], installableVersion: "24.22.3",
    ...overrides,
  };
}

test("loading the manager fetches languages and builds component views", async () => {
  const { manager, calls } = setup();
  await manager.show();
  await flush();
  assert.equal(calls.languages, 1);
  assert.ok(calls.views.some((view) => view.languageId === "python"));
  assert.ok(manager.languageViews.has("python"));
  assert.deepEqual([...manager.selectionFor("python")].sort(), ["python.lsp", "python.runtime"]);
});

test("the catalog lists the language without its language-server package", async () => {
  const { manager } = setup();
  await manager.show();
  await flush();
  assert.ok(byFocusKey(manager.main, "vm-details-python"), "Python stays in the catalog");
  assert.equal(byFocusKey(manager.main, "vm-details-pyright"), null,
    "the language server is not a top-level package");
  assert.match(manager.footerStatus.textContent, /0 installed · 1 available/,
    "the footer only counts visible packages");

  manager.openDetail("python");
  assert.ok(byFocusKey(manager.main, "vm-component-python.lsp"),
    "the language server is still available inside the language detail");
});

test("JavaScript and TypeScript share one language detail", async () => {
  const javascript = javascriptLanguageView();
  const { manager } = setup({
    languages: [javascript],
    views: { javascript },
    packages: [
      packageInfo({ id: "node", name: "JavaScript", categories: ["language", "runtime"] }),
      packageInfo({
        id: "typescript", name: "TypeScript", categories: ["language", "compiler"],
        installableVersion: "5.9.3", hiddenFromCatalog: true,
      }),
      packageInfo({
        id: "typescript-language-server", name: "TypeScript Language Server",
        categories: ["language-server"], installableVersion: "6.1.0",
      }),
      packageInfo({
        id: "git", name: "Git", categories: ["git"], installableVersion: "2.56.1",
      }),
    ],
  });
  await manager.show();
  await flush();

  assert.ok(byFocusKey(manager.main, "vm-details-node"), "the runtime stays in the catalog");
  assert.equal(byFocusKey(manager.main, "vm-details-typescript"), null,
    "the compiler is a component, not its own card");
  assert.equal(byFocusKey(manager.main, "vm-details-typescript-language-server"), null,
    "the shared language server is not a top-level package");
  assert.match(manager.footerStatus.textContent, /0 installed · 2 available/,
    "hidden packages are not counted");

  byFocusKey(manager.main, "vm-details-node").click();
  const text = textOf(manager.main);
  assert.match(text, /JavaScript & TypeScript/);
  // One detail page carries all three components, including the compiler that
  // used to live behind its own card.
  assert.ok(byFocusKey(manager.main, "vm-component-javascript.runtime"));
  assert.ok(byFocusKey(manager.main, "vm-component-javascript.typescript"));
  assert.ok(byFocusKey(manager.main, "vm-component-javascript.lsp"));
});

test("language detail renders one checkbox per component with version metadata", async () => {
  const { document, manager } = setup();
  await manager.show();
  await flush();
  manager.openDetail("python");
  const checkboxes = walk(document.body, (node) => node.tagName === "input" && node.type === "checkbox");
  assert.equal(checkboxes.length, 2);
  assert.deepEqual(checkboxes.map((box) => box.dataset.focusKey).sort(), [
    "vm-component-python.lsp", "vm-component-python.runtime",
  ]);
  assert.ok(checkboxes.every((box) => box.checked));
  const text = walk(document.body, (node) => node.textContent).map((node) => node.textContent).join(" ");
  assert.match(text, /3\.12\.16/);
  assert.match(text, /1\.1\.414/);
  assert.match(text, /Install 2/);
  assert.ok(byFocusKey(document.body, "vm-apply-components-python"));
});

test("toggling a checkbox updates the selection and recomputes the plan", async () => {
  const { document, manager, calls } = setup();
  await manager.show();
  await flush();
  manager.openDetail("python");
  const lsp = byFocusKey(document.body, "vm-component-python.lsp");
  lsp.checked = false;
  lsp.dispatch("change");
  await flush();
  assert.deepEqual(Array.from(manager.selectionFor("python")), ["python.runtime"]);
  assert.ok(calls.views.length >= 2);
  const last = calls.views[calls.views.length - 1];
  assert.deepEqual(Array.from(last.selected), ["python.runtime"]);
});

test("Apply sends the selected component ids to the main process", async () => {
  const { document, manager, calls } = setup();
  await manager.show();
  await flush();
  manager.openDetail("python");
  const apply = byFocusKey(document.body, "vm-apply-components-python");
  apply.click();
  await flush();
  assert.equal(calls.apply.length, 1);
  assert.equal(calls.apply[0].languageId, "python");
  assert.deepEqual(Array.from(calls.apply[0].selected).sort(), ["python.lsp", "python.runtime"]);
  assert.equal(manager.languageApplying, null);
});

test("Git detail is unchanged: no component checkboxes appear for a plain package", async () => {
  const { document, manager } = setup();
  await manager.show();
  await flush();
  manager.snapshot = { version: 1, packages: [{ id: "git", name: "Git", categories: ["tool"] }], operations: [] };
  manager.openDetail("git");
  const checkboxes = walk(document.body, (node) => node.tagName === "input" && node.type === "checkbox");
  assert.equal(checkboxes.length, 0);
  assert.ok(byFocusKey(document.body, "vm-back"));
});
