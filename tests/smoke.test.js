const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
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
  assert.equal(packageJson.scripts["build:renderer"], "vite build --config vite.config.mjs");
  assert.match(packageJson.devDependencies.vite, /^\^8\./);
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

test("asset sync copies CSS source maps beside both Flaticon stylesheets", () => {
  execFileSync(process.execPath, [path.join(root, "scripts/sync-assets.js")], {
    cwd: root,
    stdio: "ignore",
  });

  for (const directory of ["assets/flaticon", "src/assets/flaticon"]) {
    const cssPath = path.join(root, directory, "all.css");
    const mapPath = path.join(root, directory, "all.css.map");
    const css = fs.readFileSync(cssPath, "utf8");
    assert.match(css, /sourceMappingURL=all\.css\.map/);
    assert.equal(fs.statSync(mapPath).isFile(), true, mapPath);
  }
});

test("index references resolve in development and packaged layouts", async () => {
  const rendererScripts = JSON.parse(read("src/js/main/renderer-scripts.json"));
  const { buildRendererScript } = await import("../scripts/renderer-entrypoint.mjs");
  const rendererBundle = await buildRendererScript();
  const agentBundle = await buildRendererScript("agent");
  const markdownBundle = await buildRendererScript("markdown");
  assert.ok(rendererScripts.length > 0);
  assert.match(rendererBundle, /class Editor\s*\{/);
  assert.doesNotMatch(rendererBundle, /class Agent\s*\{|class AgentSidebar\s*\{|class MarkdownRenderer\s*\{/);
  assert.match(agentBundle, /class Agent\s*\{/);
  assert.match(agentBundle, /class AgentSidebar\s+extends Sidebar/);
  assert.match(markdownBundle, /class MarkdownRenderer\s*\{/);
  assert.match(markdownBundle, /class MarkdownView\s*\{/);

  for (const reference of htmlReferences()) {
    if (reference === "./renderer.js") continue;
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

test("Vite development serves the classic renderer entrypoint and Worker", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.join(root, "vite.config.mjs"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });

  try {
    await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const htmlResponse = await fetch(`${origin}/html/index.html`);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.match(html, /\/@vite\/client/);
    assert.match(html, /<script\b(?=[^>]*src="\.\/renderer\.js")[^>]*><\/script>/);
    assert.doesNotMatch(html, /vite-ignore/);

    const rendererResponse = await fetch(`${origin}/html/renderer.js`);
    const renderer = await rendererResponse.text();
    assert.equal(rendererResponse.status, 200);
    assert.match(renderer, /class Editor\s*\{/);
    assert.doesNotMatch(renderer, /class Agent\s*\{|class AgentSidebar\s*\{|class MarkdownRenderer\s*\{/);

    const agentResponse = await fetch(`${origin}/html/agent.js`);
    const agent = await agentResponse.text();
    assert.equal(agentResponse.status, 200);
    assert.match(agent, /class AgentSidebar\s+extends Sidebar/);

    const markdownResponse = await fetch(`${origin}/html/markdown.js`);
    const markdown = await markdownResponse.text();
    assert.equal(markdownResponse.status, 200);
    assert.match(markdown, /class MarkdownRenderer\s*\{/);

    const workerResponse = await fetch(`${origin}/js/worker/highlight.worker.js`);
    assert.equal(workerResponse.status, 200);
    assert.match(await workerResponse.text(), /requestTimeoutMs/);
  } finally {
    await server.close();
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
