const { app, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [directory, phase] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory) || !fs.existsSync(path.join(directory, '.nce-smoke'))) throw Error('Temporary smoke directory required');
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'session'));
app.disableHardwareAcceleration();
const target = path.join(directory, 'smoke.js');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
dialog.showMessageBox = async () => ({ response: 2 });
const timer = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 30000);
const { App } = require('../../dist/ts/App.js');
const nce = new App();
if (phase === "no-nsh") nce.nsh.start = async () => { throw Error("Injected NSH startup failure"); };
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const local = /^(file:|devtools:|ws:\/\/127\.0\.0\.1:)/.test(details.url);
    done({ cancel: !local });
  });
  const waitWindow = setInterval(async () => {
    const win = nce.window.window;
    if (!win || !nce.window.rendererReady) return;
    clearInterval(waitWindow);
    try {
      const run = (code) => win.webContents.executeJavaScript(code);
      assert.equal(await run('Boolean(window.api && editor && document.querySelector(".file-manager"))'), true);
      assert.equal(win.isVisible(), true);
      const prefs = win.webContents.getLastWebPreferences();
      assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
      assert.equal(win.webContents.isDevToolsOpened(), false);
      assert.equal(await nce.window.executeWindowCommand('view.devtools'), false);
      const quickOpenModifier = process.platform === 'darwin' ? 'meta' : 'control';
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: [quickOpenModifier] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: [quickOpenModifier] });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(await run('editor.quickPanel.isOpen("quick-open")'), true);
      assert.equal(await run('document.querySelector(".quick-panel-empty").textContent'), 'Open a project first.');
      assert.equal(await run('document.activeElement === document.querySelector(".quick-panel-input")'), true);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      assert.equal(await run('editor.quickPanel.isOpen("quick-open")'), false);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'G', modifiers: [quickOpenModifier] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'G', modifiers: [quickOpenModifier] });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(await run('editor.quickPanel.isOpen("go-to-line")'), true);
      assert.equal(await run('document.querySelector(".quick-panel-empty").textContent'), 'No file open.');
      assert.equal(await run('document.activeElement === document.querySelector(".quick-panel-input")'), true);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      assert.equal(await run('editor.quickPanel.isOpen("go-to-line")'), false);
      await run('window.__nceReloadGuard = true');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await run('window.__nceReloadGuard === true'), true);
      if (phase === 'write') {
        await run(`(${require('./ui.cjs').toString()})()`);
        await run(`(async () => {
          const file = editor.tabManager.createEmptyFile();
          await editor.tabManager.setFocusFile(file);
          editor.writerController.write('const value = 1;');
          await editor.historyController.undo();
          if (file.serializeContent() !== '') throw Error('Undo failed');
          await editor.historyController.redo();
          if (file.serializeContent() !== 'const value = 1;') throw Error('Redo failed');
          if (!(await file.saveAs())) throw Error('Save As failed');
          return true;
        })()`);
        assert.equal(fs.readFileSync(target, 'utf8'), 'const value = 1;');
      } else {
        // State loading is asynchronous after the preload handshake.
        await run(`(async () => {
          const deadline = Date.now() + 10000;
          while (!editor.tabManager.activeFile?.isLoaded && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 20));
          if (editor.tabManager.activeFile?.path !== ${JSON.stringify(target)}) throw Error('Session path not restored');
          if (editor.tabManager.activeFile.serializeContent() !== 'const value = 1;') throw Error('Session text not restored');
          return true;
        })()`);
      }
      fs.writeFileSync(path.join(directory, `${phase}.ok`), 'ok');
      if (phase === 'crash') {
        win.webContents.once('render-process-gone', () => nce.window.requestQuit());
        win.webContents.forcefullyCrashRenderer();
      } else nce.window.requestQuit();
    } catch (error) { console.error(error); app.exit(1); }
  }, 20);
});
app.on('will-quit', () => clearTimeout(timer));
