const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const postcss = require('postcss');
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
  assert.equal(
    [...files].some(file => file.startsWith('node_modules/node-pty/prebuilds/')),
    false,
    `${archive}: platform prebuilds should not be duplicated in the package`,
  );
  for (const file of [
    'dist/main.js',
    'dist/renderer/html/index.html',
    'dist/renderer/html/renderer.js',
    'dist/renderer/html/agent.js',
    'dist/renderer/html/markdown.js',
    'dist/renderer/js/terminal/entry.js',
    'dist/renderer/js/worker/highlight.worker.js',
    'dist/renderer/assets/icons/close.svg',
    'dist/renderer/assets/logo/NCE/dark-logo.png',
    'js/main/Preload.js',
    'assets/logo/NCE/dark-logo.png',
    'package.json',
    'node_modules/nsh/package.json',
    'node_modules/node-pty/package.json',
    'node_modules/node-pty/lib/unixTerminal.js',
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
  const flaticonFamilies = new Set();
  for (const cssPath of cssPaths) {
    const css = asar.extractFile(archive, toAsarLookupPath(cssPath)).toString();
    postcss.parse(css).walkAtRules('font-face', rule => {
      const family = rule.nodes?.find(node =>
        node.type === 'decl' && node.prop.toLowerCase() === 'font-family',
      )?.value.replace(/["']/g, '').trim();
      if (!family?.startsWith('uicons-')) return;
      flaticonFamilies.add(family);
      const source = rule.nodes?.find(node =>
        node.type === 'decl' && node.prop.toLowerCase() === 'src',
      )?.value || '';
      assert.match(source, /\.woff2/ , `${archive}: ${family} has no WOFF2 source`);
      assert.doesNotMatch(source, /\.woff(?!2)|\.eot/, `${archive}: ${family} includes a legacy font source`);
    });
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

  const rendererSource = asar.extractFile(archive, toAsarLookupPath('dist/renderer/html/renderer.js')).toString();
  assert.doesNotMatch(rendererSource, /(?:@xterm\/|TerminalPanel)/, `${archive}: xterm leaked into the startup renderer bundle`);

  const unpackedRoot = `${archive}.unpacked`;
  assert.ok(fs.existsSync(unpackedRoot), `${archive}: no app.asar.unpacked directory`);
  const unpackedFiles = new Set();
  function collectUnpacked(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collectUnpacked(file);
      else unpackedFiles.add(path.relative(unpackedRoot, file).replaceAll(path.sep, '/'));
    }
  }
  collectUnpacked(unpackedRoot);
  const nativeModule = [...unpackedFiles].find(file =>
    file.endsWith('/build/Release/pty.node') && file.includes('node_modules/node-pty/'),
  );
  assert.ok(nativeModule, `${archive}: node-pty native module is not unpacked`);
  if (process.platform === 'darwin' || process.platform === 'linux') {
    assert.ok([...unpackedFiles].some(file =>
      file.endsWith('/build/Release/spawn-helper') && file.includes('node_modules/node-pty/'),
    ), `${archive}: node-pty spawn-helper is not unpacked`);
  }
  if (process.platform === 'win32') {
    assert.ok([...unpackedFiles].some(file =>
      file.endsWith('/build/Release/conpty.node') && file.includes('node_modules/node-pty/'),
    ), `${archive}: node-pty ConPTY module is not unpacked`);
    assert.ok([...unpackedFiles].some(file =>
      file.endsWith('/build/Release/conpty/conpty.dll') && file.includes('node_modules/node-pty/'),
    ), `${archive}: node-pty ConPTY runtime DLL is not unpacked`);
  }
  assert.deepEqual([...flaticonFamilies].sort(), [
    'uicons-brands',
    'uicons-regular-rounded',
  ], `${archive}: expected only the used Flaticon families`);
  console.log(`Packaged runtime verified: ${path.relative(process.cwd(), archive)} (${cssPaths.length} CSS bundle(s), ${fontReferences} font reference(s), node-pty unpacked)`);
}
