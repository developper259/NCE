const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
test('real Electron: preload, editing, Save As, quit and session restore', { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nce-electron-'));
  await fs.writeFile(path.join(directory, '.nce-smoke'), '');
  async function launch(phase) {
    await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [path.join(__dirname, 'driver.cjs'), directory, phase], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 90000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Electron ${phase} ${code}/${signal}: ${log}`)); });
    });
    try {
      assert.equal(await fs.readFile(path.join(directory, `${phase}.ok`), 'utf8'), 'ok');
    } catch (error) {
      throw Error(`Electron ${phase} exited without its completion marker: ${log}`, { cause: error });
    }
  }
  try {
    await launch('write');
    const sessionStore = JSON.parse(await fs.readFile(
      path.join(directory, 'profile', 'window-sessions.json'), 'utf8',
    ));
    const state = sessionStore.sessions
      .map(session => session.rendererState)
      .find(rendererState => rendererState?.noWorkspaceState?.tabManager?.tabs?.length);
    assert.equal(sessionStore.version, 1);
    assert.ok(state, 'the window session contains the restored renderer state');
    assert.equal(state.noWorkspaceState.tabManager.tabs.length, 1);
    assert.equal(state.noWorkspaceState.tabManager.tabs[0].type, 'file');
    assert.equal(state.noWorkspaceState.tabManager.tabs[0].path, path.join(directory, 'smoke.js'));
    assert.equal(state.noWorkspaceState.sidebar.rightActiveMenuId, 'agent');
    const workspaceTerminalState = JSON.parse(await fs.readFile(
      path.join(directory, 'terminal-workspace-a', '.nce', 'workspace.json'), 'utf8',
    ));
    assert.equal(workspaceTerminalState.version, 2);
    assert.equal(workspaceTerminalState.bottomPanel.visible, true);
    assert.equal(workspaceTerminalState.bottomPanel.terminal.tabs.length, 2);
    assert.equal(
      workspaceTerminalState.bottomPanel.terminal.tabs.some(tab => tab.customLabel === 'Workspace A Dev'),
      true,
      'workspace state persists a custom terminal label',
    );
    assert.doesNotMatch(
      JSON.stringify(workspaceTerminalState.bottomPanel),
      /sessionId|ptyId|command|stdout|stderr|NCE_PTY_FIRST|NCE_LONG_PROCESS_READY/,
      'workspace state stores no process IDs, commands, output, or process state',
    );
    await launch('reload');
    await launch('restore');
    await launch('crash');
    await launch('no-nsh');
    await launch('tabs');
    await launch('multiwindow');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
