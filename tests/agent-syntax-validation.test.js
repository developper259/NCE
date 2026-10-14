const assert = require("node:assert/strict");
const test = require("node:test");
const acorn = require("acorn");
const { loadGlobal } = require("./helpers/runtime");

const ActiveFileManager = loadGlobal(
  "src/js/agent/files/ActiveFileManager.js",
  "ActiveFileManager",
  { window: { acorn } },
);

function createManager({
  path = "/workspace/file.js",
  language = "javascript",
  moduleMode,
  source = "",
  largeFileMode = false,
} = {}) {
  let currentSource = source;
  const file = { path, language, largeFileMode };
  if (moduleMode) file.moduleMode = moduleMode;
  const agent = {
    editor: {
      lineController: { getContent: () => currentSource },
      tabManager: { activeFile: file },
      fileExplorer: { rootPath: "/workspace" },
    },
  };
  const manager = new ActiveFileManager(agent);
  return {
    agent,
    file,
    manager,
    setSource(value) { currentSource = value; },
  };
}

test("JavaScript script syntax validates without executing source", () => {
  const { manager } = createManager({
    source: "async function load() { await Promise.resolve(1); }",
    moduleMode: "commonjs",
  });

  const result = manager.validateActiveFileSyntax();
  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.equal(result.fileName, "/workspace/file.js");

  const sideEffectManager = createManager({
    source: "globalThis.__activeFileSyntaxExecuted = true;",
    moduleMode: "module",
  }).manager;
  delete globalThis.__activeFileSyntaxExecuted;
  assert.equal(sideEffectManager.validateActiveFileSyntax().valid, true);
  assert.equal(globalThis.__activeFileSyntaxExecuted, undefined);
});

test("ES modules, exports, top-level await, and .js module mode validate", () => {
  const moduleSources = [
    ['module.mjs', "import value from './value.js'; export { value }; await Promise.resolve(value);", undefined],
    ['module.js', "export const value = await Promise.resolve(1);", "module"],
  ];
  for (const [path, source, moduleMode] of moduleSources) {
    const result = createManager({ path, source, moduleMode }).manager
      .validateActiveFileSyntax();
    assert.equal(result.valid, true, path);
    assert.equal(result.skipped, undefined, path);
  }
});

test("CommonJS, async functions, and .cjs wrapper return syntax validate", () => {
  const { manager } = createManager({
    path: "/workspace/module.cjs",
    source: "const value = require('./value'); module.exports = async () => value; return module.exports;",
  });

  assert.equal(manager.validateActiveFileSyntax().valid, true);
});

test("invalid JavaScript is reported as invalid syntax", () => {
  const { manager } = createManager({
    source: "function broken( {",
    moduleMode: "commonjs",
  });
  const result = manager.validateActiveFileSyntax();

  assert.equal(result.valid, false);
  assert.match(result.error, /Unexpected token|Unexpected character/);
});

test("JSX, TypeScript, and unknown .js module context are explicitly skipped", () => {
  const cases = [
    { path: "/workspace/View.jsx", language: "javascript", source: "const view = <div />;", reason: "UNSUPPORTED_JSX" },
    { path: "/workspace/types.ts", language: "typescript", source: "const value: number = 1;", reason: "UNSUPPORTED_TYPESCRIPT" },
    { path: "/workspace/module.js", language: "javascript", source: "import value from './value.js';", reason: "MODULE_FORMAT_UNDETERMINED" },
  ];
  for (const entry of cases) {
    const result = createManager(entry).manager.validateActiveFileSyntax();
    assert.equal(result.valid, true, entry.path);
    assert.equal(result.skipped, true, entry.path);
    assert.equal(result.reason, entry.reason, entry.path);
  }
});

test("missing extension JavaScript and large files follow explicit validation limits", () => {
  const missingExtension = createManager({
    path: "/workspace/script",
    language: "javascript",
    source: "const answer = 42;",
  }).manager.validateActiveFileSyntax();
  assert.equal(missingExtension.valid, true);

  const oversized = createManager({
    path: "/workspace/large.js",
    source: "const value = 1;\n".repeat(60_000),
    moduleMode: "commonjs",
  }).manager.validateActiveFileSyntax();
  assert.equal(oversized.valid, true);
  assert.equal(oversized.skipped, true);
  assert.equal(oversized.reason, "SOURCE_TOO_LARGE");

  const largeMode = createManager({
    path: "/workspace/huge.js",
    source: "not parsed",
    largeFileMode: true,
  }).manager.validateActiveFileSyntax();
  assert.equal(largeMode.skipped, true);
  assert.equal(largeMode.reason, "LARGE_FILE_MODE");
});

test("Agent repair workflow accepts valid module code after one edit", async () => {
  const { manager, agent, setSource } = createManager({
    path: "/workspace/repaired.mjs",
    source: "const before = true;",
  });
  let edits = 0;
  agent.modifyActiveFile = async () => {
    edits += 1;
    setSource("import value from './value.mjs'; export const result = await value();");
    return { success: true, operation: "replace" };
  };
  agent.validateActiveFileSyntax = () => manager.validateActiveFileSyntax();

  const result = await manager.repairBrokenFileAfterEdit({ oldText: "before", newText: "module" });

  assert.equal(result.success, true);
  assert.equal(result.validation.valid, true);
  assert.equal(result.passes, 1);
  assert.equal(edits, 1);
});
