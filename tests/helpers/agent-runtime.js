const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function createAgent(
  editor,
  fetchMock = () => {
    throw Error("External AI network is forbidden in tests");
  },
) {
  const root = path.resolve(__dirname, "../..");
  class TestLineNode {
    constructor(text = "") {
      this.text = text;
      this.diffState = null;
      this.diffSegments = [];
    }
    getText() {
      return this.text;
    }
  }
  const context = {
    window: {},
    console: { ...console, info() {}, debug() {}, log() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    DOMException,
    TextDecoder,
    TextEncoder,
    LineNode: TestLineNode,
    fetch: fetchMock,
  };
  vm.createContext(context);
  const rendererScripts = JSON.parse(
    fs.readFileSync(
      path.join(root, "src/js/main/renderer-scripts.json"),
      "utf8",
    ),
  );
  const files = rendererScripts.filter(
    (file) => file.startsWith("config/") || /^js\/(?:agent\/|core\/Agent\.js$)/.test(file),
  );
  for (const file of files)
    vm.runInContext(
      fs.readFileSync(path.join(root, "src", file), "utf8"),
      context,
      { filename: file },
    );
  context.editor = editor;
  return vm.runInContext("new Agent(editor)", context);
}
module.exports = { createAgent };
