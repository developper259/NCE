const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const config = require(path.join(root, "src/config/AgentDebug.js"));
const detectorSource = fs.readFileSync(
  path.join(root, "src/js/agent/debug/TestDetector.js"),
  "utf8",
);

function makeDetector(entries, contents = {}) {
  const workspace = "/workspace";
  const context = { window: {}, AgentDebug: config, console };
  vm.createContext(context);
  vm.runInContext(`${detectorSource}\nthis.Detector = TestDetector;`, context);
  const agent = {
    editor: { fileExplorer: { rootPath: workspace } },
    resolveWorkspacePath(relative, base) {
      return path.join(base, relative);
    },
    api: {
      async listProjectFiles() {
        return { success: true, entries };
      },
      async getFileContent(paths) {
        return Object.fromEntries(
          paths
            .filter((file) => contents[file] !== undefined)
            .map((file) => [file, contents[file]]),
        );
      },
    },
  };
  return new context.Detector(agent);
}

const file = (relativePath, type = "file") => ({ relativePath, type });
const packageJson = (value) => ({
  "/workspace/package.json": JSON.stringify(value),
});

test("config exposes JavaScript, Python, and PHP", () => {
  assert.deepEqual(Object.keys(config.languages), [
    "javascript",
    "python",
    "php",
  ]);
});

test("extension lookup is language-extensible", () => {
  const detector = makeDetector([]);
  assert.equal(detector.findLanguageForFile("sample.js").id, "javascript");
  assert.equal(detector.findLanguageForFile("sample.py").id, "python");
  assert.equal(detector.findLanguageForFile("sample.php").id, "php");
});

test("JavaScript package without a usable test environment returns guidance", async () => {
  const detector = makeDetector(
    [file("package.json")],
    packageJson({ scripts: { test: "echo Error: no test specified" } }),
  );
  const result = await detector.detect();
  assert.equal(result.status, "NO_TEST_ENVIRONMENT");
  assert.equal(result.suggestedAction.type, "CREATE_STANDALONE_TEST");
});

test("JavaScript explicit file selects node-script", async () => {
  const result = await makeDetector([file("check.js")]).detect({
    path: "check.js",
  });
  assert.equal(result.status, "READY");
  assert.equal(result.strategy, "node-script");
  assert.equal(result.validationKind, "standalone-test");
});

test("JavaScript project script selects npm-test", async () => {
  const detector = makeDetector(
    [file("package.json")],
    packageJson({ scripts: { test: "node --test" } }),
  );
  const result = await detector.detect();
  assert.equal(result.strategy, "npm-test");
});

test("JavaScript test naming selects node-test", async () => {
  const result = await makeDetector([file("tests/sample.test.js")]).detect();
  assert.equal(result.strategy, "node-test");
});

test("Python without markers returns no environment", async () => {
  const result = await makeDetector([file("app.py")]).detect();
  assert.equal(result.status, "NO_TEST_ENVIRONMENT");
});

test("Python explicit file selects python-script", async () => {
  const result = await makeDetector([file("check.py")]).detect({
    path: "check.py",
  });
  assert.equal(result.strategy, "python-script");
});

test("Python test conventions select unittest project strategy", async () => {
  const result = await makeDetector([file("tests/test_app.py")]).detect();
  assert.equal(result.strategy, "python-unittest");
});

test("Python marker selects pytest project strategy", async () => {
  const result = await makeDetector([
    file("pyproject.toml"),
    file("tests/test_app.py"),
  ]).detect();
  assert.equal(result.strategy, "python-pytest");
});

test("PHP without markers returns no environment", async () => {
  const result = await makeDetector([file("src/App.php")]).detect();
  assert.equal(result.status, "NO_TEST_ENVIRONMENT");
});

test("PHP explicit file selects php-script", async () => {
  const result = await makeDetector([file("check.php")]).detect({
    path: "check.php",
  });
  assert.equal(result.strategy, "php-script");
});

test("PHPUnit marker selects phpunit", async () => {
  const result = await makeDetector([
    file("phpunit.xml"),
    file("tests/AppTest.php"),
  ]).detect();
  assert.equal(result.strategy, "phpunit");
});

test("project root falls back to dot", async () => {
  const result = await makeDetector([file("tests/sample.test.js")]).detect();
  assert.equal(result.projectRoot, ".");
});

test("explicit directory selects project scope", async () => {
  const result = await makeDetector(
    [file("pkg/package.json"), file("pkg/tests/a.test.js")],
    {
      "/workspace/pkg/package.json": JSON.stringify({
        scripts: { test: "node --test" },
      }),
    },
  ).detect({ path: "pkg" });
  assert.equal(result.status, "READY");
  assert.equal(result.projectRoot, "pkg");
});

test("unsupported extension is rejected", async () => {
  const result = await makeDetector([file("sample.rb")]).detect({
    path: "sample.rb",
  });
  assert.equal(result.status, "UNSUPPORTED_TARGET");
});

test("missing target is rejected", async () => {
  const result = await makeDetector([file("sample.js")]).detect({
    path: "missing.js",
  });
  assert.equal(result.status, "INVALID_TARGET");
});

test("path traversal is rejected", async () => {
  const result = await makeDetector([file("sample.js")]).detect({
    path: "../sample.js",
  });
  assert.equal(result.status, "INVALID_TARGET");
});

test("paths with spaces remain valid targets", async () => {
  const result = await makeDetector([
    file("folder with spaces/check.py"),
  ]).detect({ path: "folder with spaces/check.py" });
  assert.equal(result.strategy, "python-script");
});

test("monorepo returns a unique nested project", async () => {
  const result = await makeDetector(
    [file("packages/app/package.json"), file("packages/app/tests/a.test.js")],
    {
      "/workspace/packages/app/package.json": JSON.stringify({
        scripts: { test: "node --test" },
      }),
    },
  ).detect();
  assert.equal(result.projectRoot, "packages/app");
});

test("standalone recommendations prohibit installation", async () => {
  const result = await makeDetector([file("app.py")]).detect();
  assert.match(result.suggestedAction.message, /do not install dependencies/i);
  assert.ok(
    result.standalone.some((entry) => entry.strategy === "python-script"),
  );
});

test("standalone metadata lists known runtime candidates", async () => {
  const result = await makeDetector([file("app.js")]).detect();
  assert.ok(
    result.standalone[0].runtimes.some(
      (runtime) => runtime.executable === "node",
    ),
  );
});

test("language config declares stable strategy IDs", () => {
  assert.equal(config.strategies["node-script"].kind, "standalone");
  assert.equal(config.strategies["python-script"].language, "python");
  assert.equal(config.strategies["php-script"].language, "php");
});

test("project strategies are declarative", () => {
  for (const language of Object.values(config.languages)) {
    assert.ok(language.projectStrategies.length > 0);
    assert.ok(
      language.projectStrategies.every(
        (strategy) => strategy.id && strategy.kind,
      ),
    );
  }
});
