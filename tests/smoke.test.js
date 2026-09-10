const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

function htmlReferences() {
  return [...read("src/html/index.html").matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((reference) => !/^(?:https?:|data:)/i.test(reference));
}

test("package metadata pins the expected runtime and build entrypoints", () => {
  const packageJson = JSON.parse(read("package.json"));
  const lockJson = JSON.parse(read("package-lock.json"));

  assert.equal(packageJson.main, "dist/main.js");
  assert.equal(packageJson.scripts["build:main"], "tsc");
  assert.match(packageJson.dependencies.nsh, /#[0-9a-f]{40}$/);
  assert.equal(
    lockJson.packages[""].dependencies.nsh,
    packageJson.dependencies.nsh,
  );
  assert.equal(
    require.resolve("nsh/server", { paths: [root] }).endsWith("server.js"),
    true,
  );
});

test("index references resolve in development and packaged layouts", () => {
  for (const reference of htmlReferences()) {
    assert.equal(
      fs.existsSync(path.resolve(root, "src/html", reference)),
      true,
      reference,
    );

    const virtualPackagePath = path.resolve(root, "html", reference);
    const packageRelative = path.relative(root, virtualPackagePath);
    const sourceEquivalent = packageRelative
      .split(path.sep)
      .map((part, index) =>
        index === 0 && ["html", "js", "css", "config", "assets"].includes(part)
          ? `src/${part}`
          : part,
      )
      .join(path.sep);
    assert.equal(
      fs.existsSync(path.resolve(root, sourceEquivalent)),
      true,
      reference,
    );
  }
});

test("packaged bootstrap invariants remain present", () => {
  const html = read("src/html/index.html");
  const preload = read("src/js/main/Preload.js");
  const worker = read("src/js/worker/highlight.worker.js");
  const markdown = read("src/js/addon/MarkdownRenderer.js");
  const app = read("src/ts/App.ts");

  assert.equal(fs.existsSync(path.join(root, "src/js/main/Preload.js")), true);
  assert.equal(fs.existsSync(path.join(root, "src/css/nsh/dark.css")), true);
  assert.equal(fs.existsSync(path.join(root, "src/css/nsh/light.css")), true);
  assert.equal(fs.existsSync(path.join(root, "assets/icons/close.svg")), true);
  assert.equal(fs.existsSync(path.join(root, "src/assets/icons/close.svg")), true);
  assert.match(html, /assets\/flaticon\/all\.css/);
  assert.match(preload, /exposeInMainWorld\("api"/);
  assert.match(worker, /requestTimeoutMs/);
  assert.match(markdown, /token\.className/);
  assert.doesNotMatch(app, /localhost:1212/);
  assert.equal(fs.existsSync(path.join(root, "src/modules/NSH")), false);
});

test("unfinished commands are not exposed", () => {
  const userConfig = read("src/config/Application.js");
  const menu = read("src/ts/addon/Menu.ts");
  const keyBinding = read("src/js/addon/KeyBinding.js");

  assert.doesNotMatch(userConfig, /action:\s*["']replace["']/);
  assert.doesNotMatch(keyBinding, /replace:\s*this\.control_replace/);
  assert.doesNotMatch(
    menu,
    /label:\s*["'](?:Replace|Documentation|Check for Updates)["']/,
  );
});

test("text roundtrip keeps UTF-8 bytes and mixed line endings", () => {
  const input = Buffer.from("accent é\r\nemoji 😀\nlast\r\n", "utf8");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const endings = [...text.matchAll(/\r\n|\n/g)].map((match) => match[0]);
  const output = Buffer.from(
    lines.map((line, index) => line + (endings[index] || "")).join(""),
    "utf8",
  );
  assert.deepEqual(output, input);
  assert.throws(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from([0xc3, 0x28])),
  );
});
