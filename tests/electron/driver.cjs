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
      assert.deepEqual(await run(`(async () => ({
        trash: await window.api.moveToTrash(null),
        permanent: await window.api.permanentlyDelete(null),
        legacyDelete: typeof window.api.deleteEntry,
      }))()`), {
        trash: { success: false, code: "INVALID_PATH", error: "Invalid file path or arguments." },
        permanent: { success: false, code: "INVALID_PATH", error: "Invalid file path or arguments." },
        legacyDelete: "undefined",
      });
      assert.equal(
        await run(`(async () => {
          const regular = await document.fonts.load('16px "uicons-regular-rounded"', '\\uf153');
          const brands = await document.fonts.load('16px "uicons-brands"', '\\uf178');
          return regular.some(font => font.family === 'uicons-regular-rounded') &&
            brands.some(font => font.family === 'uicons-brands');
        })()`),
        true,
        "Flaticon regular and brand WOFF2 fonts load in Chromium",
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
      if (phase !== "write") {
        await waitForCondition(
          async () => (await run(`typeof AgentSidebar !== "undefined" &&
            editor.agentSidebar instanceof AgentSidebar &&
            editor.agentSidebar.isOpen &&
            editor.sidebarManager.rightActiveMenu === editor.agentSidebar &&
            editor.agentSidebar.messagesScroller?.vScroller?._destroyed === false`)) === true,
          {
            timeout: 10000,
            description: "restored Agent sidebar to finish lazy initialization",
          },
        );
      }
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
      if (phase === "write") {
        assert.equal(
          await run('typeof Agent === "undefined" && typeof AgentSidebar === "undefined" && typeof MarkdownRenderer === "undefined"'),
          true,
        );
        const settingsOpen = await run(`(async () => {
          window.__agentSettingsRendererErrors = [];
          window.__agentSettingsOnError = event => window.__agentSettingsRendererErrors.push(event.message);
          window.__agentSettingsOnRejection = event => window.__agentSettingsRendererErrors.push(String(event.reason));
          window.addEventListener("error", window.__agentSettingsOnError);
          window.addEventListener("unhandledrejection", window.__agentSettingsOnRejection);
          const settingsTab = await editor.openSettings("Agent");
          const modelInput = document.querySelector(".agent-model-setting input[type=checkbox]");
          if (!modelInput) throw Error("Agent Models settings rendered no models");
          const firstProvider = AgentProviderCatalog.getProviders()[0];
          const firstModel = Object.values(firstProvider.models)[0];
          window.__agentSettingsTestTabId = settingsTab.id;
          window.__agentSettingsModelInput = modelInput;
          window.__agentSettingsModelKey = AgentProviderCatalog.getModelKey(firstProvider.id, firstModel.id);
          window.__agentSettingsModelWasVisible = modelInput.checked;
          return {
            tabType: settingsTab.type,
            modelCount: document.querySelectorAll(".agent-model-setting").length,
            category: SETTINGS_GET("ui.settingsCategory"),
          };
        })()`);
        assert.equal(settingsOpen.tabType, "settings");
        assert.ok(settingsOpen.modelCount > 0);
        assert.equal(settingsOpen.category, "Agent");
        await waitForCondition(
          async () => (await run('window.api.getSettings()'))?.ui?.settingsCategory === "Agent",
          { description: "Agent Settings category to persist before restart" },
        );
        const modelKey = await run("window.__agentSettingsModelKey");
        const modelWasVisible = await run("window.__agentSettingsModelWasVisible");
        await run("window.__agentSettingsModelInput.click()");
        await waitForCondition(
          async () => (await run("window.api.getSettings()"))?.agent?.hiddenModels?.includes(modelKey) === modelWasVisible,
          { description: "Agent model visibility setting to persist after a cold-start toggle" },
        );
        await run("window.__agentSettingsModelInput.click()");
        await waitForCondition(
          async () => (await run("window.api.getSettings()"))?.agent?.hiddenModels?.includes(modelKey) === !modelWasVisible,
          { description: "Agent model visibility setting to return to its original state" },
        );
        const settingsColdStart = await run(`(async () => {
          document.querySelector("#agent-settings-tab-providers").click();
          const providerCount = document.querySelectorAll(".agent-provider-setting").length;
          const apiKeyControlCount = document.querySelectorAll(".agent-provider-key-actions button").length;
          if (!providerCount || !apiKeyControlCount)
            throw Error("Agent Providers settings did not render provider controls");
          document.querySelector(".agent-provider-key-actions button:not(.agent-provider-remove)").click();
          const apiKeyPromptOpened = editor.quickPanel.isOpen("agent-api-key");
          if (!apiKeyPromptOpened)
            throw Error("Cold-start provider API key control did not open its input prompt");
          editor.quickPanel.close();
          document.querySelector("#agent-settings-tab-models").click();
          const result = {
            providerCount,
            apiKeyControlCount,
            apiKeyPromptOpened,
            category: SETTINGS_GET("ui.settingsCategory"),
            agentBundleLoaded: typeof AgentAI !== "undefined",
            markdownBundleLoaded: typeof MarkdownRenderer !== "undefined",
            rendererErrors: window.__agentSettingsRendererErrors,
          };
          window.removeEventListener("error", window.__agentSettingsOnError);
          window.removeEventListener("unhandledrejection", window.__agentSettingsOnRejection);
          const settingsTab = editor.tabManager.tabs.find(tab => tab.id === window.__agentSettingsTestTabId);
          if (!(await editor.tabManager.closeTab(settingsTab)))
            throw Error("Cold-start Agent Settings tab did not close cleanly");
          return result;
        })()`);
        assert.ok(settingsColdStart.providerCount > 0);
        assert.ok(settingsColdStart.apiKeyControlCount > 0);
        assert.equal(settingsColdStart.apiKeyPromptOpened, true);
        assert.equal(settingsColdStart.category, "Agent");
        assert.equal(settingsColdStart.agentBundleLoaded, false);
        assert.equal(settingsColdStart.markdownBundleLoaded, false);
        assert.deepEqual(settingsColdStart.rendererErrors, []);
        const largeWorkspaceRootA = JSON.stringify(path.join(directory, "workspace-a"));
        const largeWorkspaceRootB = JSON.stringify(path.join(directory, "workspace-b"));
        const largeWorkspaceHoverTargets = await run(`(() => {
          const explorer = editor.fileExplorer;
          explorer.rootPath = ${largeWorkspaceRootA};
          explorer.projectName = "Workspace A";
          explorer.files = [];
          explorer.isLoaded = true;
          editor.sidebarManager.openMenu("file-explorer");
          explorer.refresh();
          const shell = explorer.shell;
          const badge = explorer.workspaceModeBadge;
          const stats = {
            root: explorer.rootPath,
            ready: false,
            fileCount: 12001,
            directoryCount: 1600,
            totalIndexedBytes: 3 * 1024 ** 3,
            pressureScore: 3,
            largeWorkspaceMode: true,
            generatedAt: Date.now(),
          };
          if (!explorer.applyWorkspaceIndexStats(stats))
            throw Error("Large workspace stats were rejected for the active workspace");
          const titleRect = explorer.projectTitle.getBoundingClientRect();
          const badgeRect = badge.getBoundingClientRect();
          const neutralRect = shell.querySelector(".sidebar-main-title").getBoundingClientRect();
          return {
            title: { x: titleRect.x, y: titleRect.y, width: titleRect.width, height: titleRect.height },
            badge: { x: badgeRect.x, y: badgeRect.y, width: badgeRect.width, height: badgeRect.height },
            neutral: { x: neutralRect.x, y: neutralRect.y, width: neutralRect.width, height: neutralRect.height },
          };
        })()`);
        win.focus();
        const moveMouseTo = (rect) => win.webContents.sendInputEvent({
          type: "mouseMove",
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        });
        moveMouseTo(largeWorkspaceHoverTargets.neutral);
        await waitForCondition(
          async () => (await run("!editor.fileExplorer.projectHeader.matches(':hover')")) === true,
          { description: "pointer to leave the workspace header" },
        );
        const workspaceNameRestingColor = await run(
          "getComputedStyle(editor.fileExplorer.projectTitle).color",
        );
        const badgeRestingColor = await run(
          "getComputedStyle(editor.fileExplorer.workspaceModeBadge).color",
        );
        moveMouseTo(largeWorkspaceHoverTargets.badge);
        await waitForCondition(
          async () => (await run("editor.fileExplorer.workspaceModeBadge.matches(':hover')")) === true,
          { description: "pointer to hover the Large Workspace Mode badge" },
        );
        assert.equal(
          await run("getComputedStyle(editor.fileExplorer.projectTitle).color"),
          workspaceNameRestingColor,
          "hovering the Large Workspace Mode badge leaves the workspace name at rest",
        );
        assert.notEqual(
          await run("getComputedStyle(editor.fileExplorer.workspaceModeBadge).color"),
          badgeRestingColor,
          "hovering the Large Workspace Mode badge activates its own hover style",
        );
        moveMouseTo(largeWorkspaceHoverTargets.title);
        await waitForCondition(
          async () => (await run("editor.fileExplorer.projectTitle.matches(':hover')")) === true,
          { description: "pointer to hover the workspace name" },
        );
        assert.notEqual(
          await run("getComputedStyle(editor.fileExplorer.projectTitle).color"),
          workspaceNameRestingColor,
          "hovering the workspace name activates its own hover style",
        );
        moveMouseTo(largeWorkspaceHoverTargets.neutral);
        const largeWorkspaceOpen = await run(`(() => {
          const explorer = editor.fileExplorer;
          const shell = explorer.shell;
          const badge = explorer.workspaceModeBadge;
          badge.focus();
          badge.click();
          const dialog = explorer.workspaceModeDialog;
          if (!dialog?.open) throw Error("Large Workspace Mode information did not open");
          explorer.showWorkspaceModeDialog();
          return {
            badgeTag: badge.tagName,
            badgeVisible: !badge.hidden,
            badgeExpanded: badge.getAttribute("aria-expanded"),
            headerExpanded: explorer.projectExpanded,
            dialogCount: document.querySelectorAll("#file-explorer-large-workspace-dialog").length,
            dialogRole: dialog.getAttribute("role"),
            dialogModal: dialog.getAttribute("aria-modal"),
            dialogTitle: dialog.querySelector("h2")?.textContent,
            dialogDescription: dialog.querySelector("#large-workspace-dialog-description")?.textContent,
            files: dialog.querySelector('[data-stat="files"]')?.textContent.replace(/[^0-9]/g, ""),
            directories: dialog.querySelector('[data-stat="directories"]')?.textContent.replace(/[^0-9]/g, ""),
            indexedSize: dialog.querySelector('[data-stat="size"]')?.textContent,
            indexStatus: dialog.querySelector('[data-stat="status"]')?.textContent,
            optimizationCount: dialog.querySelectorAll(".file-explorer-large-workspace-optimizations li").length,
            allFeaturesAvailable: dialog.textContent.includes("All editor features remain available."),
            focusInitial: document.activeElement === dialog.querySelector(".file-explorer-large-workspace-close"),
            shellPreserved: explorer.shell === shell,
          };
        })()`);
        assert.equal(largeWorkspaceOpen.badgeTag, "BUTTON");
        assert.equal(largeWorkspaceOpen.badgeVisible, true);
        assert.equal(largeWorkspaceOpen.badgeExpanded, "true");
        assert.equal(largeWorkspaceOpen.headerExpanded, true);
        assert.equal(largeWorkspaceOpen.dialogCount, 1);
        assert.equal(largeWorkspaceOpen.dialogRole, "dialog");
        assert.equal(largeWorkspaceOpen.dialogModal, "true");
        assert.equal(largeWorkspaceOpen.dialogTitle, "Large Workspace Mode");
        assert.match(largeWorkspaceOpen.dialogDescription, /automatically adjusts background operations/);
        assert.equal(largeWorkspaceOpen.files, "12001");
        assert.equal(largeWorkspaceOpen.directories, "1600");
        assert.equal(largeWorkspaceOpen.indexedSize, "3.0 GiB");
        assert.equal(largeWorkspaceOpen.indexStatus, "Updating");
        assert.equal(largeWorkspaceOpen.optimizationCount, 3);
        assert.equal(largeWorkspaceOpen.allFeaturesAvailable, true);
        assert.equal(largeWorkspaceOpen.focusInitial, true);
        assert.equal(largeWorkspaceOpen.shellPreserved, true);
        await run(`editor.fileExplorer.applyWorkspaceIndexStats({
          root: editor.fileExplorer.rootPath,
          ready: true,
          fileCount: 13000,
          directoryCount: 1700,
          totalIndexedBytes: 4 * 1024 ** 3,
          pressureScore: 4,
          largeWorkspaceMode: true,
          generatedAt: Date.now(),
        })`);
        assert.deepEqual(
          await run(`(() => {
            const dialog = editor.fileExplorer.workspaceModeDialog;
            return {
              files: dialog.querySelector('[data-stat="files"]').textContent.replace(/[^0-9]/g, ""),
              directories: dialog.querySelector('[data-stat="directories"]').textContent.replace(/[^0-9]/g, ""),
              indexedSize: dialog.querySelector('[data-stat="size"]').textContent,
              indexStatus: dialog.querySelector('[data-stat="status"]').textContent,
              headerExpanded: editor.fileExplorer.projectExpanded,
              dialogCount: document.querySelectorAll("#file-explorer-large-workspace-dialog").length,
            };
          })()`),
          {
            files: "13000",
            directories: "1700",
            indexedSize: "4.0 GiB",
            indexStatus: "Ready",
            headerExpanded: true,
            dialogCount: 1,
          },
          "Large Workspace Mode dialog follows updated current workspace statistics without rebuilding the Explorer shell",
        );
        win.focus();
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await waitForCondition(
          async () => (await run("editor.fileExplorer.workspaceModeDialog.open")) === false,
          { description: "Large Workspace Mode dialog to close with Escape" },
        );
        await waitForCondition(
          async () => (await run("document.activeElement === editor.fileExplorer.workspaceModeBadge")) === true,
          { description: "focus to return to the Large Workspace Mode badge after Escape" },
        );
        await run("editor.fileExplorer.workspaceModeBadge.focus()");
        win.focus();
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        await waitForCondition(
          async () => (await run("editor.fileExplorer.workspaceModeDialog.open")) === true,
          { description: "Enter to activate the Large Workspace Mode badge" },
        );
        assert.equal(await run("document.activeElement === editor.fileExplorer.workspaceModeDialog.querySelector('.file-explorer-large-workspace-close')"), true);
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await waitForCondition(
          async () => (await run("editor.fileExplorer.workspaceModeDialog.open")) === false,
          { description: "dialog to close before Space activation" },
        );
        await run("editor.fileExplorer.workspaceModeBadge.focus()");
        win.focus();
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
        await waitForCondition(
          async () => (await run("editor.fileExplorer.workspaceModeDialog.open")) === true,
          { description: "Space to activate the Large Workspace Mode badge" },
        );
        assert.equal(await run("document.activeElement.textContent === 'Got it'"), true);
        await run("editor.fileExplorer.clearWorkspaceIndexStats()");
        await waitForCondition(
          async () => (await run("document.activeElement === editor.fileExplorer.projectHeader")) === true,
          { description: "focus to move to the project header when the badge is hidden on workspace change" },
        );
        assert.deepEqual(
          await run(`(() => ({
            popupOpen: editor.fileExplorer.workspaceModeDialog.open,
            badgeHidden: editor.fileExplorer.workspaceModeBadge.hidden,
            badgeExpanded: editor.fileExplorer.workspaceModeBadge.getAttribute("aria-expanded"),
            focusRestored: document.activeElement === editor.fileExplorer.projectHeader,
          }))()`),
          { popupOpen: false, badgeHidden: true, badgeExpanded: "false", focusRestored: true },
          "workspace change closes the dialog, hides the stale badge, and restores focus",
        );
        const largeWorkspaceB = await run(`(() => {
          const explorer = editor.fileExplorer;
          explorer.rootPath = ${largeWorkspaceRootB};
          explorer.projectName = "Workspace B";
          explorer.refresh();
          return {
            oldStatsAccepted: explorer.applyWorkspaceIndexStats({
              root: ${largeWorkspaceRootA}, ready: true, fileCount: 1,
              directoryCount: 1, totalIndexedBytes: 1, largeWorkspaceMode: true,
            }),
            currentStatsAccepted: explorer.applyWorkspaceIndexStats({
              root: explorer.rootPath, ready: true, fileCount: 24000,
              directoryCount: 2600, totalIndexedBytes: 5 * 1024 ** 3,
              largeWorkspaceMode: true,
            }),
          };
        })()`);
        assert.deepEqual(largeWorkspaceB, { oldStatsAccepted: false, currentStatsAccepted: true });
        assert.equal(await run(`(() => {
          const explorer = editor.fileExplorer;
          explorer.workspaceModeBadge.focus();
          explorer.workspaceModeBadge.click();
          return explorer.workspaceModeDialog.querySelector('[data-stat="files"]').textContent.replace(/[^0-9]/g, "");
        })()`), "24000");
        await run("editor.fileExplorer.workspaceModeDialog.click()");
        assert.equal(await run("editor.fileExplorer.workspaceModeDialog.open"), false);
        await run(`(() => {
          const explorer = editor.fileExplorer;
          explorer.clearWorkspaceIndexStats();
          explorer.rootPath = "";
          explorer.projectName = "";
          explorer.refresh();
        })()`);
        assert.deepEqual(
          await run(`(async () => {
            editor.sidebarManager.openMenu("agent");
            editor.sidebarManager.closeMenu("agent");
            editor.sidebarManager.openMenu("agent");
            await editor.ensureAgentSidebar();
            const sidebar = editor.agentSidebar;
            const scroller = sidebar.messagesScroller;
            const listenerCount = sidebar.globalListeners.size;
            const sessions = sidebar.sessions;
            const activeSession = sidebar.getActiveSession();
            if (activeSession) activeSession.draft = "reopen draft";
            for (let index = 0; index < 10; index += 1) {
              editor.sidebarManager.closeMenu("agent");
              if (editor.agentSidebar !== sidebar) return false;
              editor.sidebarManager.openMenu("agent");
              if (!sidebar.isOpen || sidebar.messagesScroller !== scroller) return false;
            }
            editor.sidebarManager.openMenu("search");
            await new Promise(requestAnimationFrame);
            editor.sidebarManager.openMenu("agent");
            await new Promise(requestAnimationFrame);
            return {
              registered: editor.sidebarManager.menus.get("agent") === sidebar,
              active: editor.sidebarManager.rightActiveMenu === sidebar,
              currentScroller: editor.sidebarManager.rightScroller === sidebar.messagesScroller,
              wrapperStable: sidebar.messagesScroller === scroller,
              scrollerAlive: sidebar.messagesScroller.vScroller?._destroyed === false,
              agentBundleLoads: document.querySelectorAll(
                'script[data-nce-renderer-bundle="agent"]',
              ).length,
              scrollerCount: editor.scrollerManager.scrollers.filter(
                item => item.parentOBJ === sidebar.messagesViewport,
              ).length,
              sessionsPreserved: sidebar.sessions === sessions,
              draftPreserved: activeSession ? activeSession.draft === "reopen draft" : true,
              listenerCountPreserved: sidebar.globalListeners.size === listenerCount,
              listenersAttached: [...sidebar.globalListeners.values()].every(entry => entry.attached),
            };
          })()`),
          {
            registered: true,
            active: true,
            currentScroller: true,
            wrapperStable: true,
            scrollerAlive: true,
            agentBundleLoads: 1,
            scrollerCount: 1,
            sessionsPreserved: true,
            draftPreserved: true,
            listenerCountPreserved: true,
            listenersAttached: true,
          },
          "Agent can reopen repeatedly and after switching sidebars without duplicating lifecycle resources",
        );
        assert.equal(
          await run(`(async () => {
            await ensureMarkdownBundle();
            await ensureAgentBundle();
            return typeof Agent === "function" &&
              typeof AgentSidebar === "function" &&
              typeof MarkdownRenderer === "function";
          })()`),
          true,
        );
      }
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
        const deleteDialogOpened = await run(`(() => {
          const focusTarget = document.createElement("button");
          focusTarget.id = "delete-confirmation-focus-target";
          document.body.appendChild(focusTarget);
          focusTarget.focus();
          window.__deleteConfirmationResult = null;
          window.__deleteConfirmationPromise = editor.fileExplorer
            .showDeleteConfirmation({ type: "file", name: "keyboard.js" })
            .then(result => { window.__deleteConfirmationResult = result; });
          const dialog = editor.fileExplorer.deleteDialog;
          return {
            open: dialog.open,
            title: editor.fileExplorer.deleteDialogTitle.textContent,
            message: editor.fileExplorer.deleteDialogMessage.textContent,
            role: dialog.getAttribute("role"),
            modal: dialog.getAttribute("aria-modal"),
            initialFocus: document.activeElement === editor.fileExplorer.deleteDialogCancelButton,
            deleteButtonClass: editor.fileExplorer.deleteDialogDeleteButton.className,
            width: dialog.getBoundingClientRect().width,
            borderRadius: getComputedStyle(dialog).borderRadius,
            trashIcon: dialog.querySelector(".file-explorer-delete-trash-badge i")?.className,
          };
        })()`);
        assert.equal(deleteDialogOpened.open, true);
        assert.equal(deleteDialogOpened.title, "Move to Trash");
        assert.equal(deleteDialogOpened.message, "Move this file to the Trash?");
        assert.equal(deleteDialogOpened.role, "dialog");
        assert.equal(deleteDialogOpened.modal, "true");
        assert.equal(deleteDialogOpened.initialFocus, true);
        assert.doesNotMatch(deleteDialogOpened.deleteButtonClass, /danger/);
        assert.ok(deleteDialogOpened.width <= 400);
        assert.equal(deleteDialogOpened.borderRadius, "9px");
        assert.match(deleteDialogOpened.trashIcon, /fi-rr-trash/);
        assert.equal(
          await run('editor.fileExplorer.deleteDialogSubtitle.textContent'),
          "This action cannot be undone.",
        );
        assert.equal(
          await run('editor.fileExplorer.deleteDialogCheckboxLabel.textContent.trim()'),
          "Don't ask again",
        );
        assert.equal(
          await run('getComputedStyle(editor.fileExplorer.deleteDialogItemName).textOverflow'),
          "ellipsis",
        );
        win.focus();
        const sendKeyboardKey = (keyCode, modifiers = []) => {
          const options = { keyCode };
          if (modifiers.length > 0) options.modifiers = modifiers;
          win.webContents.sendInputEvent({ type: "keyDown", ...options });
          win.webContents.sendInputEvent({ type: "keyUp", ...options });
        };
        sendKeyboardKey("Tab");
        await waitForCondition(
          async () => (await run("document.activeElement === editor.fileExplorer.deleteDialogDeleteButton")) === true,
          { description: "Delete dialog Tab navigation to the destructive action" },
        );
        sendKeyboardKey("Tab");
        await waitForCondition(
          async () => (await run("document.activeElement === editor.fileExplorer.deleteDialogCheckbox")) === true,
          { description: "Delete dialog focus trap to wrap to its checkbox" },
        );
        await run("editor.fileExplorer.deleteDialogDeleteButton.focus()");
        sendKeyboardKey("Enter");
        await waitForCondition(
          async () => (await run("window.__deleteConfirmationResult?.confirmed === true")) === true,
          { description: "Enter to confirm the focused Delete action" },
        );
        await waitForCondition(
          async () => (await run('document.activeElement?.id === "delete-confirmation-focus-target"')) === true,
          { description: "focus to return after closing the delete confirmation" },
        );
        const deleteDialogReopened = await run(`(() => {
          window.__deleteConfirmationResult = null;
          editor.fileExplorer.showDeleteConfirmation(
            { type: "folder", name: "components" }, { action: "permanent-delete" })
            .then(result => { window.__deleteConfirmationResult = result; });
          return {
            open: editor.fileExplorer.deleteDialog.open,
            title: editor.fileExplorer.deleteDialogTitle.textContent,
            message: editor.fileExplorer.deleteDialogMessage.textContent,
            button: editor.fileExplorer.deleteDialogDeleteButton.textContent,
          };
        })()`);
        assert.equal(deleteDialogReopened.open, true);
        assert.equal(deleteDialogReopened.title, "Delete Permanently");
        assert.equal(
          deleteDialogReopened.message,
          "Permanently delete this folder? All files and subfolders inside will also be permanently deleted.",
        );
        assert.equal(deleteDialogReopened.button, "Delete Permanently");
        assert.equal(
          await run("editor.fileExplorer.deleteDialogCheckboxLabel.hidden"),
          true,
        );
        win.focus();
        sendKeyboardKey("Escape");
        await waitForCondition(
          async () => (await run("window.__deleteConfirmationResult?.confirmed === false")) === true,
          { description: "Escape to cancel the reopened delete confirmation" },
        );
        const longFolderName = `folder-${"long-name-".repeat(16)}`;
        const longFolderDialog = await run(`(() => {
          window.__deleteConfirmationResult = null;
          const name = ${JSON.stringify(longFolderName)};
          editor.fileExplorer.showDeleteConfirmation(
            { type: "folder", name }, { action: "permanent-delete" })
            .then(result => { window.__deleteConfirmationResult = result; });
          const itemName = editor.fileExplorer.deleteDialogItemName;
          return {
            open: editor.fileExplorer.deleteDialog.open,
            title: itemName.title,
            textOverflow: getComputedStyle(itemName).textOverflow,
            overflowed: itemName.scrollWidth > itemName.clientWidth,
          };
        })()`);
        assert.equal(longFolderDialog.open, true);
        assert.equal(longFolderDialog.title, longFolderName);
        assert.equal(longFolderDialog.textOverflow, "ellipsis");
        assert.equal(longFolderDialog.overflowed, true);
        win.focus();
        sendKeyboardKey("Escape");
        await waitForCondition(
          async () => (await run("window.__deleteConfirmationResult?.confirmed === false")) === true,
          { description: "Escape to cancel the long folder name confirmation" },
        );
        await run('document.querySelector("#delete-confirmation-focus-target")?.remove()');
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
        const gutterSmokePath = path.join(directory, "gutter-large.js");
        const gutterSmokeLine = `const gutterSmokeValue = "${"x".repeat(90)}";`;
        fs.writeFileSync(
          gutterSmokePath,
          Array.from({ length: 12000 }, () => gutterSmokeLine).join("\n"),
        );
        await waitForCondition(
          async () =>
            (await run("!editor.tabManager.activeFile || editor.tabManager.activeFile.isLoaded")) === true,
          { description: "the restored tab to load before exercising tab scrolling" },
        );
        const gutterLoad = await run(`(async () => {
          const manager = editor.tabManager;
          const originalFile = manager.activeFile;
          const originalTabs = [...manager.tabs];
          const queuedIdleCallbacks = [];
          const requestIdleCallback = window.requestIdleCallback;
          window.__gutterSmokeOriginalFile = originalFile;
          window.__gutterSmokeOriginalTabs = originalTabs;
          window.requestIdleCallback = (callback) => {
            queuedIdleCallbacks.push(callback);
            return queuedIdleCallbacks.length;
          };
          try {
            const File = originalFile.constructor;
            const largeFile = new File(
              editor,
              manager.getNextID(),
              "gutter-large.js",
              ${JSON.stringify(gutterSmokePath)},
            );
            window.__gutterSmokeFile = largeFile;
            await manager.openFile(largeFile);
            const state = largeFile.loadingState;
            if (state?.status !== "loading" || state.expectedTotalLines !== 12000 ||
                largeFile.lines.length >= state.expectedTotalLines || !queuedIdleCallbacks.length) {
              throw Error("Large gutter fixture did not remain in progressive loading");
            }

            const layer = document.querySelector(".line-numbers");
            const context = document.createElement("canvas").getContext("2d");
            context.font = getComputedStyle(layer).font;
            const longestNumberWidth = context.measureText("88888").width;
            const layerWidth = layer.getBoundingClientRect().width;
            if (layerWidth + 0.5 < longestNumberWidth + 15) {
              throw Error("Progressive gutter clipped expected 5-digit labels: " + layerWidth + "px");
            }
            if (Math.abs(editor.baseX - layerWidth - 10) > 0.5 ||
                editor.output.style.left !== editor.baseX + "px") {
              throw Error("Editor output did not move with the initial gutter width");
            }
            return { layerWidth, longestNumberWidth, loadedLines: largeFile.lines.length };
          } finally {
            window.requestIdleCallback = requestIdleCallback;
            for (const callback of queuedIdleCallbacks) {
              requestIdleCallback(callback, { timeout: 100 });
            }
          }
        })()`);
        assert.ok(gutterLoad.layerWidth + 0.5 >= gutterLoad.longestNumberWidth + 15);
        assert.ok(gutterLoad.loadedLines < 12000);
        await waitForCondition(
          async () =>
            (await run('window.__gutterSmokeFile?.loadingState?.status === "loaded"')) === true,
          { timeout: 15000, description: "progressive gutter fixture to finish loading" },
        );
        const fullGutterState = await run(`(() => {
          const file = window.__gutterSmokeFile;
          editor.cursorController.setCursorPosition(12000, 0);
          const layer = document.querySelector(".line-numbers");
          const line = [...layer.children].find((element) => element.textContent === "12000");
          if (!line) throw Error("Last 5-digit line number was not rendered");
          const layerRect = layer.getBoundingClientRect();
          const lineRect = line.getBoundingClientRect();
          const context = document.createElement("canvas").getContext("2d");
          context.font = getComputedStyle(layer).font;
          return {
            lineCount: file.lines.length,
            lineNumber: line.textContent,
            layerWidth: layerRect.width,
            lineLeft: lineRect.left,
            lineRight: lineRect.right,
            layerLeft: layerRect.left,
            layerRight: layerRect.right,
            requiredWidth: context.measureText("88888").width + 15,
          };
        })()`);
        assert.equal(fullGutterState.lineCount, 12000);
        assert.ok(fullGutterState.layerWidth + 0.5 >= fullGutterState.requiredWidth);
        assert.ok(fullGutterState.lineLeft >= fullGutterState.layerLeft - 0.5);
        assert.ok(fullGutterState.lineRight <= fullGutterState.layerRight + 0.5);
        const smallFileGutterWidth = await run(`(async () => {
          const manager = editor.tabManager;
          await manager.setFocusTab(window.__gutterSmokeOriginalFile);
          const smallWidth = document.querySelector(".line-numbers").getBoundingClientRect().width;
          await manager.setFocusTab(window.__gutterSmokeFile);
          return smallWidth;
        })()`);
        assert.equal(smallFileGutterWidth, 50);
        const mixedTabNavigation = await run(`(async () => {
          const manager = editor.tabManager;
          const file = window.__gutterSmokeFile;
          const originalTabs = window.__gutterSmokeOriginalTabs;
          const settings = {
            id: manager.getNextID(),
            type: "settings",
            name: "Settings",
          };
          const frame = () => new Promise(requestAnimationFrame);
          manager.tabs = [file, settings];
          manager.activeTab = file;
          manager.refresh();

          await editor.keyBinding.control_next_tab();
          const fileToView = manager.activeTab === settings &&
            manager.activeFile === null &&
            editor.editorOBJ.classList.contains("editor-settings-active") &&
            getComputedStyle(editor.cD).display === "none";

          await editor.keyBinding.control_previous_tab();
          const viewToFile = manager.activeTab === file &&
            manager.activeFile === file &&
            !editor.editorOBJ.classList.contains("editor-settings-active") &&
            getComputedStyle(editor.cD).display !== "none";

          await editor.keyBinding.control_next_tab();
          await editor.keyBinding.control_next_tab();
          const nextWraps = manager.activeTab === file;
          await editor.keyBinding.control_previous_tab();
          const previousWraps = manager.activeTab === settings;

          manager.tabs = [settings];
          manager.activeTab = settings;
          manager.refresh();
          const oneViewDisablesCycling = manager.canCycleTabs === false &&
            editor.keyBinding.isActionEnabled("next_tab") === false &&
            editor.keyBinding.isActionEnabled("previous_tab") === false;
          editor.keyBinding.exec({ action: "next_tab" }, {});
          const disabledActionKeepsView = manager.activeTab === settings;

          manager.tabs = [...originalTabs, file];
          await manager.setFocusTab(file);
          await frame();
          return { fileToView, viewToFile, nextWraps, previousWraps,
            oneViewDisablesCycling, disabledActionKeepsView };
        })()`);
        assert.equal(mixedTabNavigation.fileToView, true);
        assert.equal(mixedTabNavigation.viewToFile, true);
        assert.equal(mixedTabNavigation.nextWraps, true);
        assert.equal(mixedTabNavigation.previousWraps, true);
        assert.equal(mixedTabNavigation.oneViewDisablesCycling, true);
        assert.equal(mixedTabNavigation.disabledActionKeepsView, true);
        await waitForCondition(
          () => nce.window.appMenu?.canCycleTabs === true,
          { description: "native tab cycling to enable with multiple tabs" },
        );
        if (process.platform === "darwin") {
          assert.equal(nce.window.appMenu.menu.getMenuItemById("next-tab").enabled, true);
          assert.equal(nce.window.appMenu.menu.getMenuItemById("previous-tab").enabled, true);
        }
        const gutterSidebarWidths = await run(`(async () => {
          const manager = editor.sidebarManager;
          const layer = document.querySelector(".line-numbers");
          const getWidth = () => layer.getBoundingClientRect().width;
          const frame = () => new Promise(requestAnimationFrame);
          const originalLeft = document.querySelector(".sidebar-left").classList.contains("open");
          const originalRight = document.querySelector(".sidebar-right").classList.contains("open");
          const result = {};
          try {
            manager.closeSidebar("left");
            manager.closeSidebar("right");
            await frame();
            result.none = getWidth();
            manager.openSidebar("left");
            await frame();
            result.left = getWidth();
            manager.closeSidebar("left");
            manager.openSidebar("right");
            await frame();
            result.right = getWidth();
            manager.openSidebar("left");
            await frame();
            result.both = getWidth();
          } finally {
            if (originalLeft) manager.openSidebar("left");
            else manager.closeSidebar("left");
            if (originalRight) manager.openSidebar("right");
            else manager.closeSidebar("right");
            await frame();
          }
          return result;
        })()`);
        for (const width of Object.values(gutterSidebarWidths)) {
          assert.ok(Math.abs(width - fullGutterState.layerWidth) <= 0.5);
        }
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
          const bottomBar = document.querySelector(".bottomBar");
          const mainSection = document.querySelector(".main-section");
          const list = document.querySelector(".file-manager .files-ul");
          const tabScroller = editor.tabManager.tabScroller;
          const scroller = tabScroller.hScroller;
          const leftSidebar = document.querySelector(".sidebar-left");
          const rightSidebar = document.querySelector(".sidebar-right");
          const editorRect = editorElement.getBoundingClientRect();
          const bottomBarRect = bottomBar.getBoundingClientRect();
          const boundaryElement = document.elementFromPoint(
            editorRect.left + 25,
            bottomBarRect.top + 0.5,
          );
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
            bottomBarOwnsEditorBoundary: boundaryElement?.closest(".bottomBar") === bottomBar,
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
            gutterWidth: document.querySelector(".line-numbers").getBoundingClientRect().width,
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
            const bottomBar = document.querySelector(".bottomBar");
            const mainSection = document.querySelector(".main-section");
            const list = document.querySelector(".file-manager .files-ul");
            const tabScroller = editor.tabManager.tabScroller;
            const scroller = tabScroller.hScroller;
            const leftSidebar = document.querySelector(".sidebar-left");
            const rightSidebar = document.querySelector(".sidebar-right");
            const editorRect = editorElement.getBoundingClientRect();
            const bottomBarRect = bottomBar.getBoundingClientRect();
            const boundaryElement = document.elementFromPoint(
              editorRect.left + 25,
              bottomBarRect.top + 0.5,
            );
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
              bottomBarOwnsEditorBoundary: boundaryElement?.closest(".bottomBar") === bottomBar,
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
              gutterWidth: document.querySelector(".line-numbers").getBoundingClientRect().width,
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
          assert.equal(state.bottomBarOwnsEditorBoundary, true, JSON.stringify(state));
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
          assert.ok(
            Math.abs(state.gutterWidth - fullGutterState.layerWidth) <= 0.5,
            `Gutter width changed with sidebar layout: ${JSON.stringify(state)}`,
          );
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
            gutterWidth: document.querySelector(".line-numbers").getBoundingClientRect().width,
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
          assert.ok(Math.abs(baseline.gutterWidth - fullGutterState.layerWidth) <= 0.5);

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
          assert.ok(Math.abs(afterExpand.gutterWidth - fullGutterState.layerWidth) <= 0.5);

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
          assert.ok(Math.abs(afterShrink.gutterWidth - fullGutterState.layerWidth) <= 0.5);
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
        await waitForCondition(
          async () => {
            try {
              return await run(`(() => {
                const file = editor.tabManager.getFileByPath(${JSON.stringify(target)});
                return file?.isLoaded === true &&
                  file.path === ${JSON.stringify(target)} &&
                  file.serializeContent() === 'const value = 1;';
              })()`);
            } catch {
              return false;
            }
          },
          {
            timeout: 10000,
            description: `${phase} session path and text to restore`,
          },
        );
      }
      if (phase === "reload") {
        const recovered = await run(`(() => {
          const file = editor.tabManager.tabs.find(tab =>
            tab.type === "file" && !tab.path &&
            tab.recoveryUntitledId === "electron-smoke-recovery");
          return file ? {
            content: file.serializeContent(),
            dirty: file.isSaved === false,
            noConfirmationApi: typeof window.api.confirmRecoverySnapshot === "undefined",
          } : null;
        })()`);
        assert.deepEqual(recovered, {
          content: "recovered by smoke\r\n🙂 end\n",
          dirty: true,
          noConfirmationApi: true,
        }, "Electron automatically restores an untitled recovery buffer as dirty");
        assert.equal(
          fs.readFileSync(target, "utf8"),
          "const value = 1;",
          "recovery does not overwrite an existing disk file",
        );
        const windowId = win.id;
        let finishedLoads = 0;
        let renderProcessGone = null;
        const onDidFinishLoad = () => { finishedLoads += 1; };
        const onRenderProcessGone = (_event, details) => {
          renderProcessGone = details;
        };
        win.webContents.on("did-finish-load", onDidFinishLoad);
        win.webContents.once("render-process-gone", onRenderProcessGone);
        try {
          // Reload follows the normal unsaved-buffer workflow; the smoke
          // dialog chooses Don't Save so recovery must carry the text forward.
          dialog.showMessageBox = async () => ({ response: 1 });
          win.focus();
          const reloadModifier = process.platform === "darwin" ? "meta" : "control";
          win.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "R",
            modifiers: [reloadModifier],
          });
          win.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "R",
            modifiers: [reloadModifier],
          });
          await waitForCondition(
            () => finishedLoads === 1,
            { timeout: 10000, description: "window reload to finish loading" },
          );
          await waitForCondition(
            async () => {
              try {
                return await run("editor.isOnInit === false");
              } catch {
                return false;
              }
            },
            { timeout: 10000, description: "renderer startup after window reload" },
          );
          await run(`(async () => {
            const file = editor.tabManager.getFileByPath(${JSON.stringify(target)});
            if (!file) return false;
            await editor.tabManager.setFocusFile(file);
            return true;
          })()`);
          await waitForCondition(
            async () => (await run(`(() => {
              const file = editor.tabManager.getFileByPath(${JSON.stringify(target)});
              return file?.isLoaded === true && file.serializeContent() === "const value = 1;";
            })()`)) === true,
            { timeout: 10000, description: "saved file contents to load after renderer reload" },
          );
          assert.equal(win.id, windowId, "reload keeps the BrowserWindow alive");
          assert.equal(renderProcessGone, null, "reload must not crash the renderer");
          assert.equal(
            await run(`editor.tabManager.getFileByPath(${JSON.stringify(target)})?.serializeContent() === 'const value = 1;'`),
            true,
            "reload restores the saved editor session",
          );
          assert.deepEqual(
            await run(`(() => {
              const file = editor.tabManager.tabs.find(tab =>
                tab.type === "file" && !tab.path &&
                tab.recoveryUntitledId === "electron-smoke-recovery");
              return file ? { content: file.serializeContent(), dirty: file.isSaved === false } : null;
            })()`),
            { content: "recovered by smoke\r\n🙂 end\n", dirty: true },
            "renderer reload automatically restores the dirty buffer without duplication",
          );
        } finally {
          win.webContents.removeListener("did-finish-load", onDidFinishLoad);
          win.webContents.removeListener("render-process-gone", onRenderProcessGone);
        }
      }
      if (phase === "write") {
        assert.equal(
          await run(`(async () => {
            editor.sidebarManager.openMenu("agent");
            await editor.ensureAgentSidebar();
            const settingsTab = await editor.openSettings("Agent");
            const settingsWorksAfterAgentLoad =
              document.querySelectorAll(".agent-model-setting").length > 0;
            if (!(await editor.tabManager.closeTab(settingsTab))) return false;
            return settingsWorksAfterAgentLoad && editor.agentSidebar.isOpen &&
              editor.sidebarManager.rightActiveMenu === editor.agentSidebar;
          })()`),
          true,
          "Agent Settings works before and after lazy Agent initialization",
        );
        assert.equal(await run(`(async () => {
          const saved = await window.api.saveRecoverySnapshot(null, {
            untitledId: "electron-smoke-recovery",
            displayName: "recovered.txt",
            content: "recovered by smoke\\r\\n🙂 end\\n",
            lineCount: 2,
            editVersion: 1,
          });
          if (!saved?.success) return false;
          editor.statesManager.clearRecoverySnapshotsOnQuit = async () => true;
          return true;
        })()`), true, "recovery fixture persists across the simulated clean quit");
      }
      if (phase === "reload") {
        assert.equal(
          await run('SETTINGS_GET("ui.settingsCategory")'),
          "Agent",
          "Agent Settings category persists across renderer restart",
        );
        await waitForCondition(
          async () => (await run(`typeof AgentSidebar !== "undefined" &&
            editor.agentSidebar instanceof AgentSidebar &&
            editor.agentSidebar.isOpen &&
            editor.sidebarManager.rightActiveMenu === editor.agentSidebar &&
            editor.agentSidebar.messagesScroller?.vScroller?._destroyed === false`)) === true,
          {
            timeout: 10000,
            description: "restored Agent sidebar to finish lazy initialization",
          },
        );
        dialog.showMessageBox = async () => ({ response: 1 });
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
