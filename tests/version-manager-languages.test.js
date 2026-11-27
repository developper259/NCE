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
  summary: "Tout le nécessaire pour coder en Python dans NCE.",
  benefits: [
    { title: "Exécuter vos programmes", description: "Lancez vos fichiers et projets Python.", icon: "fi-rr-code-simple" },
    { title: "Aide à l'écriture", description: "Suggestions de code, détection des erreurs et navigation.", icon: "fi-rr-sparkles" },
  ],
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
  assert.ok(textOf(manager.main).includes("Inclus dans cette installation"),
    "the language detail presents the environment, not individual packages");
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
  // One environment, one action: the compiler and language server are part of
  // the same grouped install and no longer appear as separate choices.
  assert.equal(walk(manager.main, (node) => node.tagName === "input" && node.type === "checkbox").length, 0);
  assert.ok(byFocusKey(manager.main, "vm-apply-components-javascript"));
});

test("language detail shows one centred environment with plain benefits", async () => {
  const { document, manager } = setup();
  await manager.show();
  await flush();
  manager.openDetail("python");
  const text = textOf(document.body);
  assert.match(text, /Python/);
  assert.match(text, /Inclus dans cette installation/);
  assert.match(text, /Exécuter vos programmes/);
  assert.match(text, /Aide à l'écriture/);
  assert.match(text, /Installer Python/);
  assert.equal(walk(document.body, (node) => node.tagName === "input" && node.type === "checkbox").length, 0);
  assert.ok(byFocusKey(document.body, "vm-apply-components-python"));
});

test("technical component names stay out of the main presentation", async () => {
  const { document, manager } = setup();
  await manager.show();
  await flush();
  manager.openDetail("python");
  const header = walk(document.body, (node) =>
    node.className && String(node.className).includes("nce-vm-env-header"))[0];
  const benefits = walk(document.body, (node) =>
    node.className && String(node.className).includes("nce-vm-env-benefits"))[0];
  const visible = textOf(header) + " " + textOf(benefits);
  for (const term of ["Runtime", "LSP", "Language Server", "Package", "python.runtime", "python.lsp"])
    assert.equal(visible.includes(term), false, `${term} must not appear in the presentation`);
});

test("technical details are available in a collapsed section", async () => {
  const { document, manager } = setup();
  await manager.show();
  await flush();
  manager.openDetail("python");
  const toggle = byFocusKey(document.body, "vm-env-details-python");
  assert.ok(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.dispatch("click");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const text = textOf(document.body);
  assert.match(text, /3\.12\.16/);
  assert.match(text, /1\.1\.414/);
});

test("the single action installs every recommended component at once", async () => {
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

test("applying a language never reuses another language's selection", async () => {
  // Regression: a language whose view had not loaded yet fell back to an empty
  // array, and the manager applied a plan that did not belong to the language
  // the user was looking at. Python's panel could start installing JavaScript.
  const { document, manager, calls } = setup({
    languages: [{ id: "python", name: "Python" }, { id: "javascript", name: "JavaScript" }],
    views: { python: languageView, javascript: javascriptLanguageView() },
  });
  await manager.show();
  await flush();

  // Select JavaScript components, then apply Python without its view loaded.
  manager.state.componentSelection.set("javascript", new Set(["javascript.runtime", "javascript.lsp"]));
  manager.state.componentSelection.delete("python");

  manager.openDetail("python");
  // The guard lives in applyLanguageComponents; the grouped action deliberately
  // rebuilds the selection, so call the guarded path directly here.
  await manager.applyLanguageComponents("python");
  await flush();

  assert.equal(calls.apply.length, 0, "nothing may be applied without a real selection");
  assert.ok(manager.state.confirmation, "the user is told the view is still loading");
});

test("the single action resets the selection to the full recommended set", async () => {
  const { document, manager, calls } = setup();
  await manager.show();
  await flush();
  // A stale partial selection must not produce a partial environment.
  manager.state.setSelection("python", ["python.lsp"]);
  manager.openDetail("python");
  byFocusKey(document.body, "vm-apply-components-python").click();
  await flush();
  assert.deepEqual(Array.from(calls.apply[0].selected).sort(), ["python.lsp", "python.runtime"]);
});

test("uninstalling a language asks first and removes the whole environment", async () => {
  const installed = {
    ...languageView,
    plan: { ...languageView.plan, toInstall: [], unchanged: ["python.runtime", "python.lsp"] },
  };
  const { document, manager, calls } = setup({ views: { python: installed } });
  await manager.show();
  await flush();
  manager.openDetail("python");

  const text = textOf(document.body);
  assert.match(text, /Installé/);
  assert.match(text, /Désinstaller Python/);

  byFocusKey(document.body, "vm-uninstall-language-python").click();
  assert.ok(byFocusKey(document.body, "vm-confirm-uninstall-language-python"));
  assert.equal(calls.apply.length, 0, "nothing is removed before confirmation");

  byFocusKey(document.body, "vm-confirm-uninstall-language-python").click();
  await flush();
  assert.equal(calls.apply.length, 1);
  assert.deepEqual(Array.from(calls.apply[0].selected), []);
});

test("a partially installed environment is never reported as complete", async () => {
  const partial = {
    ...languageView,
    plan: { ...languageView.plan, toInstall: ["python.lsp"], unchanged: ["python.runtime"] },
  };
  const { document, manager } = setup({ views: { python: partial } });
  await manager.show();
  await flush();
  manager.openDetail("python");
  const text = textOf(document.body);
  assert.match(text, /Installation partielle/);
  assert.equal(text.includes("Installé"), false);
  assert.ok(byFocusKey(document.body, "vm-apply-components-python"));
});

test("a blocked environment offers a repair action", async () => {
  const blocked = {
    ...languageView,
    plan: { ...languageView.plan, blockers: ["A component is unavailable"] },
  };
  const { document, manager, calls } = setup({ views: { python: blocked } });
  await manager.show();
  await flush();
  manager.openDetail("python");
  const text = textOf(document.body);
  assert.match(text, /Installation incomplète/);
  const repair = byFocusKey(document.body, "vm-apply-components-python");
  assert.match(textOf(repair), /Réparer Python/);
  repair.click();
  await flush();
  assert.equal(calls.apply.length, 1);
});

test("component operations are surfaced while a plan runs", async () => {
  // Regression: component-operation events were broadcast but never handled, so
  // a dependency could start downloading with no visible feedback.
  let emit = null;
  const { document, manager } = setup();
  manager.api.onEvent = (callback) => { emit = callback; return () => {}; };
  await manager.show();
  await flush();
  manager.subscribe?.();

  assert.equal(typeof emit, "function");
  emit({
    type: "component-operation",
    componentId: "python.runtime",
    packageId: "python",
    kind: "install",
    state: "running",
    message: "Installing Python Runtime…",
  });
  manager.openDetail("python");

  assert.ok(textOf(document.body).includes("Installing Python Runtime"));
});

test("installation progress is shown as a comprehensible status", async () => {
  let emit = null;
  const { document, manager } = setup();
  manager.api.onEvent = (callback) => { emit = callback; return () => {}; };
  await manager.show();
  await flush();
  manager.subscribe?.();
  manager.openDetail("python");

  emit({
    type: "component-operation",
    componentId: "python.runtime",
    state: "running",
    message: "Téléchargement en cours…",
  });
  const line = walk(document.body, (node) =>
    node.className && String(node.className).includes("nce-vm-env-progress-line"))[0];
  assert.ok(line, "the progress line is rendered");
  assert.equal(line.getAttribute("role"), "status");
  assert.ok(textOf(line).includes("Téléchargement en cours"));
});

test("a failed operation shows an error status and keeps the retry action", async () => {
  let emit = null;
  const { document, manager } = setup();
  manager.api.onEvent = (callback) => { emit = callback; return () => {}; };
  await manager.show();
  await flush();
  manager.subscribe?.();
  manager.openDetail("python");

  emit({
    type: "component-operation",
    componentId: "python.runtime",
    state: "failed",
    message: "Le téléchargement a échoué. Réessayez.",
  });
  const line = walk(document.body, (node) =>
    node.className && String(node.className).includes("nce-vm-env-progress-failed"))[0];
  assert.ok(line, "the failure is visible");
  assert.ok(byFocusKey(document.body, "vm-apply-components-python"), "retry stays available");
});

test("the environment page works in both themes and narrow windows", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const css = fs.readFileSync(path.join(root, "src/css/versionManager.css"), "utf8");
  const themeVars = fs.readFileSync(path.join(root, "src/css/var.css"), "utf8");

  // Every environment rule uses tokens defined in both palettes.
  const envCss = css.slice(css.indexOf("/* Language environment page"), css.indexOf("/* Component rows"));
  const usedVars = new Set([...envCss.matchAll(/var\((--[a-z-]+)\)/g)].map((match) => match[1]));
  const darkBlock = themeVars.slice(0, themeVars.indexOf(':root[data-theme="light"]'));
  const lightBlock = themeVars.slice(themeVars.indexOf(':root[data-theme="light"]'));
  for (const name of usedVars) {
    // A token may be defined once in :root and inherited by both themes.
    const defined = darkBlock.includes(`${name}:`) || lightBlock.includes(`${name}:`);
    assert.ok(defined, `missing theme token ${name}`);
  }
  // The light theme must at least redefine the surfaces and text it changes.
  for (const name of ["--bg-secondary", "--bg-tertiary", "--text-primary", "--border-primary"])
    assert.ok(lightBlock.includes(`${name}:`), `light theme is missing ${name}`);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*nce-vm-env-header/);
  assert.match(css, /prefers-reduced-motion[\s\S]*nce-vm-env-working/);
});

test("an optional component does not keep a complete environment out of 'Installé'", async () => {
  // A language may later add a component that is not part of the recommended
  // installation (a formatter, a linter). Its absence must not leave the
  // environment stuck on "Installation partielle" forever.
  const withOptional = {
    ...languageView,
    components: [
      ...languageView.components,
      languageComponent("python.ruff", "Ruff", "toolchain", "ruff", {
        installableVersion: "0.14.0", defaultSelected: false,
      }),
    ],
    plan: { ...languageView.plan, toInstall: [], unchanged: ["python.runtime", "python.lsp"] },
  };
  const { document, manager } = setup({ views: { python: withOptional } });
  await manager.show();
  await flush();
  manager.openDetail("python");
  const text = textOf(document.body);
  assert.match(text, /Installé/);
  assert.equal(text.includes("Installation partielle"), false);
});

test("a language whose packages are all hidden still gets one catalog entry", async () => {
  // The real JavaScript & TypeScript environment: the TypeScript SDK is
  // `hiddenFromCatalog` and the language server is a `language-server` package,
  // so no package card is left. Without a language entry the environment was
  // unreachable from the catalog.
  const javascript = {
    ...javascriptLanguageView(),
    components: javascriptLanguageView().components.filter((c) => c.id !== "javascript.runtime"),
    selected: ["javascript.typescript", "javascript.lsp"],
  };
  const { document, manager, calls } = setup({
    languages: [javascript],
    views: { javascript },
    packages: [
      packageInfo({
        id: "typescript", name: "TypeScript", categories: ["language", "compiler"],
        hiddenFromCatalog: true, installableVersion: "6.0.3",
      }),
      packageInfo({
        id: "typescript-language-server", name: "TypeScript Language Server",
        categories: ["language-server"], installableVersion: "6.1.0",
      }),
      packageInfo({ id: "git", name: "Git", categories: ["git"] }),
    ],
  });
  await manager.show();
  await flush();

  // Exactly one entry for the environment, and no technical card beside it.
  assert.ok(byFocusKey(manager.main, "vm-details-javascript"), "the environment is reachable");
  assert.equal(byFocusKey(manager.main, "vm-details-typescript"), null);
  assert.equal(byFocusKey(manager.main, "vm-details-typescript-language-server"), null);
  assert.equal(byFocusKey(manager.main, "vm-details-node"), null, "no Node.js card");
  assert.match(manager.footerStatus.textContent, /0 installed · 2 available/);

  // Its card installs the whole environment through the grouped path.
  byFocusKey(manager.main, "vm-install-javascript").click();
  await flush();
  assert.equal(calls.apply.length, 1);
  assert.equal(calls.apply[0].languageId, "javascript");
  assert.deepEqual([...calls.apply[0].selected].sort(), ["javascript.lsp", "javascript.typescript"]);

  // Opening it shows the environment, not a package detail page.
  manager.openDetail("javascript");
  const text = textOf(manager.main);
  assert.match(text, /JavaScript & TypeScript/);
  assert.match(text, /Inclus dans cette installation/);
  assert.ok(byFocusKey(manager.main, "vm-apply-components-javascript"));
});

test("a language with no available component adds no catalog card", async () => {
  // Integration smoke runs narrow the registry to Git. The language
  // definitions still exist, but none of their packages can be installed:
  // showing a card would create a spurious "Available" section.
  const javascript = {
    ...javascriptLanguageView(),
    components: javascriptLanguageView().components.map((component) => ({
      ...component, supported: false,
    })),
  };
  const { manager } = setup({
    languages: [javascript],
    views: { javascript },
    packages: [packageInfo({ id: "git", name: "Git", categories: ["git"] })],
  });
  await manager.show();
  await flush();

  assert.equal(byFocusKey(manager.main, "vm-details-javascript"), null,
    "an unavailable environment is not offered in the catalog");
  assert.ok(byFocusKey(manager.main, "vm-details-git"));
});

test("a language that owns a visible package keeps a single card", async () => {
  // Python's package is the environment. Adding a language entry on top would
  // show the same environment twice.
  const { manager } = setup();
  await manager.show();
  await flush();
  const cards = walk(manager.main, (node) => node.classList?.contains("nce-vm-card"));
  assert.equal(cards.length, 1);
  assert.ok(byFocusKey(manager.main, "vm-details-python"));
});
