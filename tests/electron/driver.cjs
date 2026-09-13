const { app, dialog, Menu, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { waitForCondition } = require("./wait-for-condition.cjs");
const [directory, phase] = process.argv.slice(2);
if (
  !directory ||
  !path.isAbsolute(directory) ||
  !fs.existsSync(path.join(directory, ".nce-smoke"))
)
  throw Error("Temporary smoke directory required");
app.setPath("userData", path.join(directory, "profile"));
app.setPath("sessionData", path.join(directory, "session"));
app.disableHardwareAcceleration();
const target = path.join(directory, "smoke.js");
dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
dialog.showMessageBox = async () => ({ response: 2 });
const timer = setTimeout(() => {
  console.error("Electron smoke timed out");
  app.exit(1);
}, 30000);
const { App } = require("../../dist/ts/App.js");
const nce = new App();
function findMenuItem(menu, label) {
  for (const item of menu?.items || []) {
    if (item.label === label) return item;
    const nested = findMenuItem(item.submenu, label);
    if (nested) return nested;
  }
  return null;
}
if (phase === "no-nsh")
  nce.nsh.start = async () => {
    throw Error("Injected NSH startup failure");
  };
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
      assert.equal(
        await run(
          'Boolean(window.api && editor && document.querySelector(".file-manager"))',
        ),
        true,
      );
      assert.equal(win.isVisible(), true);
      const prefs = win.webContents.getLastWebPreferences();
      assert.equal(prefs.sandbox, true);
      assert.equal(prefs.contextIsolation, true);
      assert.equal(prefs.nodeIntegration, false);
      assert.equal(win.webContents.isDevToolsOpened(), false);
      assert.equal(
        await nce.window.executeWindowCommand("view.devtools"),
        false,
      );
      const quickOpenModifier =
        process.platform === "darwin" ? "meta" : "control";
      win.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "P",
        modifiers: [quickOpenModifier],
      });
      win.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "P",
        modifiers: [quickOpenModifier],
      });
      await waitForCondition(
        async () =>
          (await run('editor.quickPanel.isOpen("quick-open")')) === true,
        { description: "Quick Open to open after its shortcut" },
      );
      assert.equal(await run('editor.quickPanel.isOpen("quick-open")'), true);
      assert.equal(
        await run('document.querySelector(".quick-panel-empty").textContent'),
        "Open a project first.",
      );
      assert.equal(
        await run(
          'document.activeElement === document.querySelector(".quick-panel-input")',
        ),
        true,
      );
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await waitForCondition(
        async () =>
          (await run('editor.quickPanel.isOpen("quick-open")')) === false,
        { description: "Quick Open to close after Escape" },
      );
      assert.equal(await run('editor.quickPanel.isOpen("quick-open")'), false);
      const hasActiveFile = await run("Boolean(editor.tabManager.activeFile)");
      win.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "G",
        modifiers: [quickOpenModifier],
      });
      win.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "G",
        modifiers: [quickOpenModifier],
      });
      if (hasActiveFile) {
        await waitForCondition(
          async () =>
            (await run('editor.quickPanel.isOpen("go-to-line")')) === true,
          { description: "Go to Line to open from a file tab" },
        );
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await waitForCondition(
          async () =>
            (await run('editor.quickPanel.isOpen("go-to-line")')) === false,
          { description: "Go to Line to close after Escape" },
        );
      } else {
        assert.equal(
          await run('editor.quickPanel.isOpen("go-to-line")'),
          false,
        );
      }
      if (process.platform === "darwin") {
        await waitForCondition(
          async () =>
            findMenuItem(Menu.getApplicationMenu(), "Go to Line...").enabled ===
            hasActiveFile,
          { description: "native file actions to match the active tab" },
        );
      }
      assert.equal(
        await run(
          'CONFIG_KEYBINDING_GET_ACTION("reload_window")?.key === "Mod+R"',
        ),
        true,
      );
      if (phase === "write") {
        if (process.platform === "darwin") {
          assert.equal(
            await run(`(async () => {
            const result = await SETTINGS_SET("keybindings.open_command", "Mod+Alt+P");
            const input = document.createElement("input");
            input.id = "native-menu-keybinding-smoke";
            document.body.appendChild(input);
            input.focus();
            return result.success && document.activeElement === input;
          })()`),
            true,
          );

          const updatedCommand = findMenuItem(
            Menu.getApplicationMenu(),
            "Command Palette",
          );
          assert.equal(updatedCommand.accelerator, "CommandOrControl+Alt+P");
          assert.notEqual(
            updatedCommand.accelerator,
            "CommandOrControl+Shift+P",
          );
          updatedCommand.click(undefined, win, undefined);
          await waitForCondition(
            async () =>
              (await run('editor.quickPanel.isOpen("command-palette")')) ===
              true,
            {
              description:
                "Command Palette to open from its rebuilt native menu item",
            },
          );
          win.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "Escape",
          });
          win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
          await waitForCondition(
            async () =>
              (await run('editor.quickPanel.isOpen("command-palette")')) ===
              false,
            {
              description:
                "Command Palette to close before resetting its shortcut",
            },
          );

          assert.equal(
            await run(`(async () => {
            const result = await SETTINGS_SET("keybindings.open_command", "Mod+Shift+P");
            document.querySelector("#native-menu-keybinding-smoke")?.focus();
            return result.success;
          })()`),
            true,
          );
          const resetCommand = findMenuItem(
            Menu.getApplicationMenu(),
            "Command Palette",
          );
          assert.equal(resetCommand.accelerator, "CommandOrControl+Shift+P");
          resetCommand.click(undefined, win, undefined);
          await waitForCondition(
            async () =>
              (await run('editor.quickPanel.isOpen("command-palette")')) ===
              true,
            {
              description:
                "Command Palette to open with its reset native accelerator",
            },
          );
          win.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "Escape",
          });
          win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
          await waitForCondition(
            async () =>
              (await run('editor.quickPanel.isOpen("command-palette")')) ===
              false,
            {
              description:
                "Command Palette to close after native accelerator reset",
            },
          );
          await run(
            'document.querySelector("#native-menu-keybinding-smoke")?.remove()',
          );
        }
        await run(`(${require("./ui.cjs").toString()})()`);
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
        assert.equal(fs.readFileSync(target, "utf8"), "const value = 1;");
        if (process.platform === "darwin") {
          await waitForCondition(
            async () =>
              findMenuItem(Menu.getApplicationMenu(), "Go to Line...")
                .enabled === true,
            { description: "file menu actions to enable after opening a file" },
          );
        }
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
      fs.writeFileSync(path.join(directory, `${phase}.ok`), "ok");
      if (phase === "crash") {
        win.webContents.once("render-process-gone", () =>
          nce.window.requestQuit(),
        );
        win.webContents.forcefullyCrashRenderer();
      } else nce.window.requestQuit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  }, 20);
});
app.on("will-quit", () => clearTimeout(timer));
