const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { normalizeArchivePath, toAsarLookupPath } = require('./archive-paths');
function find(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? find(file) : entry.name === 'app.asar' ? [file] : [];
  });
}
const archives = find(path.resolve(__dirname, '../release'));
assert.ok(archives.length, 'No packaged app.asar found; run npm run dist first');
for (const archive of archives) {
  const files = new Set(asar.listPackage(archive).map(normalizeArchivePath));
  for (const file of ['dist/main.js', 'dist/renderer/html/index.html', 'dist/renderer/html/renderer.js', 'dist/renderer/html/agent.js', 'dist/renderer/html/markdown.js', 'dist/renderer/js/worker/highlight.worker.js', 'dist/renderer/assets/icons/close.svg', 'dist/renderer/assets/logo/NCE/dark-logo.png', 'js/main/Preload.js', 'css/nsh/dark.css', 'css/nsh/light.css', 'css/performanceDashboard.css', 'package.json', 'node_modules/nsh/package.json', 'assets/icons/close.svg']) assert.ok(files.has(file), `${archive}: missing ${file}`);
  for (const directory of ['assets/fonts/', 'assets/flaticon/', 'assets/logo/']) assert.ok([...files].some(p => p.startsWith(directory)), `Missing ${directory}`);
  const htmlPath = 'dist/renderer/html/index.html';
  const html = asar.extractFile(archive, toAsarLookupPath(htmlPath)).toString();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|data:)/.test(match[1])) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(htmlPath), match[1]));
    assert.ok(files.has(target), `Unresolved packaged reference ${target}`);
  }
  console.log(`Packaged assets verified: ${path.relative(process.cwd(), archive)}`);
}
