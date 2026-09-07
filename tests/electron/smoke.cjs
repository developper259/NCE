const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
test('real Electron: preload, editing, Save As, quit and session restore', { timeout: 170000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nce-electron-'));
  await fs.writeFile(path.join(directory, '.nce-smoke'), '');
  async function launch(phase) {
    await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [path.join(__dirname, 'driver.cjs'), directory, phase], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 40000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Electron ${code}/${signal}: ${log}`)); });
    });
    assert.equal(await fs.readFile(path.join(directory, `${phase}.ok`), 'utf8'), 'ok');
  }
  try {
    await launch('write');
    const state = JSON.parse(await fs.readFile(path.join(directory, 'profile', 'state.json'), 'utf8'));
    assert.equal(state.tabManager.files.length, 1);
    await launch('restore');
    await launch('crash');
    await launch('no-nsh');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
