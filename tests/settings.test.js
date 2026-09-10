const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  SettingsManager, DEFAULT_SETTINGS, DEFAULT_KEYBINDINGS,
} = require('../dist/ts/manager/SettingsManager.js');

async function temporaryUserData() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nce-settings-'));
}

async function readSettings(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
}

test('missing settings are created in userData with defaults', async () => {
  const root = await temporaryUserData();
  try {
    const manager = new SettingsManager(root);
    assert.deepEqual(await manager.initialize(), DEFAULT_SETTINGS);
    assert.deepEqual(await readSettings(root), DEFAULT_SETTINGS);
    assert.equal(manager.settingsPath, path.join(root, 'settings.json'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('valid settings persist across manager restarts and set writes JSON', async () => {
  const root = await temporaryUserData();
  try {
    const first = new SettingsManager(root);
    await first.initialize();
    assert.equal(await first.set('editor.tabWidth', 8), true);
    assert.equal(await first.set('files.autoSave', true), true);
    const second = new SettingsManager(root);
    await second.initialize();
    assert.equal(second.get('editor.tabWidth'), 8);
    assert.equal(second.get('files.autoSave'), true);
    assert.deepEqual(await readSettings(root), {
      editor: { tabWidth: 8 }, files: { autoSave: true },
      keybindings: DEFAULT_KEYBINDINGS,
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('malformed and invalid known settings fall back without crashing', async () => {
  const root = await temporaryUserData();
  try {
    await fs.writeFile(path.join(root, 'settings.json'), '{ invalid json');
    const originalWarn = console.warn; console.warn = () => {};
    try {
      const malformed = new SettingsManager(root);
      assert.deepEqual(await malformed.initialize(), DEFAULT_SETTINGS);
    } finally { console.warn = originalWarn; }

    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({
      editor: { tabWidth: 'wide' }, files: { autoSave: 1 },
    }));
    const invalid = new SettingsManager(root);
    assert.deepEqual(await invalid.initialize(), DEFAULT_SETTINGS);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('missing known defaults are merged while unknown properties survive', async () => {
  const root = await temporaryUserData();
  try {
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({
      editor: { tabWidth: 4, futureEditorSetting: true }, futureSection: { value: 1 },
    }));
    const manager = new SettingsManager(root);
    assert.deepEqual(await manager.initialize(), {
      editor: { tabWidth: 4 }, files: { autoSave: false },
      keybindings: DEFAULT_KEYBINDINGS,
    });
    const disk = await readSettings(root);
    assert.equal(disk.editor.futureEditorSetting, true);
    assert.deepEqual(disk.futureSection, { value: 1 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('queued concurrent writes leave a complete latest settings document', async () => {
  const root = await temporaryUserData();
  try {
    const manager = new SettingsManager(root);
    await manager.initialize();
    await Promise.all([
      manager.set('editor.tabWidth', 6),
      manager.set('files.autoSave', true),
      manager.set('editor.tabWidth', 12),
    ]);
    assert.deepEqual(await readSettings(root), {
      editor: { tabWidth: 12 }, files: { autoSave: true },
      keybindings: DEFAULT_KEYBINDINGS,
    });
    assert.equal(await manager.set('editor.tabWidth', 17), false);
    assert.equal(await manager.set('unknown.value', true), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('legacy autoSave migrates only when settings.json is first created', async () => {
  const root = await temporaryUserData();
  try {
    await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({
      preferences: { autoSave: true }, tabManager: { files: [] },
    }));
    const manager = new SettingsManager(root);
    await manager.initialize();
    assert.equal(manager.get('files.autoSave'), true);
    assert.equal((await readSettings(root)).files.autoSave, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('keybindings are validated, merged and persisted as settings', async () => {
  const root = await temporaryUserData();
  try {
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({
      editor: { tabWidth: 2 }, files: { autoSave: false },
      keybindings: { save: 'Mod+Alt+S', quick_open: 42 },
    }));
    const manager = new SettingsManager(root);
    await manager.initialize();
    assert.equal(manager.get('keybindings.save'), 'Mod+Alt+S');
    assert.equal(manager.get('keybindings.quick_open'), 'Mod+P');
    assert.equal(await manager.set('keybindings.quick_open', 'Mod+K'), true);
    const restarted = new SettingsManager(root);
    await restarted.initialize();
    assert.equal(restarted.get('keybindings.quick_open'), 'Mod+K');
    assert.equal(await manager.set('keybindings.save', ''), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('settings remain IPC-scoped and session state contains no preferences', async () => {
  const preload = await fs.readFile(path.join(__dirname, '../src/js/main/Preload.js'), 'utf8');
  const state = await fs.readFile(path.join(__dirname, '../src/js/manager/StatesManager.js'), 'utf8');
  const user = await fs.readFile(path.join(__dirname, '../src/config/Application.js'), 'utf8');
  const tools = await fs.readFile(path.join(__dirname, '../src/js/core/Tools.js'), 'utf8');
  const app = await fs.readFile(path.join(__dirname, '../src/ts/App.ts'), 'utf8');
  assert.match(preload, /Settings:getAll/);
  assert.match(preload, /Settings:set/);
  assert.doesNotMatch(preload, /require\(["'](?:node:)?fs/);
  assert.doesNotMatch(state, /preferences|autoSave/);
  assert.doesNotMatch(user, /tab_width|CONFIG_GET|CONFIG_SET|USERCONFIG_CONFIG/);
  assert.match(tools, /SETTINGS_GET\("editor\.tabWidth"\)/);
  assert.match(app, /app\.getPath\("userData"\)/);
});

test('startup initializes settings before NSH and BrowserWindow creation', async () => {
  const app = await fs.readFile(path.join(__dirname, '../src/ts/App.ts'), 'utf8');
  const initialize = app.indexOf('await this.settings.initialize()');
  const syntaxServer = app.indexOf('await this.startNsh()', initialize);
  const window = app.indexOf('this.window.create()', syntaxServer);
  assert.ok(initialize !== -1 && initialize < syntaxServer && syntaxServer < window);
});

test('renderer settings validate their cache and persist through explicit IPC', async () => {
  const { loadGlobal } = require('./helpers/runtime');
  const writes = [];
  const bindings = [{ action: 'save' }, { action: 'quick_open' }];
  const globals = loadGlobal('src/config/Settings.js',
    '[SETTINGS_INITIALIZE, SETTINGS_GET, SETTINGS_SET]', {
      window: { api: { setSetting: async (...args) => { writes.push(args); return true; } } },
      USERCONFIG_KEYBINDING: bindings,
    });
  const [initialize, get, set] = globals;
  initialize({
    editor: { tabWidth: 5 }, files: { autoSave: true },
    keybindings: { save: 'Mod+Alt+S', quick_open: 'Mod+K' },
  });
  assert.equal(get('editor.tabWidth'), 5);
  assert.equal(get('files.autoSave'), true);
  assert.equal(get('keybindings.save'), 'Mod+Alt+S');
  assert.deepEqual(bindings.map((binding) => binding.key), ['Mod+Alt+S', 'Mod+K']);
  assert.equal(await set('editor.tabWidth', 3), true);
  assert.equal(get('editor.tabWidth'), 3);
  assert.deepEqual(writes, [['editor.tabWidth', 3]]);
  initialize({ editor: { tabWidth: 99 }, files: { autoSave: 'yes' } });
  assert.equal(get('editor.tabWidth'), 2);
  assert.equal(get('files.autoSave'), false);
});
