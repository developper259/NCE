const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function loadMain(relative, mocks = {}, globals = {}) {
  const filename = path.resolve(__dirname, '../..', relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name), __dirname: path.dirname(filename), Buffer, TextDecoder, console, setTimeout, clearTimeout, ...globals };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}
module.exports = { loadMain };
