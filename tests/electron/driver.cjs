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
      // The main-process preload handshake can complete before asynchronous
      // session restoration, especially on Windows CI. Do not snapshot
      // activeFile or dispatch shortcuts while startup is still mutating it.
      await waitForCondition(
        async () => (await run("editor.isOnInit === false")) === true,
        {
          timeout: 10000,
          description: "editor session restoration to finish",
        },
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
      if (process.platform === "darwin") {
        const quickOpenMenuItem = findMenuItem(
          Menu.getApplicationMenu(),
          "Quick Open...",
        );
        assert.ok(
          quickOpenMenuItem,
          "Quick Open menu item should exist on macOS",
        );
        quickOpenMenuItem.click(undefined, win, undefined);
      } else {
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
      }
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
      if (process.platform === "darwin") {
        const goToLineMenuItem = findMenuItem(
          Menu.getApplicationMenu(),
          "Go to Line...",
        );
        if (hasActiveFile) {
          assert.ok(
            goToLineMenuItem,
            "Go to Line menu item should exist on macOS",
          );
          goToLineMenuItem.click(undefined, win, undefined);
        }
      } else {
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
      }
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
      } else if (phase === "tabs") {
        await waitForCondition(
          async () =>
            (await run("!editor.tabManager.activeFile || editor.tabManager.activeFile.isLoaded")) === true,
          { description: "the restored tab to load before exercising tab scrolling" },
        );
        const tabScrollState = await run(`(async () => {
          const manager = editor.tabManager;
          let file = manager.activeFile;
          if (!file) {
            file = manager.createEmptyFile();
            await manager.setFocusFile(file);
          }
          const tabs = [file, ...Array.from({ length: 28 }, (_, index) => ({
            id: 10000 + index,
            type: "settings",
            name: \`scroller tab \${String(index + 1).padStart(2, "0")}\`,
          }))];
          manager.tabs = tabs;
          manager.activeTab = file;
          manager.refresh();

          const list = document.querySelector(".file-manager .files-ul");
          const container = document.querySelector(".file-manager");
          const tabScroller = manager.tabScroller;
          const scroller = tabScroller?.hScroller;
          if (!list || !container || !scroller) throw Error("Tab scroller did not initialize");
          if (list.scrollWidth <= list.clientWidth) throw Error("Test tabs did not overflow the tab bar");
          if (!scroller.active || !scroller.scrollerFast.hasClass("page-scroller-compact")) {
            throw Error("NCE tab scroller is not active in compact mode");
          }

          const tabNodes = [...list.children];
          window.__tabScrollerTestNodes = tabNodes;
          const lastTab = tabNodes.at(-1);
          tabScroller.ensureElementVisible(lastTab);
          const listRect = list.getBoundingClientRect();
          const activeRect = lastTab.getBoundingClientRect();
          if (activeRect.left < listRect.left - 1 || activeRect.right > listRect.right + 1) {
            throw Error("ensureElementVisible did not reveal the target tab");
          }

          tabScroller.ensureElementVisible(tabNodes[0]);
          const trackRect = scroller.scrollerOBJ.getBoundingClientRect();
          const thumbRect = scroller.itemOBJ.getBoundingClientRect();
          return {
            visibleWidth: list.clientWidth,
            totalWidth: list.scrollWidth,
            compactHeight: getComputedStyle(scroller.scrollerOBJ).height,
            trackLeft: trackRect.left,
            trackWidth: trackRect.width,
            thumbLeft: thumbRect.left,
            thumbTop: thumbRect.top,
            thumbWidth: thumbRect.width,
            thumbHeight: thumbRect.height,
          };
        })()`);
        assert.ok(tabScrollState.totalWidth > tabScrollState.visibleWidth);
        assert.equal(tabScrollState.compactHeight, "6px");

        const dragRatio = 0.65;
        const thumbCenterOffset = tabScrollState.thumbWidth / 2;
        const dragY = Math.round(tabScrollState.thumbTop + tabScrollState.thumbHeight / 2);
        win.focus();
        win.webContents.sendInputEvent({
          type: "mouseMove",
          x: Math.round(tabScrollState.thumbLeft + thumbCenterOffset),
          y: dragY,
        });
        win.webContents.sendInputEvent({
          type: "mouseDown",
          x: Math.round(tabScrollState.thumbLeft + thumbCenterOffset),
          y: dragY,
          button: "left",
        });
        await waitForCondition(
          async () =>
            (await run("editor.tabManager.tabScroller.hScroller.isDragging")) === true,
          {
            timeout: 3000,
            description: "the tab scroller to begin a thumb drag",
          },
        );
        const dragOffset = await run(
          "editor.tabManager.tabScroller.hScroller.dragOffset",
        );
        const dragTargetX = Math.round(
          tabScrollState.trackLeft +
            (tabScrollState.trackWidth - tabScrollState.thumbWidth) * dragRatio +
            dragOffset,
        );
        win.webContents.sendInputEvent({
          type: "mouseMove",
          x: dragTargetX,
          y: dragY,
        });
        await waitForCondition(
          async () =>
            (await run("editor.tabManager.tabScroller.hScroller.targetScrollRatio")) > 0.6,
          {
            timeout: 3000,
            description: "the tab scroller to receive the thumb drag movement",
          },
        );
        win.webContents.sendInputEvent({
          type: "mouseUp",
          x: dragTargetX,
          y: dragY,
          button: "left",
        });
        await waitForCondition(
          async () =>
            Math.abs(
              (await run("editor.tabManager.tabScroller.hScroller.scrollRatio")) -
                dragRatio,
            ) < 0.04,
          {
            timeout: 5000,
            description: "the tab scroller thumb to drag to its target position",
          },
        );

        const tabScrollSync = await run(`(async () => {
          const manager = editor.tabManager;
          const tabScroller = manager.tabScroller;
          const list = document.querySelector(".file-manager .files-ul");
          const scroller = tabScroller.hScroller;
          const maxScroll = list.scrollWidth - list.clientWidth;
          list.scrollLeft = maxScroll * 0.25;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          if (Math.abs(scroller.scrollRatio - 0.25) > 0.04) {
            throw Error("Native tab-list scrolling did not synchronize the thumb");
          }
          if (window.__tabScrollerTestNodes.some((node, index) => list.children[index] !== node)) {
            throw Error("Scrolling replaced tab DOM nodes");
          }

          tabScroller.ensureElementVisible(window.__tabScrollerTestNodes[0]);
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return {
            thumbOpacity: scroller.scrollerOBJ.style.opacity,
            visibleWidth: list.clientWidth,
            totalWidth: list.scrollWidth,
          };
        })()`);
        assert.equal(tabScrollSync.thumbOpacity, "1");
        assert.ok(tabScrollSync.totalWidth > tabScrollSync.visibleWidth);

        const wheelPrevented = await run(`(() => {
          const list = document.querySelector(".file-manager .files-ul");
          const scroller = editor.tabManager.tabScroller.hScroller;
          const event = new WheelEvent("wheel", {
            deltaX: 120,
            deltaY: 0,
            bubbles: true,
            cancelable: true,
          });
          list.dispatchEvent(event);
          return {
            prevented: event.defaultPrevented,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            shiftKey: event.shiftKey,
            ratio: scroller.scrollRatio,
            targetRatio: scroller.targetScrollRatio,
            wheelDeltaHandler: typeof scroller.wheelDeltaHandler,
            horizontal: scroller.type === editor.scrollerManager.HORIZONTAL_TYPE,
          };
        })()`);
        assert.equal(wheelPrevented.prevented, true);
        assert.ok(
          wheelPrevented.targetRatio > 0,
          `The tab scroller did not accept its wheel delta: ${JSON.stringify(wheelPrevented)}`,
        );
        await waitForCondition(
          async () =>
            (await run("editor.tabManager.tabScroller.hScroller.scrollRatio")) > 0.02,
          {
            timeout: 3000,
            description: "horizontal wheel input to move the tab scroller",
          },
        );
        assert.ok(
          (await run('document.querySelector(".file-manager .files-ul").scrollLeft')) > 0,
        );

        const beforeResize = await run(`(() => {
          const list = document.querySelector(".file-manager .files-ul");
          const scroller = editor.tabManager.tabScroller.hScroller;
          return {
            listWidth: list.clientWidth,
            trackWidth: scroller.scrollerOBJWidth,
            scrollLeft: list.scrollLeft,
          };
        })()`);
        const originalSize = win.getSize();
        const narrowerWidth = Math.max(800, originalSize[0] - 160);
        win.setSize(narrowerWidth, originalSize[1]);
        await waitForCondition(
          async () =>
            (await run(
              `document.querySelector(".file-manager .files-ul").clientWidth < ${beforeResize.listWidth}`,
            )) === true,
          {
            timeout: 5000,
            description: "the tab viewport to resize with its window",
          },
        );
        const afterResize = await run(`(() => {
          const list = document.querySelector(".file-manager .files-ul");
          const scroller = editor.tabManager.tabScroller.hScroller;
          const maxScroll = list.scrollWidth - list.clientWidth;
          return {
            listWidth: list.clientWidth,
            trackWidth: scroller.scrollerOBJWidth,
            ratio: scroller.scrollRatio,
            expectedRatio: maxScroll > 0 ? list.scrollLeft / maxScroll : 0,
            scrollLeft: list.scrollLeft,
          };
        })()`);
        assert.ok(afterResize.listWidth < beforeResize.listWidth);
        assert.ok(afterResize.trackWidth < beforeResize.trackWidth);
        assert.equal(afterResize.scrollLeft, beforeResize.scrollLeft);
        assert.ok(Math.abs(afterResize.ratio - afterResize.expectedRatio) < 0.04);
        win.setSize(originalSize[0], originalSize[1]);

        const screenshotPath = process.env.NCE_SCROLLER_SCREENSHOT_PATH;
        if (screenshotPath) {
          fs.writeFileSync(screenshotPath, (await win.capturePage()).toPNG());
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
