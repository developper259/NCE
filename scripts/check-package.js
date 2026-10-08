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
  for (const file of [
    'dist/main.js',
    'dist/renderer/html/index.html',
    'dist/renderer/html/renderer.js',
    'dist/renderer/html/agent.js',
    'dist/renderer/html/markdown.js',
    'dist/renderer/js/worker/highlight.worker.js',
    'dist/renderer/assets/icons/close.svg',
    'dist/renderer/assets/logo/NCE/dark-logo.png',
    'js/main/Preload.js',
    'assets/logo/NCE/dark-logo.png',
    'package.json',
    'node_modules/nsh/package.json',
  ]) assert.ok(files.has(file), `${archive}: missing ${file}`);

  const packagedSources = [...files].filter(file => ![
    'js',
    'js/main',
    'assets',
    'assets/logo',
    'assets/logo/NCE',
  ].includes(file));
  for (const file of packagedSources) {
    assert.ok(!file.startsWith('config/'), `${archive}: unexpected renderer config source ${file}`);
    assert.ok(!file.startsWith('css/'), `${archive}: unexpected duplicate source CSS ${file}`);
    if (file.startsWith('js/')) {
      assert.equal(file, 'js/main/Preload.js', `${archive}: unexpected renderer source ${file}`);
    }
    if (file.startsWith('assets/')) {
      assert.equal(file, 'assets/logo/NCE/dark-logo.png', `${archive}: unexpected duplicate source asset ${file}`);
    }
  }

  const htmlPath = 'dist/renderer/html/index.html';
  const html = asar.extractFile(archive, toAsarLookupPath(htmlPath)).toString();
  const cssPaths = [];
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const reference = match[1];
    if (/^(https?:|data:|#)/.test(reference)) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(htmlPath), reference));
    assert.ok(files.has(target), `Unresolved packaged reference ${target}`);
    if (/\.css(?:[?#]|$)/i.test(reference)) cssPaths.push(target);
  }
  assert.ok(cssPaths.length, `${archive}: no packaged renderer CSS bundle referenced by HTML`);

  let fontReferences = 0;
  for (const cssPath of cssPaths) {
    const css = asar.extractFile(archive, toAsarLookupPath(cssPath)).toString();
    for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
      const reference = match[1].trim().replace(/^['"]|['"]$/g, '');
      if (/^(data:|https?:|#)/i.test(reference)) continue;
      const localPath = reference.split(/[?#]/, 1)[0];
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(cssPath), localPath));
      assert.ok(files.has(target), `Unresolved packaged CSS reference ${target}`);
      if (/\.woff2?(?:[?#]|$)/i.test(reference)) fontReferences += 1;
    }
  }
  assert.ok(fontReferences, `${archive}: no packaged font referenced by renderer CSS`);
  console.log(`Packaged runtime verified: ${path.relative(process.cwd(), archive)} (${cssPaths.length} CSS bundle(s), ${fontReferences} font reference(s))`);
}
