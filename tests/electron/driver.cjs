const { app, dialog, Menu, screen, session } = require("electron");
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

        const sidebarOriginalBounds = win.getBounds();
        const sidebarWasMaximized = win.isMaximized();
        const readSidebarLayout = () => run(`(() => {
          const sidebarManager = editor.sidebarManager;
          const fileManager = document.querySelector(".file-manager");
          const editorElement = document.querySelector(".editor");
          const mainSection = document.querySelector(".main-section");
          const list = document.querySelector(".file-manager .files-ul");
          const tabScroller = editor.tabManager.tabScroller;
          const scroller = tabScroller.hScroller;
          const leftSidebar = document.querySelector(".sidebar-left");
          const rightSidebar = document.querySelector(".sidebar-right");
          const proportion = scroller.calculProp();
          const hasMeasurableRatio = list.scrollWidth > 0 && list.clientWidth > 0;
          return {
            mainWidth: mainSection.clientWidth,
            minEditorWidth: sidebarManager.constructor.MIN_EDITOR_CONTENT_WIDTH,
            editorLeft: editorElement.getBoundingClientRect().left - mainSection.getBoundingClientRect().left,
            editorRight: mainSection.getBoundingClientRect().right - editorElement.getBoundingClientRect().right,
            editorWidth: editorElement.clientWidth,
            fileLeft: fileManager.getBoundingClientRect().left - mainSection.getBoundingClientRect().left,
            fileRight: mainSection.getBoundingClientRect().right - fileManager.getBoundingClientRect().right,
            fileWidth: fileManager.clientWidth,
            inlineLeft: fileManager.style.left,
            inlineRight: fileManager.style.right,
            inlineWidth: fileManager.style.width,
            listWidth: list.clientWidth,
            leftOpen: leftSidebar.classList.contains("open"),
            rightOpen: rightSidebar.classList.contains("open"),
            leftWidth: leftSidebar.getBoundingClientRect().width,
            rightWidth: rightSidebar.getBoundingClientRect().width,
            effectiveLeftWidth: leftSidebar.classList.contains("open")
              ? leftSidebar.getBoundingClientRect().width : 0,
            effectiveRightWidth: rightSidebar.classList.contains("open")
              ? rightSidebar.getBoundingClientRect().width : 0,
            nodesPreserved: window.__tabScrollerTestNodes.every(
              (node, index) => list.children[index] === node,
            ),
            overflow: list.scrollWidth > list.clientWidth,
            proportion,
            expectedProportion: hasMeasurableRatio
              ? (list.clientWidth / list.scrollWidth) * 100 : null,
            tabScrollerWidth: tabScroller.clientWidth,
            thumbWidth: scroller.itemOBJWidth,
            expectedThumbWidth: Math.max(
              scroller.scrollerOBJWidth * (proportion / 100),
              20,
            ),
            trackWidth: scroller.scrollerOBJWidth,
          };
        })()`);
        const waitForSidebarLayout = async (description) => {
          await waitForCondition(async () => {
            const state = await readSidebarLayout();
            return (
              Math.abs(state.mainWidth - win.getContentBounds().width) <= 1 &&
              state.fileWidth >= state.minEditorWidth &&
              state.listWidth > 0 &&
              state.trackWidth > 0 &&
              Math.abs(state.listWidth - state.trackWidth) < 1
            );
          }, { timeout: 5000, description });
          return readSidebarLayout();
        };
        const setSidebarTestWindowWidth = async (width, description) => {
          if (win.isMaximized()) {
            win.unmaximize();
            await waitForCondition(
              () => !win.isMaximized(),
              { description: `${description}: window to unmaximize` },
            );
          }
          const bounds = win.getBounds();
          const workArea = screen.getDisplayMatching(bounds).workArea;
          win.setBounds({ ...bounds, x: workArea.x, width });
          await waitForCondition(
            () => !win.isMaximized() && win.getBounds().width === width,
            { timeout: 5000, description: `${description}: BrowserWindow width ${width}` },
          );
          return waitForSidebarLayout(`${description}: renderer layout to settle`);
        };
        const restoreSidebarTestWindow = async () => {
          if (sidebarWasMaximized) {
            if (!win.isMaximized()) win.maximize();
            await waitForCondition(
              () => win.isMaximized(),
              { description: "BrowserWindow to restore maximized state" },
            );
          } else {
            if (win.isMaximized()) {
              win.unmaximize();
              await waitForCondition(
                () => !win.isMaximized(),
                { description: "BrowserWindow to unmaximize before restoring bounds" },
              );
            }
            win.setBounds(sidebarOriginalBounds);
            await waitForCondition(
              () => {
                const bounds = win.getBounds();
                return bounds.x === sidebarOriginalBounds.x &&
                  bounds.y === sidebarOriginalBounds.y &&
                  bounds.width === sidebarOriginalBounds.width &&
                  bounds.height === sidebarOriginalBounds.height;
              },
              { description: "BrowserWindow to restore original bounds" },
            );
          }
          await waitForSidebarLayout("renderer layout to follow restored window bounds");
        };

        let sidebarLayoutStates;
        let narrowSidebarLayout;
        let narrowLeftResize;
        let narrowRightResize;
        let expandedSidebarLayout;
        let restoredSidebarLayout;
        try {
          if (sidebarWasMaximized) {
            win.unmaximize();
            await waitForCondition(
              () => !win.isMaximized(),
              { description: "BrowserWindow to unmaximize for sidebar layout test" },
            );
          }
          const wideLayout = await setSidebarTestWindowWidth(
            1400,
            "wide sidebar layout",
          );
          assert.ok(
            wideLayout.mainWidth >= 48 + 400 + 420 + wideLayout.minEditorWidth,
            `Controlled sidebar test width is insufficient: ${JSON.stringify(wideLayout)}`,
          );

          sidebarLayoutStates = await run(`(async () => {
          const sidebarManager = editor.sidebarManager;
          const sidebarResizer = editor.sidebarResizer;
          const nextLayout = async () => {
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
          };
          const snapshot = () => {
            const sidebarManager = editor.sidebarManager;
            const fileManager = document.querySelector(".file-manager");
            const editorElement = document.querySelector(".editor");
            const mainSection = document.querySelector(".main-section");
            const list = document.querySelector(".file-manager .files-ul");
            const tabScroller = editor.tabManager.tabScroller;
            const scroller = tabScroller.hScroller;
            const leftSidebar = document.querySelector(".sidebar-left");
            const rightSidebar = document.querySelector(".sidebar-right");
            const proportion = scroller.calculProp();
            const hasMeasurableRatio = list.scrollWidth > 0 && list.clientWidth > 0;
            return {
              mainWidth: mainSection.clientWidth,
              minEditorWidth: sidebarManager.constructor.MIN_EDITOR_CONTENT_WIDTH,
              editorLeft: editorElement.getBoundingClientRect().left - mainSection.getBoundingClientRect().left,
              editorRight: mainSection.getBoundingClientRect().right - editorElement.getBoundingClientRect().right,
              editorWidth: editorElement.clientWidth,
              fileLeft: fileManager.getBoundingClientRect().left - mainSection.getBoundingClientRect().left,
              fileRight: mainSection.getBoundingClientRect().right - fileManager.getBoundingClientRect().right,
              fileWidth: fileManager.clientWidth,
              inlineLeft: fileManager.style.left,
              inlineRight: fileManager.style.right,
              inlineWidth: fileManager.style.width,
              listWidth: list.clientWidth,
              leftOpen: leftSidebar.classList.contains("open"),
              rightOpen: rightSidebar.classList.contains("open"),
              leftWidth: leftSidebar.getBoundingClientRect().width,
              rightWidth: rightSidebar.getBoundingClientRect().width,
              effectiveLeftWidth: leftSidebar.classList.contains("open")
                ? leftSidebar.getBoundingClientRect().width : 0,
              effectiveRightWidth: rightSidebar.classList.contains("open")
                ? rightSidebar.getBoundingClientRect().width : 0,
              nodesPreserved: window.__tabScrollerTestNodes.every(
                (node, index) => list.children[index] === node,
              ),
              overflow: list.scrollWidth > list.clientWidth,
              proportion,
              expectedProportion: hasMeasurableRatio
                ? (list.clientWidth / list.scrollWidth) * 100 : null,
              tabScrollerWidth: tabScroller.clientWidth,
              thumbWidth: scroller.itemOBJWidth,
              expectedThumbWidth: Math.max(
                scroller.scrollerOBJWidth * (proportion / 100),
                20,
              ),
              trackWidth: scroller.scrollerOBJWidth,
            };
          };

          sidebarManager.closeSidebar("left");
          sidebarManager.closeSidebar("right");
          await nextLayout();
          sidebarResizer.applyWidth(300, "left");
          sidebarResizer.applyWidth(250, "right");
          await nextLayout();
          const none = snapshot();

          sidebarManager.openSidebar("left");
          await nextLayout();
          const left = snapshot();

          sidebarManager.closeSidebar("left");
          await nextLayout();
          sidebarManager.openSidebar("right");
          await nextLayout();
          const right = snapshot();

          sidebarManager.openSidebar("left");
          await nextLayout();
          const both = snapshot();

          sidebarResizer.applyWidth(400, "left");
          await nextLayout();
          const resizedLeft = snapshot();

          sidebarResizer.applyWidth(420, "right");
          await nextLayout();
          const resizedRight = snapshot();

          return { none, left, right, both, resizedLeft, resizedRight };
        })()`);
        const assertSidebarLayout = (state) => {
          const closeTo = (actual, expected, tolerance = 1) =>
            Math.abs(actual - expected) <= tolerance;
          const left = 48 + state.effectiveLeftWidth;
          const right = state.effectiveRightWidth;
          assert.ok(state.fileWidth >= state.minEditorWidth, JSON.stringify(state));
          assert.ok(state.editorWidth >= state.minEditorWidth, JSON.stringify(state));
          assert.ok(state.listWidth >= state.minEditorWidth, JSON.stringify(state));
          assert.ok(state.listWidth > 0, JSON.stringify(state));
          assert.ok(closeTo(state.fileLeft, left), JSON.stringify(state));
          assert.ok(closeTo(state.fileRight, right), JSON.stringify(state));
          assert.ok(closeTo(state.editorLeft, left), JSON.stringify(state));
          assert.ok(closeTo(state.editorRight, right), JSON.stringify(state));
          assert.ok(closeTo(Number.parseFloat(state.inlineLeft), left), JSON.stringify(state));
          assert.ok(closeTo(Number.parseFloat(state.inlineRight), right), JSON.stringify(state));
          assert.equal(state.inlineWidth, "");
          assert.ok(closeTo(state.fileWidth, state.listWidth), JSON.stringify(state));
          assert.ok(closeTo(state.listWidth, state.tabScrollerWidth), JSON.stringify(state));
          assert.ok(closeTo(state.fileWidth, state.editorWidth), JSON.stringify(state));
          assert.ok(closeTo(state.fileWidth, state.trackWidth), JSON.stringify(state));
          if (state.listWidth > 0 && state.expectedProportion !== null) {
            assert.ok(closeTo(state.proportion, state.expectedProportion, 0.01), JSON.stringify(state));
          }
          assert.ok(
            closeTo(state.thumbWidth, state.expectedThumbWidth, 1),
            JSON.stringify(state),
          );
          assert.equal(state.overflow, true);
          assert.equal(state.nodesPreserved, true);
        };
        for (const state of Object.values(sidebarLayoutStates)) {
          assertSidebarLayout(state);
        }
        assert.equal(sidebarLayoutStates.none.effectiveLeftWidth, 0);
        assert.equal(sidebarLayoutStates.none.effectiveRightWidth, 0);
        assert.equal(sidebarLayoutStates.left.effectiveLeftWidth, 300);
        assert.equal(sidebarLayoutStates.left.effectiveRightWidth, 0);
        assert.equal(sidebarLayoutStates.right.effectiveLeftWidth, 0);
        assert.equal(sidebarLayoutStates.right.effectiveRightWidth, 250);
        assert.equal(sidebarLayoutStates.resizedLeft.effectiveLeftWidth, 400);
        assert.equal(sidebarLayoutStates.resizedLeft.effectiveRightWidth, 250);
        assert.equal(sidebarLayoutStates.resizedRight.effectiveLeftWidth, 400);
        assert.equal(sidebarLayoutStates.resizedRight.effectiveRightWidth, 420);

        const narrowViewport = await setSidebarTestWindowWidth(
          800,
          "narrow sidebar layout",
        );
        narrowSidebarLayout = await waitForSidebarLayout(
          "sidebars to clamp at minimum window width",
        );
        assertSidebarLayout(narrowSidebarLayout);
        assert.ok(
          narrowSidebarLayout.effectiveLeftWidth + narrowSidebarLayout.effectiveRightWidth <=
            narrowViewport.mainWidth - 48 - narrowSidebarLayout.minEditorWidth + 1,
          JSON.stringify(narrowSidebarLayout),
        );
        assert.ok(
          narrowSidebarLayout.effectiveLeftWidth < 400 ||
            narrowSidebarLayout.effectiveRightWidth < 420,
          JSON.stringify(narrowSidebarLayout),
        );

        const requestedRightBeforeLeftResize = narrowSidebarLayout.effectiveRightWidth;
        await run("editor.sidebarResizer.applyWidth(500, 'left')");
        narrowLeftResize = await waitForSidebarLayout(
          "left sidebar resize to preserve the open right sidebar",
        );
        assertSidebarLayout(narrowLeftResize);
        assert.ok(narrowLeftResize.effectiveLeftWidth <=
          narrowLeftResize.mainWidth - 48 - requestedRightBeforeLeftResize -
            narrowLeftResize.minEditorWidth + 1);
        assert.ok(Math.abs(
          narrowLeftResize.effectiveRightWidth - requestedRightBeforeLeftResize,
        ) < 1);

        const requestedLeftBeforeRightResize = narrowLeftResize.effectiveLeftWidth;
        await run("editor.sidebarResizer.applyWidth(500, 'right')");
        narrowRightResize = await waitForSidebarLayout(
          "right sidebar resize to preserve the open left sidebar",
        );
        assertSidebarLayout(narrowRightResize);
        assert.ok(narrowRightResize.effectiveRightWidth <=
          narrowRightResize.mainWidth - 48 - requestedLeftBeforeRightResize -
            narrowRightResize.minEditorWidth + 1);
        assert.ok(Math.abs(
          narrowRightResize.effectiveLeftWidth - requestedLeftBeforeRightResize,
        ) < 1);

        await run(`(async () => {
          editor.sidebarResizer.applyWidth(400, "left");
          editor.sidebarResizer.applyWidth(420, "right");
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        })()`);
        await setSidebarTestWindowWidth(1400, "expanded sidebar layout");
        expandedSidebarLayout = await waitForSidebarLayout(
          "sidebars to restore requested widths after window expand",
        );
        assertSidebarLayout(expandedSidebarLayout);
        assert.equal(expandedSidebarLayout.effectiveLeftWidth, 400);
        assert.equal(expandedSidebarLayout.effectiveRightWidth, 420);

        const sidebarScreenshotPath = process.env.NCE_SIDEBAR_SCREENSHOT_PATH;
        if (sidebarScreenshotPath) {
          fs.writeFileSync(sidebarScreenshotPath, (await win.capturePage()).toPNG());
        }
        restoredSidebarLayout = await run(`(async () => {
          editor.sidebarManager.closeSidebar("left");
          editor.sidebarManager.closeSidebar("right");
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const fileManager = document.querySelector(".file-manager");
          const mainSection = document.querySelector(".main-section");
          const list = document.querySelector(".file-manager .files-ul");
          return {
            left: fileManager.style.left,
            right: fileManager.style.right,
            width: list.clientWidth,
            expectedWidth: mainSection.clientWidth - 48,
            minEditorWidth: editor.sidebarManager.constructor.MIN_EDITOR_CONTENT_WIDTH,
            nodesPreserved: window.__tabScrollerTestNodes.every(
              (node, index) => list.children[index] === node,
            ),
          };
        })()`);
        assert.equal(restoredSidebarLayout.left, "48px");
        assert.equal(restoredSidebarLayout.right, "0px");
        assert.ok(restoredSidebarLayout.width >= restoredSidebarLayout.minEditorWidth);
        assert.ok(Math.abs(restoredSidebarLayout.width - restoredSidebarLayout.expectedWidth) <= 1);
        assert.equal(restoredSidebarLayout.nodesPreserved, true);
        } finally {
          await restoreSidebarTestWindow();
        }

        const thumbCenterOffset = tabScrollState.thumbWidth / 2;
        const dragY = Math.round(tabScrollState.thumbTop + tabScrollState.thumbHeight / 2);
        const thumbCenterX = Math.round(tabScrollState.thumbLeft + thumbCenterOffset);
        win.focus();
        win.webContents.sendInputEvent({
          type: "mouseMove",
          x: thumbCenterX,
          y: dragY,
        });
        win.webContents.sendInputEvent({
          type: "mouseDown",
          x: thumbCenterX,
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
        win.webContents.sendInputEvent({
          type: "mouseUp",
          x: thumbCenterX,
          y: dragY,
          button: "left",
        });

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

        const wheelDispatch = await run(`(() => {
          const scroller = editor.tabManager.tabScroller.hScroller;
          const event = new WheelEvent("wheel", {
            deltaX: 120,
            deltaY: 0,
            bubbles: true,
            cancelable: true,
          });
          scroller.itemOBJ.dispatchEvent(event);
          return {
            prevented: event.defaultPrevented,
            ratio: scroller.scrollRatio,
            targetRatio: scroller.targetScrollRatio,
          };
        })()`);
        assert.equal(wheelDispatch.prevented, true);
        assert.ok(
          wheelDispatch.targetRatio > wheelDispatch.ratio,
          `The tab scroller did not accept its wheel delta: ${JSON.stringify(wheelDispatch)}`,
        );
        await waitForCondition(
          async () =>
            (await run("editor.tabManager.tabScroller.hScroller.targetScrollRatio")) >
            wheelDispatch.ratio,
          {
            timeout: 3000,
            description: "a wheel event over the tab thumb to reach its scroller",
          },
        );
        await waitForCondition(
          async () =>
            Math.abs(
              (await run("editor.tabManager.tabScroller.hScroller.scrollRatio")) -
                wheelDispatch.ratio,
            ) > 0.02,
          {
            timeout: 3000,
            description: "the tab scroller to render its wheel movement",
          },
        );
        assert.ok(
          (await run('document.querySelector(".file-manager .files-ul").scrollLeft')) > 0,
        );

        const wasMaximized = win.isMaximized();
        const originalBounds = win.getBounds();
        const readResizeState = () => run(`(() => {
          const fileManager = document.querySelector(".file-manager");
          const list = document.querySelector(".file-manager .files-ul");
          const scroller = editor.tabManager.tabScroller.hScroller;
          const maxScroll = list.scrollWidth - list.clientWidth;
          const proportion = scroller.calculProp();
          const expectedThumbWidth = Math.max(
            scroller.scrollerOBJWidth * (proportion / 100),
            20,
          );
          return {
            innerWidth: window.innerWidth,
            documentWidth: document.documentElement.clientWidth,
            fileManagerWidth: fileManager.clientWidth,
            listWidth: list.clientWidth,
            scrollWidth: list.scrollWidth,
            trackWidth: scroller.scrollerOBJWidth,
            trackDOMWidth: scroller.scrollerOBJ.clientWidth,
            thumbWidth: scroller.itemOBJWidth,
            thumbDOMWidth: scroller.itemOBJ.clientWidth,
            proportion,
            expectedProportion: list.scrollWidth > 0
              ? (list.clientWidth / list.scrollWidth) * 100
              : 100,
            expectedThumbWidth,
            ratio: scroller.scrollRatio,
            expectedRatio: maxScroll > 0 ? list.scrollLeft / maxScroll : 0,
            scrollLeft: list.scrollLeft,
          };
        })()`);
        const readWindowState = () => ({
          isMaximized: win.isMaximized(),
          size: win.getSize(),
          bounds: win.getBounds(),
          contentBounds: win.getContentBounds(),
        });
        const waitForResizeStep = async (check, description) => {
          try {
            await waitForCondition(check, {
              timeout: 5000,
              description,
            });
          } catch (error) {
            let rendererState;
            try {
              rendererState = await readResizeState();
            } catch (readError) {
              rendererState = { readError: readError.message };
            }
            throw new Error(
              `${error.message}; BrowserWindow=${JSON.stringify(readWindowState())}; renderer=${JSON.stringify(rendererState)}`,
              { cause: error },
            );
          }
        };
        const waitForStableBounds = async (
          description,
          expectedMaximized = false,
        ) => {
          let previousBounds = null;
          let stableSamples = 0;
          await waitForResizeStep(() => {
            if (win.isMaximized() !== expectedMaximized) {
              previousBounds = null;
              stableSamples = 0;
              return false;
            }
            const bounds = win.getBounds();
            if (
              previousBounds &&
              bounds.x === previousBounds.x &&
              bounds.y === previousBounds.y &&
              bounds.width === previousBounds.width &&
              bounds.height === previousBounds.height
            ) {
              stableSamples += 1;
            } else {
              stableSamples = 0;
            }
            previousBounds = bounds;
            return stableSamples >= 2;
          }, description);
        };
        const waitForRendererResize = async (
          previousState,
          description,
          expectChange = true,
        ) => {
          const steps = [
            [
              "renderer viewport width",
              (state) =>
                Math.abs(state.innerWidth - win.getContentBounds().width) <= 1 &&
                (!expectChange || state.innerWidth !== previousState.innerWidth),
            ],
            [
              "document client width",
              (state) =>
                state.documentWidth > 0 &&
                (!expectChange || state.documentWidth !== previousState.documentWidth),
            ],
            [
              "file manager client width",
              (state) =>
                state.fileManagerWidth > 0 &&
                (!expectChange || state.fileManagerWidth !== previousState.fileManagerWidth),
            ],
            [
              "tab list client width",
              (state) =>
                state.listWidth > 0 &&
                (!expectChange || state.listWidth !== previousState.listWidth),
            ],
            [
              "tab scroller track width",
              (state) =>
                state.trackWidth > 0 &&
                (!expectChange || state.trackWidth !== previousState.trackWidth),
            ],
            [
              "tab scroller thumb geometry",
              (state) =>
                Math.abs(state.trackWidth - state.trackDOMWidth) < 1 &&
                Math.abs(state.proportion - state.expectedProportion) < 1 &&
                Math.abs(state.thumbWidth - state.expectedThumbWidth) < 2 &&
                Math.abs(state.thumbDOMWidth - state.expectedThumbWidth) < 2 &&
                Math.abs(state.ratio - state.expectedRatio) < 0.04,
            ],
          ];
          for (const [step, check] of steps) {
            await waitForResizeStep(
              async () => check(await readResizeState()),
              `${description}: ${step}`,
            );
          }
          return readResizeState();
        };
        const setWindowWidth = async (width, description) => {
          const bounds = win.getBounds();
          const workArea = screen.getDisplayMatching(bounds).workArea;
          const rightmostX = workArea.x + workArea.width - width;
          const x = Math.max(workArea.x, Math.min(bounds.x, rightmostX));
          const expectedChange = win.getSize()[0] !== width;
          win.setBounds({ ...bounds, x, width });
          await waitForResizeStep(
            () => !win.isMaximized() && win.getSize()[0] === width,
            `${description}: BrowserWindow width to become ${width}`,
          );
          return expectedChange;
        };

        const beforeUnmaximize = await readResizeState();
        try {
          if (wasMaximized) {
            win.unmaximize();
            await waitForResizeStep(
              () => !win.isMaximized(),
              "BrowserWindow to leave maximized state",
            );
            await waitForStableBounds("restored BrowserWindow bounds to settle");
            await waitForRendererResize(
              beforeUnmaximize,
              "renderer layout to follow unmaximize",
            );
          }

          const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
          const expandedWidth = Math.min(1050, workArea.width);
          const baselineWidth = Math.min(900, expandedWidth - 150);
          const shrunkWidth = Math.max(801, baselineWidth - 50);
          assert.ok(
            baselineWidth > 800 &&
              shrunkWidth < baselineWidth &&
              expandedWidth > baselineWidth,
            `Display work area is too narrow for three distinct resize states: ${JSON.stringify({
              workArea,
              baselineWidth,
              expandedWidth,
              shrunkWidth,
            })}`,
          );

          const beforeBaseline = await readResizeState();
          const baselineChanged = await setWindowWidth(
            baselineWidth,
            "baseline resize",
          );
          const baseline = await waitForRendererResize(
            beforeBaseline,
            "tab scroller to settle at baseline width",
            baselineChanged,
          );
          assert.equal(win.getSize()[0], baselineWidth);
          assert.ok(baseline.listWidth > 0);

          const expandFrom = baseline;
          const expandedChanged = await setWindowWidth(
            expandedWidth,
            "expanded resize",
          );
          assert.ok(expandedChanged, "expanded BrowserWindow width must change");
          const afterExpand = await waitForRendererResize(
            expandFrom,
            "tab scroller to grow after expand",
          );
          assert.ok(afterExpand.innerWidth > baseline.innerWidth);
          assert.ok(afterExpand.listWidth > baseline.listWidth);
          assert.ok(afterExpand.trackWidth > baseline.trackWidth);
          assert.ok(afterExpand.proportion > baseline.proportion);
          assert.equal(afterExpand.scrollLeft, baseline.scrollLeft);

          const shrinkFrom = afterExpand;
          const shrunkChanged = await setWindowWidth(
            shrunkWidth,
            "shrunk resize",
          );
          assert.ok(shrunkChanged, "shrunk BrowserWindow width must change");
          const afterShrink = await waitForRendererResize(
            shrinkFrom,
            "tab scroller to shrink after expand",
          );
          assert.ok(afterShrink.innerWidth < afterExpand.innerWidth);
          assert.ok(afterShrink.listWidth < afterExpand.listWidth);
          assert.ok(afterShrink.trackWidth < afterExpand.trackWidth);
          assert.ok(afterShrink.proportion < afterExpand.proportion);
          assert.equal(afterShrink.scrollLeft, baseline.scrollLeft);
        } finally {
          if (wasMaximized) {
            const beforeRestore = await readResizeState();
            if (!win.isMaximized()) win.maximize();
            await waitForResizeStep(
              () => win.isMaximized(),
              "BrowserWindow to return to its original maximized state",
            );
            await waitForStableBounds(
              "maximized BrowserWindow bounds to settle",
              true,
            );
            await waitForRendererResize(
              beforeRestore,
              "renderer layout to follow restored maximize",
            );
          } else {
            const beforeRestore = await readResizeState();
            const restoreChangesWidth =
              win.getSize()[0] !== originalBounds.width;
            if (win.isMaximized()) {
              win.unmaximize();
              await waitForResizeStep(
                () => !win.isMaximized(),
                "BrowserWindow to leave maximized state before restoring bounds",
              );
            }
            win.setBounds(originalBounds);
            await waitForResizeStep(
              () =>
                !win.isMaximized() &&
                win.getBounds().x === originalBounds.x &&
                win.getBounds().y === originalBounds.y &&
                win.getBounds().width === originalBounds.width &&
                win.getBounds().height === originalBounds.height,
              "BrowserWindow to return to its original bounds",
            );
            await waitForStableBounds("original BrowserWindow bounds to settle");
            await waitForRendererResize(
              beforeRestore,
              "renderer layout to follow restored bounds",
              restoreChangesWidth,
            );
          }
        }

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
