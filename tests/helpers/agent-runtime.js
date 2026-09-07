const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function createAgent(editor, fetchMock = () => { throw Error('External AI network is forbidden in tests'); }) {
  const root = path.resolve(__dirname, '../..');
  const context = { window: {}, console: { ...console, info() {}, debug() {}, log() {} }, setTimeout, clearTimeout, AbortController, AbortSignal, TextDecoder, TextEncoder, fetch: fetchMock };
  vm.createContext(context);
  const html = fs.readFileSync(path.join(root, 'src/html/index.html'), 'utf8');
  const files = [...html.matchAll(/src="\.\.\/(js\/(?:agent\/[^"\n]+|core\/Agent.js))"/g)].map(m => m[1]);
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
  context.editor = editor;
  return vm.runInContext('new Agent(editor)', context);
}
module.exports = { createAgent };
