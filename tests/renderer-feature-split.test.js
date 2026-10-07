const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function createLoader() {
  const scripts = [];
  const document = {
    currentScript: {
      src: "file:///Applications/NCE.app/Contents/Resources/app.asar/dist/renderer/html/renderer.js",
    },
    head: {
      appendChild(script) {
        scripts.push(script);
      },
    },
    createElement(tagName) {
      assert.equal(tagName, "script");
      return {
        dataset: {},
        remove() {
          this.removed = true;
        },
      };
    },
  };
  const context = vm.createContext({
    document,
    window: { location: { href: "file:///Applications/NCE.app/Contents/Resources/app.asar/dist/renderer/html/index.html" } },
    URL,
    Promise,
    Map,
    Error,
    console,
  });
  vm.runInContext(
    `${read("src/js/main/FeatureLoader.js")}\nthis.loader = { ensureAgentBundle, ensureMarkdownBundle };`,
    context,
  );
  return { context, scripts, loader: context.loader };
}

test("feature loader deduplicates concurrent requests and retries after a failed load", async () => {
  const { context, scripts, loader } = createLoader();

  const first = loader.ensureMarkdownBundle();
  const concurrent = loader.ensureMarkdownBundle();
  assert.equal(first, concurrent);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, "file:///Applications/NCE.app/Contents/Resources/app.asar/dist/renderer/html/markdown.js");
  context.MarkdownRenderer = class MarkdownRenderer {};
  context.MarkdownView = class MarkdownView {};
  scripts[0].onload();
  await first;
  await loader.ensureMarkdownBundle();
  assert.equal(scripts.length, 1);

  const agent = loader.ensureAgentBundle();
  await Promise.resolve();
  assert.equal(scripts.length, 2);
  assert.equal(scripts[1].src, "file:///Applications/NCE.app/Contents/Resources/app.asar/dist/renderer/html/agent.js");
  context.Agent = class Agent {};
  context.AgentSidebar = class AgentSidebar {};
  scripts[1].onload();
  await agent;
  await loader.ensureAgentBundle();
  assert.equal(scripts.length, 2);

  const retryLoader = createLoader();
  const failed = retryLoader.loader.ensureMarkdownBundle();
  retryLoader.scripts[0].onerror();
  await assert.rejects(failed, /Failed to load renderer markdown bundle/);
  assert.equal(retryLoader.scripts[0].removed, true);
  const retry = retryLoader.loader.ensureMarkdownBundle();
  assert.equal(retryLoader.scripts.length, 2);
  retryLoader.context.MarkdownRenderer = class MarkdownRenderer {};
  retryLoader.context.MarkdownView = class MarkdownView {};
  retryLoader.scripts[1].onload();
  await retry;
});

test("renderer build keeps heavy Agent and Markdown code out of core", async () => {
  const { buildRendererScript } = await import("../scripts/renderer-entrypoint.mjs");
  const [core, agent, markdown] = await Promise.all([
    buildRendererScript("core"),
    buildRendererScript("agent"),
    buildRendererScript("markdown"),
  ]);

  for (const feature of ["AgentRunner", "ManualContextManager", "TestRunner"])
    assert.equal(core.includes(feature), false, `core includes ${feature}`);
  assert.doesNotMatch(core, /class (?:Agent|AgentSidebar|AgentRunner|MarkdownRenderer|MarkdownView)\b/);
  assert.doesNotMatch(core, /function markdownit\b|var markdownit\b/);
  for (const feature of ["AgentRunner", "AgentSidebar", "ManualContextManager", "TestRunner"])
    assert.equal(agent.includes(feature), true, `agent is missing ${feature}`);
  for (const feature of ["MarkdownRenderer", "MarkdownView", "markdownit"])
    assert.equal(markdown.includes(feature), true, `markdown is missing ${feature}`);

  const csp = read("src/html/index.html").match(/Content-Security-Policy[\s\S]*?content="([^"]+)"/)[1];
  assert.match(csp, /script-src 'self'/);
  const entrypoint = read("scripts/renderer-entrypoint.mjs");
  assert.match(entrypoint, /html\/agent\.js/);
  assert.match(entrypoint, /html\/markdown\.js/);
});
