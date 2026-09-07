const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
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
  const files = new Set(asar.listPackage(archive).map(p => p.replace(/\\/g, '/').replace(/^\//, '')));
  for (const file of ['dist/main.js', 'html/index.html', 'js/main/Preload.js', 'js/worker/highlight.worker.js', 'css/nsh/dark.css', 'css/nsh/light.css', 'package.json', 'node_modules/nsh/package.json', 'assets/icons/close.svg']) assert.ok(files.has(file), `${archive}: missing ${file}`);
  for (const directory of ['assets/fonts/', 'assets/flaticon/', 'assets/logo/']) assert.ok([...files].some(p => p.startsWith(directory)), `Missing ${directory}`);
  const html = asar.extractFile(archive, 'html/index.html').toString();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|data:)/.test(match[1])) continue;
    const target = path.posix.normalize(path.posix.join('html', match[1]));
    assert.ok(files.has(target), `Unresolved packaged reference ${target}`);
  }
  console.log(`Packaged assets verified: ${path.relative(process.cwd(), archive)}`);
}
