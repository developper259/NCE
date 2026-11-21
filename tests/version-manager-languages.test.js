"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobals } = require("./helpers/runtime");
const { createDocument, walk, byFocusKey } = require("./helpers/vm-dom.js");

const flush = () => new Promise((resolve) => setImmediate(resolve));

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

function setup() {
  const document = createDocument();
  const calls = { languages: 0, views: [], apply: [] };
  const api = {
    async getState() {
      return {
        version: 1,
        packages: [
          { id: "python", name: "Python", categories: ["language"], state: "not-installed", installations: [], capabilities: ["install"], installableVersion: "3.12.16" },
          { id: "pyright", name: "Pyright", categories: ["language-server"], state: "not-installed", installations: [], capabilities: ["install"], installableVersion: "1.1.414" },
        ],
        operations: [],
      };
    },
    async refresh() { return api.getState(); },
    async languages() { calls.languages += 1; return [{ id: "python", name: "Python" }]; },
    async languageView(languageId, selected) {
      calls.views.push({ languageId, selected });
      return languageView;
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

test("loading the manager fetches languages and builds component views", async () => {
  const { manager, calls } = setup();
  await manager.show();
  await flush();
  assert.equal(calls.languages, 1);
  assert.ok(calls.views.some((view) => view.languageId === "python"));
  assert.ok(manager.languageViews.has("python"));
  assert.deepEqual([...manager.selectionFor("python")].sort(), ["python.lsp", "python.runtime"]);
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
