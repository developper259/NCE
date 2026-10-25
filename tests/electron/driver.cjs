const { app, clipboard, dialog, screen, session } = require("electron");
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
}, 90000);
const appRoot = process.env.NCE_BENCH_APP_ROOT || path.resolve(__dirname, "../..");
const { App } = require(path.join(appRoot, "dist/ts/App.js"));
const nce = new App();
function findMenuItem(menu, label) {
  for (const item of menu?.items || []) {
    if (item.label === label) return item;
    const nested = findMenuItem(item.submenu, label);
    if (nested) return nested;
  }
  return null;
}
function traceStep(description) {
  console.error(`[electron-smoke] ${phase}: ${description}`);
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
    const activeWindow = nce.window;
    const win = activeWindow?.window;
    if (!win || !activeWindow.rendererReady) return;
    clearInterval(waitWindow);
    try {
      const run = async (code) => {
        try {
          return await win.webContents.executeJavaScript(code);
        } catch (error) {
          throw new Error(
            `Renderer smoke expression failed: ${String(code).slice(0, 240)}\n${error?.message || error}`,
            { cause: error },
          );
        }
      };
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
      traceStep("renderer initialized");
      if (phase !== "write" && phase !== "multiwindow" && phase !== "benchmark") {
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
      if (phase === "benchmark") {
        const benchmarkFileId = await run(`editor.tabManager.createEmptyFile().id`);
        await waitForCondition(
          async () => (await run(`editor.tabManager.activeFile?.id === ${JSON.stringify(benchmarkFileId)} &&
            editor.tabManager.activeFile?.isLoaded === true &&
            editor.tabManager.activeFile?.lines?.length === 1`)) === true,
          { description: "benchmark document to finish loading" },
        );
        const report = await run(`(async () => {
          const file = editor.tabManager.activeFile;
          const lineCount = 2000;
          const source = Array.from({ length: lineCount }, (_, index) =>
            \`const value\${String(index).padStart(6, "0")} = \${index};\`,
          ).join("\\n");
          editor.cursorController.setCursorPosition(1, 0);
          if (!editor.writerController.write(source)) throw Error("Could not load benchmark source");
          editor.historyController.clear(file);
          editor.historyController.markSaved(file);
          const supportsMultiCursor = typeof editor.multiCursorController?.setSelections === "function";
          const cursorCounts = supportsMultiCursor ? [1, 10, 100, 500, 1000] : [1];
          const warmups = 1;
          const samples = 15;
          const percentile = (values, ratio) => {
            const sorted = [...values].sort((left, right) => left - right);
            return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
          };
          const flushFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
          const results = [];
          let rendererHeapBeforeBytes = performance.memory?.usedJSHeapSize ?? null;
          for (const cursorCount of cursorCounts) {
            const latenciesMs = [];
            let renderedCarets = 0;
            let renderedSelections = 0;
            for (let iteration = 0; iteration < warmups + samples; iteration++) {
              const selections = Array.from({ length: cursorCount }, (_, index) => {
                const row = cursorCount === 1
                  ? 1
                  : 1 + Math.floor(index * (lineCount - 1) / (cursorCount - 1));
                const column = Math.floor(file.lines[row - 1].getText().length / 2);
                return {
                  id: index + 1,
                  anchor: { row, column },
                  active: { row, column },
                  preferredVisualColumn: column,
                };
              });
              if (supportsMultiCursor) {
                editor.multiCursorController.setSelections(selections, {
                  file,
                  primaryId: 1,
                  render: true,
                });
              } else {
                editor.cursorController.setCursorPosition(
                  selections[0].active.row,
                  selections[0].active.column,
                );
              }
              await flushFrame();
              const started = performance.now();
              if (!editor.writerController.write("x")) throw Error(\`Typing failed at \${cursorCount} cursors\`);
              const latency = performance.now() - started;
              renderedCarets = editor.multiCursorController?.renderedCarets || 0;
              renderedSelections = editor.multiCursorController?.renderedSelections || 0;
              if (iteration >= warmups) latenciesMs.push(latency);
              if (!(await editor.historyController.undo())) throw Error("Benchmark undo failed");
            }
            results.push({
              cursors: cursorCount,
              samples,
              medianTypingMs: Number(percentile(latenciesMs, 0.5).toFixed(3)),
              p95TypingMs: Number(percentile(latenciesMs, 0.95).toFixed(3)),
              visibleSecondaryCarets: renderedCarets,
              visibleSelectionSegments: renderedSelections,
              pooledCaretNodes: document.querySelectorAll(".editor-secondary-caret").length,
              pooledSelectionNodes: document.querySelectorAll(".editor-secondary-selection").length,
            });
          }
          const singleCursorOperations = [];
          const operationSamples = 15;
          const row = Math.floor(lineCount / 2);
          const column = Math.floor(file.lines[row - 1].getText().length / 2);
          for (const operation of ["typing", "backspace", "enter", "undo"]) {
            const latenciesMs = [];
            for (let iteration = 0; iteration < operationSamples; iteration++) {
              if (supportsMultiCursor) {
                editor.multiCursorController.setSelections([{
                  id: 1,
                  anchor: { row, column },
                  active: { row, column },
                  preferredVisualColumn: column,
                }], { file, primaryId: 1, render: true });
              }
              editor.cursorController.setCursorPosition(row, column);
              await flushFrame();
              if (operation === "undo") {
                if (!editor.writerController.write("u")) throw Error("Could not prepare single-cursor undo");
                await flushFrame();
                const started = performance.now();
                if (!(await editor.historyController.undo())) throw Error("Single-cursor undo failed");
                latenciesMs.push(performance.now() - started);
                continue;
              }
              const started = performance.now();
              const changed = operation === "backspace"
                ? editor.writerController.delete(column, row)
                : editor.writerController.write(operation === "enter" ? "\\n" : "u");
              if (!changed) throw Error(\`Single-cursor \${operation} failed\`);
              latenciesMs.push(performance.now() - started);
              if (!(await editor.historyController.undo())) throw Error(\`Single-cursor \${operation} undo failed\`);
            }
            singleCursorOperations.push({
              operation,
              samples: operationSamples,
              medianMs: Number(percentile(latenciesMs, 0.5).toFixed(3)),
              p95Ms: Number(percentile(latenciesMs, 0.95).toFixed(3)),
            });
          }
          const monoCursorMovement = (() => {
            const multi = editor.multiCursorController;
            const movementSamples = 15;
            const movementWarmups = 1;
            const movementsPerSample = 250;
            const movementLatenciesMs = [];
            let movementColumn = column;
            const moveMonoCursor = () => {
              movementColumn = movementColumn === column ? column + 1 : column;
              editor.cursorController.setCursorPosition(row, movementColumn, {
                emitEvent: false,
                ensureVisible: false,
              });
            };
            if (supportsMultiCursor) {
              multi.setSelections([{
                id: 1,
                anchor: { row, column },
                active: { row, column },
                preferredVisualColumn: column,
              }], { file, primaryId: 1, render: false });
            }
            editor.cursorController.setCursorPosition(row, column, {
              emitEvent: false,
              ensureVisible: false,
            });
            for (let iteration = 0; iteration < movementWarmups + movementSamples; iteration++) {
              const started = performance.now();
              for (let move = 0; move < movementsPerSample; move++) moveMonoCursor();
              const perMovementMs = (performance.now() - started) / movementsPerSample;
              if (iteration >= movementWarmups) movementLatenciesMs.push(perMovementMs);
            }

            let normalizeSelectionsCalls = null;
            let overlayRefreshCalls = null;
            if (supportsMultiCursor) {
              normalizeSelectionsCalls = 0;
              overlayRefreshCalls = 0;
              const normalizeSelections = multi.normalizeSelections;
              const refreshOverlays = multi.refreshOverlays;
              multi.normalizeSelections = function (...args) {
                normalizeSelectionsCalls++;
                return normalizeSelections.apply(this, args);
              };
              multi.refreshOverlays = function (...args) {
                overlayRefreshCalls++;
                return refreshOverlays.apply(this, args);
              };
              try {
                for (let move = 0; move < 100; move++) moveMonoCursor();
              } finally {
                multi.normalizeSelections = normalizeSelections;
                multi.refreshOverlays = refreshOverlays;
              }
            }
            return {
              samples: movementSamples,
              movementsPerSample,
              medianMsPerMovement: Number(percentile(movementLatenciesMs, 0.5).toFixed(4)),
              p95MsPerMovement: Number(percentile(movementLatenciesMs, 0.95).toFixed(4)),
              profileMovements: supportsMultiCursor ? 100 : null,
              normalizeSelectionsCalls,
              overlayRefreshCalls,
            };
          })();
          const scrollLatenciesMs = [];
          for (let index = 0; index < 30; index++) {
            const target = index % 2 === 0 ? lineCount - 1 - index : index;
            const started = performance.now();
            editor.lineController.scrollTo(target);
            await flushFrame();
            scrollLatenciesMs.push(performance.now() - started);
          }
          const rendererHeapAfterBytes = performance.memory?.usedJSHeapSize ?? null;
          return {
            benchmark: supportsMultiCursor
              ? "NCE Electron renderer single- and multi-cursor editing"
              : "NCE Electron renderer pre-multi-cursor baseline",
            supportsMultiCursor,
            lineCount,
            warmups,
            samples,
            operationSamples,
            singleCursorOperations,
            monoCursorMovement,
            rendererHeapBeforeBytes,
            rendererHeapAfterBytes,
            scrollToP95Ms: Number(percentile(scrollLatenciesMs, 0.95).toFixed(3)),
            results,
          };
        })()`);
        report.electron = process.versions.electron;
        report.chromium = process.versions.chrome;
        fs.writeFileSync(
          path.join(directory, "multi-cursor-benchmark.json"),
          JSON.stringify(report, null, 2),
        );
        fs.writeFileSync(path.join(directory, `${phase}.ok`), "ok");
        await nce.requestQuitAll();
        return;
      }
      if (phase === "multiwindow") {
        traceStep("multiwindow workspace setup");
        const workspaceAInput = path.join(directory, "multi-window-a");
        const workspaceBInput = path.join(directory, "multi-window-b");
        fs.mkdirSync(workspaceAInput, { recursive: true });
        fs.mkdirSync(workspaceBInput, { recursive: true });
        const workspaceA = await fs.promises.realpath(workspaceAInput);
        const workspaceB = await fs.promises.realpath(workspaceBInput);
        const fileA = path.join(workspaceA, "window-a.js");
        const fileB = path.join(workspaceB, "window-b.js");
        fs.writeFileSync(fileA, "const owner = 'window-a';\n");
        fs.writeFileSync(fileB, "const owner = 'window-b';\n");

        const initialWindow = nce.windowManager.getAllWindows().find(candidate => candidate.window === win);
        assert.ok(initialWindow, "the initial BrowserWindow is registered");
        assert.equal(await run(`editor.fileExplorer.requestWorkspaceSwitch(${JSON.stringify(workspaceAInput)})`), true);
        await waitForCondition(
          async () => (await run(`editor.fileExplorer.rootPath === ${JSON.stringify(workspaceA)}`)) === true,
          { timeout: 10000, description: "Window A to open its workspace" },
        );

        assert.equal(await nce.windowManager.openWorkspaceInNewWindow(workspaceBInput), true);
        traceStep("second window creation requested");
        let windowA = null;
        let windowB = null;
        await waitForCondition(async () => {
          windowA = nce.windowManager.findWindowByWorkspace(workspaceA);
          windowB = nce.windowManager.findWindowByWorkspace(workspaceB);
          if (!windowA?.window || !windowB?.window || !windowB.rendererReady) return false;
          return windowB.window.webContents.executeJavaScript(
            `editor.isOnInit === false && editor.fileExplorer.rootPath === ${JSON.stringify(workspaceB)}`,
          );
        }, { timeout: 15000, description: "Window B renderer and workspace restoration" });
        traceStep("both workspace renderers ready");

        assert.equal(nce.windowManager.getAllWindows().length, 2);
        assert.notEqual(windowA.id, windowB.id);
        assert.notEqual(windowA.window.webContents, windowB.window.webContents);
        const runA = code => windowA.window.webContents.executeJavaScript(code);
        const runB = code => windowB.window.webContents.executeJavaScript(code);
        assert.deepEqual(await Promise.all([
          runA("editor.fileExplorer.rootPath"),
          runB("editor.fileExplorer.rootPath"),
        ]), [workspaceA, workspaceB]);
        assert.match(windowA.window.getTitle(), /multi-window-a$/);
        assert.match(windowB.window.getTitle(), /multi-window-b$/);

        await Promise.all([
          runA(`editor.tabManager.openFileWithPath(${JSON.stringify(fileA)}).then(() => true)`),
          runB(`editor.tabManager.openFileWithPath(${JSON.stringify(fileB)}).then(() => true)`),
        ]);
        assert.deepEqual(await Promise.all([
          runA("editor.tabManager.tabs.map(tab => tab.path)"),
          runB("editor.tabManager.tabs.map(tab => tab.path)"),
        ]), [[fileA], [fileB]]);

        const workspaceCInput = path.join(directory, "multi-window-c");
        fs.mkdirSync(workspaceCInput, { recursive: true });
        const workspaceC = await fs.promises.realpath(workspaceCInput);
        assert.equal(await nce.windowManager.openWorkspaceInNewWindow(workspaceCInput), true);
        let windowC = null;
        await waitForCondition(async () => {
          windowC = nce.windowManager.findWindowByWorkspace(workspaceC);
          if (!windowC?.window || !windowC.rendererReady) return false;
          return windowC.window.webContents.executeJavaScript(
            `editor.isOnInit === false && editor.fileExplorer.rootPath === ${JSON.stringify(workspaceC)}`,
          );
        }, { timeout: 15000, description: "Window C renderer and workspace restoration" });
        const runC = code => windowC.window.webContents.executeJavaScript(code);

        const externalFile = path.join(directory, "external drop é with spaces.js");
        const externalFileTwo = path.join(directory, "external drop two.js");
        fs.writeFileSync(externalFile, "const external = 'disk';\n", "utf8");
        fs.writeFileSync(externalFileTwo, "const externalTwo = true;\n", "utf8");
        const externalFilePath = await fs.promises.realpath(externalFile);
        const externalFileTwoPath = await fs.promises.realpath(externalFileTwo);
        const dropResult = await runB(
          `window.api.openDroppedFiles(${JSON.stringify([externalFile, externalFileTwo, externalFile])})`,
        );
        assert.equal(dropResult.success, true);
        assert.equal(dropResult.openedFiles, 2, "unique files open once and repeated paths resolve to one tab");
        await waitForCondition(
          async () => (await runB(`editor.tabManager.tabs.filter(tab => [${JSON.stringify(externalFilePath)}, ${JSON.stringify(externalFileTwoPath)}].includes(tab.path)).length`)) === 2,
          { timeout: 10000, description: "external files delivered to the receiving window" },
        );
        assert.deepEqual(await Promise.all([
          runA("editor.tabManager.tabs.map(tab => tab.path)"),
          runB("editor.tabManager.tabs.map(tab => tab.path)"),
          runC("editor.tabManager.tabs.map(tab => tab.path)"),
          runB("editor.fileExplorer.rootPath"),
        ]), [
          [fileA],
          [fileB, externalFilePath, externalFileTwoPath],
          [],
          workspaceB,
        ], "the real IPC sender owns the file drop and its workspace is unchanged");

        const dirtyContents = "const external = 'unsaved';";
        assert.equal(await runB(`(() => {
          const file = editor.tabManager.getFileByPath(${JSON.stringify(externalFilePath)});
          file.lines[0].setText(${JSON.stringify(dirtyContents)});
          file.isSaved = false;
          return file.serializeContent();
        })()`), `${dirtyContents}\n`);
        const redropResult = await runB(
          `window.api.openDroppedFiles(${JSON.stringify([externalFilePath])})`,
        );
        assert.equal(redropResult.openedFiles, 1);
        assert.equal(await runB(`(() => {
          const tabs = editor.tabManager.tabs.filter(tab => tab.path === ${JSON.stringify(externalFilePath)});
          return tabs.length === 1 && tabs[0].isSaved === false &&
            tabs[0].serializeContent() === ${JSON.stringify(`${dirtyContents}\n`)};
        })()`), true, "redropping an open file focuses its unsaved buffer without reloading disk contents");
        await runB(`(() => {
          editor.tabManager.getFileByPath(${JSON.stringify(externalFilePath)}).isSaved = true;
          return true;
        })()`);

        const droppedWorkspaceInput = path.join(directory, "dropped-folder");
        fs.mkdirSync(droppedWorkspaceInput, { recursive: true });
        const droppedWorkspace = await fs.promises.realpath(droppedWorkspaceInput);
        const mixedDropResult = await runB(
          `window.api.openDroppedFiles(${JSON.stringify([externalFilePath, droppedWorkspaceInput])})`,
        );
        assert.equal(mixedDropResult.openedFiles, 1);
        assert.equal(mixedDropResult.openedFolders, 1);
        let droppedWorkspaceWindow = null;
        await waitForCondition(() => {
          droppedWorkspaceWindow = nce.windowManager.findWindowByWorkspace(droppedWorkspace);
          return Boolean(droppedWorkspaceWindow?.window && droppedWorkspaceWindow.rendererReady);
        }, { timeout: 15000, description: "dropped folder to open in its own workspace window" });
        assert.equal(await runB("editor.fileExplorer.rootPath"), workspaceB,
          "dropping a folder does not replace the receiving window workspace");
        assert.deepEqual(await droppedWorkspaceWindow.window.webContents.executeJavaScript(
          "editor.tabManager.tabs.map(tab => tab.path)",
        ), [], "mixed drops keep their files out of folder windows");
        await droppedWorkspaceWindow.requestQuit();
        await droppedWorkspaceWindow.waitForDisposal();
        await windowC.requestQuit();
        await windowC.waitForDisposal();

        if (process.env.NCE_ELECTRON_SMOKE_EXTERNAL_ONLY === "1") {
          fs.writeFileSync(path.join(directory, `${phase}.ok`), "ok");
          traceStep("external file and folder routing checks passed");
          assert.equal(await nce.requestQuitAll(), true, "external open smoke windows quit cleanly");
          return;
        }

        const initialAutoSave = await runA("window.api.getSetting('files.autoSave')");
        await runB(`(() => {
          window.__multiWindowSettingsChange = new Promise(resolve => {
            window.__multiWindowSettingsUnsubscribe = window.api.onSettingsChanged(resolve);
            setTimeout(() => resolve(null), 5000);
          });
          return true;
        })()`);
        assert.equal(await runA(`window.api.setSetting('files.autoSave', ${JSON.stringify(!initialAutoSave)})`), true);
        const changedSettings = await runB("window.__multiWindowSettingsChange");
        assert.equal(changedSettings?.files?.autoSave, !initialAutoSave,
          "global settings changes broadcast to the other live window");
        await runB("window.__multiWindowSettingsUnsubscribe?.(); true");

        await Promise.all([
          runA('editor.bottomPanelManager.openPanel("terminal")'),
          runB('editor.bottomPanelManager.openPanel("terminal")'),
        ]);
        await waitForCondition(async () => {
          const sessions = await Promise.all([
            runA("[...editor.terminalPanel.sessions.keys()]"),
            runB("[...editor.terminalPanel.sessions.keys()]"),
          ]);
          return sessions.every(value => Array.isArray(value) && value.length === 1);
        }, { timeout: 15000, description: "independent terminal sessions in both windows" });
        traceStep("both window-owned PTYs started");
        const [terminalA, terminalB] = await Promise.all([
          runA("[...editor.terminalPanel.sessions.keys()][0]"),
          runB("[...editor.terminalPanel.sessions.keys()][0]"),
        ]);
        assert.notEqual(terminalA, terminalB, "each window creates a distinct PTY session");
        assert.equal(windowA.terminalManager.sessions.has(terminalA), true);
        assert.equal(windowA.terminalManager.sessions.has(terminalB), false);
        assert.equal(windowB.terminalManager.sessions.has(terminalB), true);
        assert.equal(windowB.terminalManager.sessions.has(terminalA), false);

        const countBeforeDuplicate = nce.windowManager.getAllWindows().length;
        assert.equal(await nce.windowManager.openWorkspaceInNewWindow(workspaceAInput), true);
        assert.equal(nce.windowManager.getAllWindows().length, countBeforeDuplicate,
          "opening an already-open workspace focuses its existing window");
        await waitForCondition(
          () => nce.windowManager.getFocusedWindow() === windowA,
          { timeout: 5000, description: "existing workspace window to receive focus" },
        );

        const windowBId = windowB.id;
        const windowBProcess = windowB.terminalManager;
        traceStep("closing Window B");
        windowB.window.close();
        await waitForCondition(
          () => !nce.windowManager.windows.has(windowBId),
          { timeout: 15000, description: "native close button to close only Window B" },
        );
        await windowB.waitForDisposal();
        assert.equal(nce.windowManager.getAllWindows().length, 1);
        assert.equal(nce.windowManager.getAllWindows()[0], windowA);
        assert.equal(windowA.window.isDestroyed(), false);
        assert.equal(windowA.terminalManager.sessions.size, 1,
          "closing B preserves Window A's live PTY");
        assert.equal(windowBProcess.sessions.size, 0,
          "closing B releases only its PTY resources");
        assert.equal(nce.windowManager.windows.has(windowBId), false);

        fs.writeFileSync(path.join(directory, `${phase}.ok`), "ok");
        traceStep("Window B closed; quitting Window A");
        assert.equal(await nce.requestQuitAll(), true, "the remaining windows quit cleanly");
        return;
      }
      if (phase === "write") {
        traceStep("cold-start and settings checks started");
        assert.equal(
          await run('typeof Agent === "undefined" && typeof AgentSidebar === "undefined" && typeof MarkdownRenderer === "undefined" && typeof window.NCE_TERMINAL_RUNTIME === "undefined"'),
          true,
          "cold startup must not load Agent, Markdown, or xterm code",
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
        traceStep("Agent settings cold-start checks passed");
        const largeWorkspaceRootA = JSON.stringify(path.join(directory, "workspace-a"));
        const largeWorkspaceRootB = JSON.stringify(path.join(directory, "workspace-b"));
        const workspaceHeader = await run(`(() => {
          const explorer = editor.fileExplorer;
          explorer.rootPath = ${largeWorkspaceRootA};
          explorer.projectName = "Workspace A";
          explorer.files = [];
          explorer.isLoaded = true;
          editor.sidebarManager.openMenu("file-explorer");
          explorer.refresh();
          const shell = explorer.shell;
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
          const arrowRect = explorer.projectArrow.getBoundingClientRect();
          const headerRect = explorer.projectHeader.getBoundingClientRect();
          const outsideRect = explorer.treeViewport.getBoundingClientRect();
          const originalName = explorer.projectName;
          explorer.projectName = "Workspace Name ".repeat(16);
          explorer.refresh();
          const longName = {
            text: explorer.projectTitle.textContent,
            tooltip: explorer.projectTitle.title,
            overflow: getComputedStyle(explorer.projectTitle).textOverflow,
            whiteSpace: getComputedStyle(explorer.projectTitle).whiteSpace,
          };
          explorer.projectName = originalName;
          explorer.refresh();
          return {
            title: { x: titleRect.x, y: titleRect.y, width: titleRect.width, height: titleRect.height },
            arrow: { x: arrowRect.x, y: arrowRect.y, width: arrowRect.width, height: arrowRect.height },
            header: { x: headerRect.x, y: headerRect.y, width: headerRect.width, height: headerRect.height },
            outside: { x: outsideRect.x, y: outsideRect.y, width: outsideRect.width, height: outsideRect.height },
            headerCount: shell.querySelectorAll(".sidebar-project-header").length,
            mainTitleCount: shell.querySelectorAll(".sidebar-main-title").length,
            duplicateTitleCount: shell.querySelectorAll(".sidebar-main-title:not(.sidebar-project-header)").length,
            badgeCount: shell.querySelectorAll(".file-explorer-large-workspace").length,
            dialogCount: document.querySelectorAll("#file-explorer-large-workspace-dialog").length,
            headerName: explorer.projectTitle.textContent,
            headerPathTooltip: explorer.projectTitle.title,
            headerRole: explorer.projectHeader.getAttribute("role"),
            headerExpanded: explorer.projectHeader.getAttribute("aria-expanded"),
            longName,
          };
        })()`);
        assert.equal(workspaceHeader.headerCount, 1);
        assert.equal(workspaceHeader.mainTitleCount, 1);
        assert.equal(workspaceHeader.duplicateTitleCount, 0);
        assert.equal(workspaceHeader.badgeCount, 0);
        assert.equal(workspaceHeader.dialogCount, 0);
        assert.equal(workspaceHeader.headerName, "WORKSPACE A");
        assert.equal(workspaceHeader.headerPathTooltip, `Workspace A\n${path.join(directory, "workspace-a")}`);
        assert.equal(workspaceHeader.headerRole, "button");
        assert.equal(workspaceHeader.headerExpanded, "true");
        assert.equal(workspaceHeader.longName.text, "WORKSPACE NAME ".repeat(16));
        assert.match(workspaceHeader.longName.tooltip, /Workspace Name .*\n/);
        assert.equal(workspaceHeader.longName.overflow, "ellipsis");
        assert.equal(workspaceHeader.longName.whiteSpace, "nowrap");
        traceStep("workspace header checks passed");
        win.focus();
        const moveMouseTo = (rect) => win.webContents.sendInputEvent({
          type: "mouseMove",
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        });
        assert.deepEqual(await run(`(() => {
          const header = editor.fileExplorer.projectHeader;
          header.click();
          const collapsed = {
            expanded: header.getAttribute("aria-expanded"),
            viewportHidden: editor.fileExplorer.treeViewport.hidden,
          };
          header.click();
          return {
            collapsed,
            expanded: header.getAttribute("aria-expanded"),
            viewportHidden: editor.fileExplorer.treeViewport.hidden,
          };
        })()`), {
          collapsed: { expanded: "false", viewportHidden: true },
          expanded: "true",
          viewportHidden: false,
        });

        const workspaceContextMenu = await run(`(() => {
          const manager = editor.contextMenuManager;
          const openContextMenu = manager.openContextMenu;
          let opened = null;
          manager.openContextMenu = (...args) => { opened = args; };
          try {
            const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
            editor.fileExplorer.projectHeader.dispatchEvent(event);
            return { opened, prevented: event.defaultPrevented };
          } finally {
            manager.openContextMenu = openContextMenu;
          }
        })()`);
        assert.deepEqual(workspaceContextMenu, {
          opened: ["file-explorer-project", null],
          prevented: true,
        });

        moveMouseTo(workspaceHeader.outside);
        await waitForCondition(
          async () => (await run("!editor.fileExplorer.projectHeader.matches(':hover')")) === true,
          { description: "pointer to leave the workspace header" },
        );
        const workspaceNameRestingColor = await run(
          "getComputedStyle(editor.fileExplorer.projectTitle).color",
        );
        const headerRestingBackground = await run(
          "getComputedStyle(editor.fileExplorer.projectHeader).backgroundColor",
        );
        moveMouseTo(workspaceHeader.title);
        await waitForCondition(
          async () => (await run("editor.fileExplorer.projectTitle.matches(':hover')")) === true,
          { description: "pointer to hover the workspace name" },
        );
        assert.notEqual(
          await run("getComputedStyle(editor.fileExplorer.projectTitle).color"),
          workspaceNameRestingColor,
          "hover changes only the workspace name appearance",
        );
        assert.equal(
          await run("getComputedStyle(editor.fileExplorer.projectHeader).backgroundColor"),
          headerRestingBackground,
          "hover does not draw a box across the workspace header",
        );
        moveMouseTo(workspaceHeader.arrow);
        await waitForCondition(
          async () => (await run("!editor.fileExplorer.projectTitle.matches(':hover')")) === true,
          { description: "pointer to leave the workspace name" },
        );
        assert.equal(
          await run("getComputedStyle(editor.fileExplorer.projectTitle).color"),
          workspaceNameRestingColor,
          "hover styling does not extend from the title to the header",
        );
        assert.equal(
          await run("getComputedStyle(editor.fileExplorer.projectHeader).backgroundColor"),
          headerRestingBackground,
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
            headerName: explorer.projectTitle.textContent,
            headerPath: explorer.projectTitle.title,
            headerCount: explorer.shell.querySelectorAll(".sidebar-project-header").length,
            duplicateTitleCount: explorer.shell.querySelectorAll(".sidebar-main-title:not(.sidebar-project-header)").length,
            badgeCount: explorer.shell.querySelectorAll(".file-explorer-large-workspace").length,
            dialogCount: document.querySelectorAll("#file-explorer-large-workspace-dialog").length,
          };
        })()`);
        assert.deepEqual(largeWorkspaceB, {
          oldStatsAccepted: false,
          currentStatsAccepted: true,
          headerName: "WORKSPACE B",
          headerPath: `Workspace B\n${path.join(directory, "workspace-b")}`,
          headerCount: 1,
          duplicateTitleCount: 0,
          badgeCount: 0,
          dialogCount: 0,
        });
        await run(`(() => {
          const explorer = editor.fileExplorer;
          explorer.clearWorkspaceIndexStats();
          explorer.rootPath = "";
          explorer.projectName = "";
          explorer.projectExpanded = false;
          explorer.refresh();
        })()`);
        assert.deepEqual(await run(`(() => {
          const explorer = editor.fileExplorer;
          let opened = null;
          const manager = editor.contextMenuManager;
          const openContextMenu = manager.openContextMenu;
          manager.openContextMenu = (...args) => { opened = args; };
          let event;
          try {
            event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
            explorer.projectHeader.dispatchEvent(event);
          } finally {
            manager.openContextMenu = openContextMenu;
          }
          const snapshot = {
            title: explorer.projectTitle.textContent,
            headerCount: explorer.shell.querySelectorAll(".sidebar-project-header").length,
            duplicateTitleCount: explorer.shell.querySelectorAll(".sidebar-main-title:not(.sidebar-project-header)").length,
            role: explorer.projectHeader.getAttribute("role"),
            expanded: explorer.projectHeader.getAttribute("aria-expanded"),
            arrowHidden: explorer.projectArrow.hidden,
            tabIndex: explorer.projectHeader.tabIndex,
            viewportHidden: explorer.treeViewport.hidden,
            openFolderHidden: explorer.openFolderButton.hidden,
            contextMenu: opened,
            defaultPrevented: event.defaultPrevented,
          };
          explorer.projectHeader.click();
          snapshot.expandedAfterClick = explorer.projectExpanded;
          return snapshot;
        })()`), {
          title: "EXPLORER",
          headerCount: 1,
          duplicateTitleCount: 0,
          role: null,
          expanded: null,
          arrowHidden: true,
          tabIndex: -1,
          viewportHidden: false,
          openFolderHidden: false,
          contextMenu: ["sidebar-title", { menuId: "file-explorer" }],
          defaultPrevented: true,
          expandedAfterClick: false,
        });
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
      traceStep("quick-open keyboard checks started");
      if (process.platform === "darwin") {
        const quickOpenMenuItem = findMenuItem(
          nce.window.appMenu.menu,
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
          nce.window.appMenu.menu,
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
            findMenuItem(nce.window.appMenu.menu, "Go to Line...").enabled ===
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
        traceStep("quick-open and modal keyboard checks passed");
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
            nce.window.appMenu.menu,
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
            nce.window.appMenu.menu,
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
        const checkboxPresentation = await run(`(() => {
          const root = document.documentElement;
          const oldTheme = root.getAttribute("data-theme");
          const label = editor.fileExplorer.deleteDialogCheckboxLabel;
          const input = editor.fileExplorer.deleteDialogCheckbox;
          const box = label.querySelector(".nce-checkbox-box");
          const settleTransitions = () => {
            for (const transition of box.getAnimations({ subtree: true }))
              transition.finish();
          };
          const rect = box.getBoundingClientRect();
          root.setAttribute("data-theme", "dark");
          settleTransitions();
          const darkUnchecked = getComputedStyle(box).backgroundColor;
          input.checked = true;
          settleTransitions();
          const darkChecked = getComputedStyle(box).backgroundColor;
          const darkTickOpacity = getComputedStyle(box.querySelector("svg")).opacity;
          root.setAttribute("data-theme", "light");
          settleTransitions();
          input.checked = false;
          settleTransitions();
          const lightUnchecked = getComputedStyle(box).backgroundColor;
          input.checked = true;
          settleTransitions();
          const lightChecked = getComputedStyle(box).backgroundColor;
          const lightTickOpacity = getComputedStyle(box.querySelector("svg")).opacity;
          input.checked = false;
          settleTransitions();
          const result = {
            type: input.type,
            tabIndex: input.tabIndex,
            appearance: getComputedStyle(input).appearance,
            opacity: getComputedStyle(input).opacity,
            width: rect.width,
            height: rect.height,
            darkUnchecked,
            darkChecked,
            lightUnchecked,
            lightChecked,
            darkTickOpacity,
            lightTickOpacity,
            svgPath: box.querySelector("path")?.getAttribute("d"),
          };
          if (oldTheme === null) root.removeAttribute("data-theme");
          else root.setAttribute("data-theme", oldTheme);
          return result;
        })()`);
        assert.equal(checkboxPresentation.type, "checkbox");
        assert.equal(checkboxPresentation.tabIndex, 0);
        assert.equal(checkboxPresentation.appearance, "none");
        assert.equal(checkboxPresentation.opacity, "0");
        assert.equal(checkboxPresentation.width, 18);
        assert.equal(checkboxPresentation.height, 18);
        assert.notEqual(checkboxPresentation.darkUnchecked, checkboxPresentation.darkChecked);
        assert.notEqual(checkboxPresentation.lightUnchecked, checkboxPresentation.lightChecked);
        assert.notEqual(checkboxPresentation.darkUnchecked, checkboxPresentation.lightUnchecked);
        assert.notEqual(checkboxPresentation.darkChecked, checkboxPresentation.lightChecked);
        assert.equal(checkboxPresentation.darkTickOpacity, "1");
        assert.equal(checkboxPresentation.lightTickOpacity, "1");
        assert.match(checkboxPresentation.svgPath, /^M/);
        const checkboxClickBehavior = await run(`(() => {
          const input = editor.fileExplorer.deleteDialogCheckbox;
          const text = editor.fileExplorer.deleteDialogCheckboxLabel.querySelector(".nce-checkbox-text");
          window.__nceCheckboxChangeCount = 0;
          input.addEventListener("change", () => window.__nceCheckboxChangeCount++);
          text.click();
          const afterText = { checked: input.checked, changes: window.__nceCheckboxChangeCount };
          input.click();
          const afterInput = { checked: input.checked, changes: window.__nceCheckboxChangeCount };
          input.disabled = true;
          text.click();
          input.click();
          const disabled = { checked: input.checked, changes: window.__nceCheckboxChangeCount };
          const disabledOpacity = getComputedStyle(editor.fileExplorer.deleteDialogCheckboxLabel).opacity;
          input.disabled = false;
          return { afterText, afterInput, disabled, disabledOpacity };
        })()`);
        assert.deepEqual(checkboxClickBehavior.afterText, { checked: true, changes: 1 });
        assert.deepEqual(checkboxClickBehavior.afterInput, { checked: false, changes: 2 });
        assert.deepEqual(checkboxClickBehavior.disabled, { checked: false, changes: 2 });
        assert.notEqual(checkboxClickBehavior.disabledOpacity, "1");
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
        await run("editor.fileExplorer.deleteDialogCancelButton.focus()");
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
        assert.equal(
          await run("document.activeElement === editor.fileExplorer.deleteDialogCheckbox"),
          true,
        );
        sendKeyboardKey("Space");
        await waitForCondition(
          async () => (await run("editor.fileExplorer.deleteDialogCheckbox.checked")) === true,
          { description: "Space toggles the focused NCE checkbox" },
        );
        assert.equal(await run("window.__nceCheckboxChangeCount"), 3);
        sendKeyboardKey("Space");
        await waitForCondition(
          async () => (await run("editor.fileExplorer.deleteDialogCheckbox.checked")) === false,
          { description: "Space toggles the focused NCE checkbox off" },
        );
        assert.equal(await run("window.__nceCheckboxChangeCount"), 4);
        await run("editor.fileExplorer.deleteDialogDeleteButton.focus()");
        await waitForCondition(
          async () => (await run("document.activeElement === editor.fileExplorer.deleteDialogDeleteButton")) === true,
          { description: "Delete dialog focus on the destructive action" },
        );
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
        const multiCursorFileId = await run(`(() => {
          const file = editor.tabManager.createEmptyFile();
          return file.id;
        })()`);
        await waitForCondition(
          async () => (await run(`editor.tabManager.activeFile?.id === ${JSON.stringify(multiCursorFileId)} &&
            editor.tabManager.activeFile.isLoaded &&
            editor.tabManager.activeFile.lines?.length === 1 &&
            typeof editor.tabManager.activeFile.lines[0]?.getText === "function" &&
            editor.lineController.lines[0] === editor.tabManager.activeFile.lines[0]`)) === true,
          { description: "multi-cursor Electron fixture to finish loading" },
        );
        assert.equal(await run(`(() => {
          const file = editor.tabManager.activeFile;
          editor.cursorController.setCursorPosition(1, 0);
          editor.writerController.write("red\\nred\\nred");
          editor.cursorController.setCursorPosition(1, 3);
          return file.serializeContent();
        })()`), "red\nred\nred");
        for (const row of [2, 3]) {
          const point = await run(`(() => {
            const row = ${row};
            const column = 3;
            const editor = window.editor;
            const controller = editor.cursorController;
            const lines = editor.lineController;
            const rect = editor.domManager.getOutputRect();
            const screenRow = lines.getDisplayIndexForCursor(row) - lines.startIndex;
            const baseX = rect.left + column * editor.letterSize + editor.letterSize * 0.1;
            const baseY = rect.top + controller.mY + editor.baseY +
              (screenRow + 0.1) * editor.posY - lines.getScrollOffsetY();
            for (let dy = -8; dy <= 8; dy++) {
              for (let dx = -8; dx <= 8; dx++) {
                const x = baseX + dx;
                const y = baseY + dy;
                const position = controller.positionFromClientCoordinates(x, y, true);
                if (position?.row === row && position.column === column)
                  return { x, y, position };
              }
            }
            return null;
          })()`);
          assert.ok(point, `a visible mouse coordinate maps to row ${row}, column 3`);
          win.focus();
          win.webContents.sendInputEvent({
            type: "mouseDown", x: Math.round(point.x), y: Math.round(point.y),
            button: "left", modifiers: ["alt"],
          });
          win.webContents.sendInputEvent({
            type: "mouseUp", x: Math.round(point.x), y: Math.round(point.y),
            button: "left", modifiers: ["alt"],
          });
          await waitForCondition(
            async () => (await run("editor.multiCursorController.getSelections().length")) === row,
            { description: `Option-click to add the cursor on row ${row}` },
          );
        }
        assert.deepEqual(await run("editor.multiCursorController.getSelections().map(selection => selection.active)"), [
          { row: 1, column: 3 }, { row: 2, column: 3 }, { row: 3, column: 3 },
        ]);
        const multiTyping = await run(`(() => {
          const handled = editor.smartTypingController.handleCharacter("x", { key: "x" });
          return {
            handled,
            content: editor.tabManager.activeFile.serializeContent().split(String.fromCharCode(10)).join("|"),
            selections: editor.multiCursorController.getSelections().map(selection => selection.active),
          };
        })()`);
        assert.equal(multiTyping.handled, true);
        assert.equal(multiTyping.content, "redx|redx|redx", "Smart Typing inserts at all three Electron cursors");
        assert.equal(await run("editor.historyController.undo()"), true);
        assert.equal(await run("editor.tabManager.activeFile.serializeContent()"), "red\nred\nred");
        assert.equal(await run("editor.historyController.redo()"), true);
        assert.equal(await run("editor.tabManager.activeFile.serializeContent()"), "redx\nredx\nredx");
        const savedFileId = await run(`editor.tabManager.tabs.find(file => file.path === ${JSON.stringify(target)})?.id`);
        assert.ok(savedFileId, "the previously saved file remains open while the multi-cursor fixture is active");
        assert.equal(await run(`(async () => {
          const manager = editor.tabManager;
          const fixture = manager.activeFile;
          await manager.setFocusTab(manager.tabs.find(file => file.id === ${JSON.stringify(savedFileId)}));
          await manager.setFocusTab(fixture);
          return editor.multiCursorController.getSelections().length;
        })()`), 3, "switching tabs restores the fixture's own cursors");
        assert.equal(await run("editor.historyController.undo()"), true);
        assert.equal(await run("editor.historyController.undo()"), true);
        assert.equal(await run("editor.tabManager.activeFile.serializeContent()"), "");
        assert.equal(await run("editor.tabManager.closeTab(editor.tabManager.activeFile)"), true);
        await run(`editor.tabManager.setFocusTab(editor.tabManager.tabs.find(file => file.path === ${JSON.stringify(target)}))`);
        if (process.platform === "darwin") {
          await waitForCondition(
            async () =>
              findMenuItem(nce.window.appMenu.menu, "Go to Line...")
                .enabled === true,
            { description: "file menu actions to enable after opening a file" },
          );
        }
        traceStep("editor UI and Save As checks passed");
      } else if (phase === "tabs") {
        traceStep("large-file and tab-scroll checks started");
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
        traceStep("large-file and tab-scroll checks passed");

        const sidebarOriginalBounds = win.getBounds();
        const sidebarWasMaximized = win.isMaximized();
        traceStep(`sidebar layout checks started (maximized=${sidebarWasMaximized}, bounds=${JSON.stringify(sidebarOriginalBounds)})`);
        const restoreNativeWindowState = async (description) => {
          if (win.isMinimized()) win.restore();
          if (process.platform === "darwin") app.focus({ steal: true });
          win.show();
          win.focus();
          if (win.isFullScreen()) {
            win.setFullScreen(false);
            await waitForCondition(
              () => !win.isFullScreen(),
              { timeout: 10000, description: `${description}: window to leave fullscreen` },
            );
          }
          if (win.isMaximized()) {
            win.unmaximize();
            try {
              await waitForCondition(
                () => !win.isMaximized(),
                { timeout: 10000, description },
              );
            } catch (error) {
              const bounds = win.getBounds();
              throw new Error(`${error.message}; BrowserWindow=${JSON.stringify({
                maximized: win.isMaximized(),
                fullscreen: win.isFullScreen(),
                minimized: win.isMinimized(),
                focused: win.isFocused(),
                bounds,
                normalBounds: win.getNormalBounds(),
              })}`, { cause: error });
            }
          }
        };
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
          await restoreNativeWindowState(`${description}: window to unmaximize`);
          const bounds = win.getBounds();
          const workArea = screen.getDisplayMatching(bounds).workArea;
          const targetWidth = Math.min(width, Math.max(1, workArea.width - 20));
          win.setBounds({ ...bounds, x: workArea.x, width: targetWidth });
          await waitForCondition(
            () => !win.isMaximized() && win.getBounds().width === targetWidth,
            { timeout: 5000, description: `${description}: BrowserWindow width ${targetWidth}` },
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
            await restoreNativeWindowState("BrowserWindow to unmaximize for sidebar layout test");
          }
          traceStep("sidebar layout checks started");
          const wideLayout = await setSidebarTestWindowWidth(
            1400,
            "wide sidebar layout",
          );
          const sidebarCapacity = wideLayout.mainWidth - 48 - wideLayout.minEditorWidth;
          const sidebarScale = Math.min(1, sidebarCapacity / (400 + 420));
          const sidebarLeftTarget = Math.floor(400 * sidebarScale);
          const sidebarRightTarget = Math.floor(420 * sidebarScale);
          const sidebarInitialLeft = Math.floor(sidebarLeftTarget * 0.75);
          const sidebarInitialRight = Math.floor(sidebarRightTarget * (250 / 420));
          assert.ok(
            sidebarCapacity >= 400,
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
          sidebarResizer.applyWidth(${sidebarInitialLeft}, "left");
          sidebarResizer.applyWidth(${sidebarInitialRight}, "right");
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

          sidebarResizer.applyWidth(${sidebarLeftTarget}, "left");
          await nextLayout();
          const resizedLeft = snapshot();

          sidebarResizer.applyWidth(${sidebarRightTarget}, "right");
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
        assert.equal(sidebarLayoutStates.left.effectiveLeftWidth, sidebarInitialLeft);
        assert.equal(sidebarLayoutStates.left.effectiveRightWidth, 0);
        assert.equal(sidebarLayoutStates.right.effectiveLeftWidth, 0);
        assert.equal(sidebarLayoutStates.right.effectiveRightWidth, sidebarInitialRight);
        assert.equal(sidebarLayoutStates.resizedLeft.effectiveLeftWidth, sidebarLeftTarget);
        assert.equal(sidebarLayoutStates.resizedLeft.effectiveRightWidth, sidebarInitialRight);
        assert.equal(sidebarLayoutStates.resizedRight.effectiveLeftWidth, sidebarLeftTarget);
        assert.equal(sidebarLayoutStates.resizedRight.effectiveRightWidth, sidebarRightTarget);

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
          narrowSidebarLayout.effectiveLeftWidth < sidebarLeftTarget ||
            narrowSidebarLayout.effectiveRightWidth < sidebarRightTarget,
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
          editor.sidebarResizer.applyWidth(${sidebarLeftTarget}, "left");
          editor.sidebarResizer.applyWidth(${sidebarRightTarget}, "right");
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        })()`);
        await setSidebarTestWindowWidth(1400, "expanded sidebar layout");
        expandedSidebarLayout = await waitForSidebarLayout(
          "sidebars to restore requested widths after window expand",
        );
        assertSidebarLayout(expandedSidebarLayout);
        assert.equal(expandedSidebarLayout.effectiveLeftWidth, sidebarLeftTarget);
        assert.equal(expandedSidebarLayout.effectiveRightWidth, sidebarRightTarget);

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

        const tabThumb = await run(`(() => {
          const scroller = editor.tabManager.tabScroller.hScroller;
          const rect = scroller.itemOBJ.getBoundingClientRect();
          return {
            active: scroller.active,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0,
          };
        })()`);
        assert.equal(tabThumb.active, true);
        assert.equal(tabThumb.visible, true,
          "the tab thumb is measured after restoring the window layout");
        const dragY = Math.round(tabThumb.top + tabThumb.height / 2);
        const thumbCenterX = Math.round(tabThumb.left + tabThumb.width / 2);
        if (process.platform === "darwin") app.focus({ steal: true });
        win.focus();
        await waitForCondition(
          () => win.isFocused() && win.webContents.isFocused(),
          { description: "the Electron window to own pointer focus before the tab thumb drag" },
        );
        win.webContents.sendInputEvent({
          type: "mouseMove",
          x: thumbCenterX,
          y: dragY,
        });
        await waitForCondition(
          async () =>
            (await run("editor.tabManager.tabScroller.hScroller.itemOBJ.matches(':hover')")) === true,
          {
            timeout: 3000,
            description: "the tab thumb to receive pointer hover after the window layout is restored",
          },
        );
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
        traceStep(`window resize checks started (maximized=${wasMaximized}, bounds=${JSON.stringify(originalBounds)})`);
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
            await restoreNativeWindowState("BrowserWindow to leave maximized state");
            await waitForStableBounds("restored BrowserWindow bounds to settle");
            await waitForRendererResize(
              beforeUnmaximize,
              "renderer layout to follow unmaximize",
            );
          }

          const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
          const expandedWidth = Math.min(1050, workArea.width - 40);
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
            const maximizeChangesRendererWidth =
              Math.abs(win.getContentBounds().width - beforeRestore.innerWidth) > 1;
            await waitForRendererResize(
              beforeRestore,
              "renderer layout to follow restored maximize",
              maximizeChangesRendererWidth,
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
          // Reload follows the normal unsaved-buffer workflow; choosing
          // Don't Save discards this buffer's recovery snapshot.
          dialog.showMessageBox = async () => ({ response: 1 });
          assert.equal(
            await run("editor.keyBinding.control_reload_window()"),
            true,
            "the configured reload action completes its unsaved-buffer workflow",
          );
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
          const bufferAfterReload = await run(`(() => {
              const file = editor.tabManager.tabs.find(tab =>
                tab.type === "file" && !tab.path &&
                tab.recoveryUntitledId === "electron-smoke-recovery");
              return file ? { content: file.serializeContent(), dirty: file.isSaved === false } : null;
            })()`);
          assert.deepEqual(
            bufferAfterReload,
            { content: "", dirty: false },
            "Don't Save discards recovered content instead of restoring it after reload",
          );
        } finally {
          win.webContents.removeListener("did-finish-load", onDidFinishLoad);
          win.webContents.removeListener("render-process-gone", onRenderProcessGone);
        }
      }
      if (phase === "write") {
        traceStep("terminal isolation checks started");
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
        traceStep("Agent Settings lazy-load check passed");
        const terminalWorkspaceA = path.join(directory, "terminal-workspace-a");
        const terminalWorkspaceB = path.join(directory, "terminal-workspace-b");
        fs.mkdirSync(terminalWorkspaceA, { recursive: true });
        fs.mkdirSync(terminalWorkspaceB, { recursive: true });
        const canonicalTerminalWorkspaceA = await fs.promises.realpath(terminalWorkspaceA);
        const canonicalTerminalWorkspaceB = await fs.promises.realpath(terminalWorkspaceB);
        assert.equal(
          await run(`editor.fileExplorer.requestWorkspaceSwitch(${JSON.stringify(terminalWorkspaceA)})`),
          true,
          "the terminal isolation smoke test opens workspace A through the real switch flow",
        );
        assert.equal(
          await run('editor.bottomPanelManager.openPanel("terminal")'),
          true,
          "opening the Bottom Panel loads the lazy terminal view",
        );
        traceStep("workspace A terminal panel opened");
        await waitForCondition(
          async () => (await run(`(() => {
            const panel = editor.terminalPanel;
            return typeof window.NCE_TERMINAL_RUNTIME?.createPanel === "function" &&
              panel?.sessions?.size === 1 &&
              [...panel.sessions.values()][0]?.id;
          })()`)),
          { timeout: 15000, description: "lazy Terminal bundle and first PTY session" },
        );
        const firstTerminal = await run(`(() => {
          const record = [...editor.terminalPanel.sessions.values()][0];
          return {
            id: record.id,
            workspaceKey: record.workspaceKey,
            terminal: Boolean(record.terminal),
            shell: record.shell,
            cwd: record.cwd,
            displayLabel: record.displayLabel,
          };
        })()`);
        assert.equal(firstTerminal.terminal, true, "the renderer creates an xterm instance");
        assert.ok(firstTerminal.shell, "the active system shell is identified");
        assert.equal(firstTerminal.cwd, canonicalTerminalWorkspaceA, "new PTYs start in the canonical active workspace root");
        assert.doesNotMatch(firstTerminal.displayLabel, /\(\d+\)$/,
          "the first terminal keeps its unsuffixed label");
        traceStep("first xterm and PTY initialized");
        const terminalSurfaces = await run(`(() => {
          const themeManager = editor.themeManager;
          const originalPreference = themeManager.getPreference();
          const record = [...editor.terminalPanel.sessions.values()][0];
          const results = {};
          const measure = () => {
            const panel = editor.terminalPanel.element;
            const view = panel.querySelector(".terminal-view");
            const instance = record.wrapper;
            const xterm = instance.querySelector(".xterm");
            const viewport = xterm.querySelector(".xterm-viewport");
            const screen = xterm.querySelector(".xterm-screen");
            return {
              colors: [panel, view, instance, xterm, viewport, screen]
                .map(element => getComputedStyle(element).backgroundColor),
              themedBackground: record.terminal.options.theme.background,
              cursorBlink: record.terminal.options.cursorBlink,
              themeToken: getComputedStyle(document.documentElement)
                .getPropertyValue("--bg-secondary").trim(),
              rects: [view, instance, xterm, viewport].map(element => {
                const rect = element.getBoundingClientRect();
                return { width: rect.width, height: rect.height };
              }),
            };
          };
          try {
            for (const preference of ["dark", "light", "system"]) {
              themeManager.syncFromSettings(preference);
              results[preference] = measure();
            }
          } finally {
            themeManager.syncFromSettings(originalPreference);
          }
          return results;
        })()`);
        for (const [theme, result] of Object.entries(terminalSurfaces)) {
          assert.ok(result.colors.every(color => color === result.colors[0]),
            `${theme} theme gives the terminal surface, xterm, viewport, and screen one background`);
          assert.equal(result.themedBackground, result.themeToken,
            `${theme} xterm canvas theme uses the NCE surface token`);
          assert.equal(result.cursorBlink, false,
            `${theme} terminal cursor stays fixed`);
          for (const rect of result.rects.slice(1)) {
            assert.ok(Math.abs(rect.width - result.rects[0].width) <= 1,
              `${theme} xterm viewport spans the terminal content width`);
            assert.ok(Math.abs(rect.height - result.rects[0].height) <= 1,
              `${theme} xterm viewport spans the terminal content height`);
          }
        }
        const terminalLayout = await run(`(() => {
          const panel = document.querySelector(".bottom-panel").getBoundingClientRect();
          const editorBounds = document.querySelector(".editor").getBoundingClientRect();
          const bottomBar = document.querySelector(".bottomBar").getBoundingClientRect();
          const leftSidebar = document.querySelector(".sidebar-left").getBoundingClientRect();
          const rightSidebar = document.querySelector(".sidebar-right").getBoundingClientRect();
          return {
            panelLeft: panel.left,
            panelRight: panel.right,
            editorLeft: editorBounds.left,
            editorRight: editorBounds.right,
            editorBottom: editorBounds.bottom,
            panelTop: panel.top,
            panelBottom: panel.bottom,
            bottomBarTop: bottomBar.top,
            leftSidebarBottom: leftSidebar.bottom,
            rightSidebarBottom: rightSidebar.bottom,
          };
        })()`);
        assert.ok(Math.abs(terminalLayout.panelLeft - terminalLayout.editorLeft) <= 1);
        assert.ok(Math.abs(terminalLayout.panelRight - terminalLayout.editorRight) <= 1);
        assert.ok(Math.abs(terminalLayout.editorBottom - terminalLayout.panelTop) <= 1);
        assert.ok(Math.abs(terminalLayout.panelBottom - terminalLayout.bottomBarTop) <= 1);
        assert.ok(Math.abs(terminalLayout.leftSidebarBottom - terminalLayout.bottomBarTop) <= 1);
        assert.ok(Math.abs(terminalLayout.rightSidebarBottom - terminalLayout.bottomBarTop) <= 1);
        const resizerGeometry = await run(`(() => {
          const sidebar = document.querySelector(".sidebar-resizer-left");
          const bottom = document.querySelector(".bottom-panel-resize-handle");
          const panel = document.querySelector(".bottom-panel");
          window.__ncePreviousSidebarResizerDisplay = sidebar.style.display;
          sidebar.style.display = "block";
          const bounds = element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          };
          return {
            sidebar: bounds(sidebar),
            bottom: bounds(bottom),
            panel: bounds(panel),
            sidebarRest: getComputedStyle(sidebar).backgroundColor,
            bottomRest: getComputedStyle(bottom).backgroundColor,
            sidebarTransition: getComputedStyle(sidebar).transitionDuration,
            bottomTransition: getComputedStyle(bottom).transitionDuration,
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
            panelOverflow: getComputedStyle(panel).overflow,
          };
        })()`);
        assert.equal(resizerGeometry.sidebar.width, 4);
        assert.equal(resizerGeometry.bottom.height, 4);
        assert.equal(resizerGeometry.sidebarRest, resizerGeometry.bottomRest);
        const expectedResizerTransition = resizerGeometry.reducedMotion ? "0s" : "0.2s";
        assert.equal(resizerGeometry.sidebarTransition, expectedResizerTransition);
        assert.equal(resizerGeometry.bottomTransition, expectedResizerTransition);
        assert.equal(resizerGeometry.panelOverflow, "hidden");
        assert.ok(Math.abs(resizerGeometry.bottom.top - resizerGeometry.panel.top) <= 1,
          "the horizontal handle starts at the unclipped panel edge");
        assert.ok(resizerGeometry.bottom.top + resizerGeometry.bottom.height <=
          resizerGeometry.panel.top + resizerGeometry.panel.height,
        "the horizontal resizer hit area remains inside the clipped panel");
        const movePointerTo = async (x, y) => {
          win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
        };
        await movePointerTo(
          resizerGeometry.bottom.left + resizerGeometry.bottom.width / 2,
          resizerGeometry.bottom.top + resizerGeometry.bottom.height / 2,
        );
        await waitForCondition(
          async () => (await run('document.querySelector(".bottom-panel-resize-handle").matches(":hover")')) === true,
          { description: "Bottom Panel resizer hover state" },
        );
        const bottomHoverColor = await run(`(async () => {
          const element = document.querySelector(".bottom-panel-resize-handle");
          let previous = "";
          let stableFrames = 0;
          for (let frame = 0; frame < 120 && stableFrames < 3; frame++) {
            await new Promise(requestAnimationFrame);
            const color = getComputedStyle(element).backgroundColor;
            stableFrames = color === previous ? stableFrames + 1 : 0;
            previous = color;
          }
          return previous;
        })()`);
        await movePointerTo(
          resizerGeometry.sidebar.left + resizerGeometry.sidebar.width / 2,
          resizerGeometry.sidebar.top + resizerGeometry.sidebar.height / 2,
        );
        await waitForCondition(
          async () => (await run('document.querySelector(".sidebar-resizer-left").matches(":hover")')) === true,
          { description: "Sidebar resizer hover state" },
        );
        const sidebarHoverColor = await run(`(async () => {
          const element = document.querySelector(".sidebar-resizer-left");
          let previous = "";
          let stableFrames = 0;
          for (let frame = 0; frame < 120 && stableFrames < 3; frame++) {
            await new Promise(requestAnimationFrame);
            const color = getComputedStyle(element).backgroundColor;
            stableFrames = color === previous ? stableFrames + 1 : 0;
            previous = color;
          }
          return previous;
        })()`);
        assert.equal(bottomHoverColor, sidebarHoverColor,
          "the Bottom Panel and sidebar resizers render the same computed hover color");
        traceStep("terminal layout and styling checks passed");
        await run(`document.querySelector(".sidebar-resizer-left").style.display = window.__ncePreviousSidebarResizerDisplay`);
        const getTerminalText = (id) => `(() => {
          const record = editor.terminalPanel.sessions.get(${JSON.stringify(id)}) ||
            window.__terminalWorkspaceARecords?.get(${JSON.stringify(id)});
          const buffer = record?.terminal.buffer.active;
          if (!buffer) return "";
          let text = "";
          for (let index = 0; index < buffer.length; index++) {
            const line = buffer.getLine(index);
            if (index > 0 && !line?.isWrapped) text += "\\n";
            text += line?.translateToString(true) || "";
          }
          return text;
        })()`;
        const getLastNonEmptyTerminalLine = (id) =>
          `(() => ${getTerminalText(id)}.split("\\n").map(line => line.trim()).filter(Boolean).at(-1) || "")()`;
        const getTerminalCursorState = (id) => `(() => {
          const record = editor.terminalPanel.sessions.get(${JSON.stringify(id)}) ||
            window.__terminalWorkspaceARecords?.get(${JSON.stringify(id)});
          const buffer = record?.terminal.buffer.active;
          if (!buffer) return { row: -1, text: "" };
          const row = buffer.baseY + buffer.cursorY;
          return {
            row,
            text: buffer.getLine(row)?.translateToString(true) || "",
          };
        })()`;
        assert.equal(await run(`(() => {
          const primary = getComputedStyle(editor.cD);
          const secondary = getComputedStyle(editor.multiCursorCaretOutput);
          return primary.animationName === "none" &&
            secondary.animationName === "none" &&
            primary.opacity === "1" && secondary.opacity === "1";
        })()`), true, "primary and secondary editor carets stay visible without animation");

        const previousOpenFolderShortcut = await run('SETTINGS_GET("keybindings.open_folder")');
        assert.deepEqual(
          await run('SETTINGS_SET("keybindings.open_folder", "Space")'),
          { success: true },
          "the Space shortcut can be configured for regression coverage",
        );
        if (process.platform === "darwin") {
          assert.equal(
            findMenuItem(nce.window.appMenu.menu, "Open Folder...")?.accelerator == null,
            true,
            "a native menu accelerator never captures unmodified Space",
          );
        }
        const originalShowOpenDialog = dialog.showOpenDialog;
        let openFolderDialogCalls = 0;
        dialog.showOpenDialog = async () => {
          openFolderDialogCalls++;
          return { canceled: true, filePaths: [] };
        };
        const terminalManager = nce.window.terminalManager;
        const terminalSession = terminalManager?.sessions?.get(firstTerminal.id);
        assert.ok(terminalSession, "the main process owns the active PTY session");
        const ptyInputData = [];
        const ptyOutputData = [];
        const originalTerminalWrite = terminalManager.write;
        const originalTerminalEnqueue = terminalSession.enqueue;
        let terminalStage = "terminal focus";
        terminalManager.write = function (event, sessionId, workspaceKey, data) {
          if (sessionId === firstTerminal.id && typeof data === "string")
            ptyInputData.push(data);
          return originalTerminalWrite.call(this, event, sessionId, workspaceKey, data);
        };
        terminalSession.enqueue = function (data) {
          if (typeof data === "string") ptyOutputData.push(data);
          return originalTerminalEnqueue.call(this, data);
        };
        const terminalDiagnostics = async () => {
          const renderer = await run(`(() => {
            const record = editor.terminalPanel.sessions.get(${JSON.stringify(firstTerminal.id)});
            const active = document.activeElement;
            return {
              documentFocused: document.hasFocus(),
              activeElement: active ? {
                tag: active.tagName,
                className: typeof active.className === "string" ? active.className : "",
                insideTerminal: Boolean(active.closest?.(".xterm")),
              } : null,
              terminalFocused: Boolean(
                active?.classList?.contains("xterm-helper-textarea"),
              ),
              xtermInput: window.__nceTerminalInput || [],
              keyboardEvents: window.__nceTerminalKeyEvents || [],
              buffer: ${getTerminalText(firstTerminal.id)},
            };
          })()`).catch(error => ({ rendererError: String(error) }));
          return {
            stage: terminalStage,
            shell: firstTerminal.shell,
            windowFocused: win.isFocused(),
            webContentsFocused: win.webContents.isFocused(),
            renderer,
            ptyInput: ptyInputData,
            ptyOutput: ptyOutputData,
            openFolderDialogCalls,
          };
        };
        const waitForTerminalCondition = async (condition, options) => {
          terminalStage = options.description;
          try {
            await waitForCondition(condition, options);
          } catch (error) {
            const diagnostics = await terminalDiagnostics();
            throw new Error(`${error.message}\nTerminal diagnostics: ${JSON.stringify(diagnostics)}`, {
              cause: error,
            });
          }
        };
        try {
          await run(`editor.terminalPanel.getActiveSession().terminal.focus()`);
          if (process.platform === "darwin") app.focus({ steal: true });
          win.focus();
          await waitForTerminalCondition(
            async () => (await run(`${getTerminalText(firstTerminal.id)}.trim().length > 0`)) === true,
            { timeout: 10000, description: "the selected shell to initialize terminal output" },
          );
          await run(`(() => {
            const terminal = editor.terminalPanel.getActiveSession().terminal;
            window.__nceTerminalInput = [];
            window.__nceTerminalKeyEvents = [];
            window.__nceTerminalInputSubscription = terminal.onData(data =>
              window.__nceTerminalInput.push(data),
            );
            window.__nceTerminalKeyProbe = event => {
              if (!event.target?.closest?.(".xterm")) return;
              window.__nceTerminalKeyEvents.push({
                key: event.key,
                repeat: event.repeat,
                shift: event.shiftKey,
                prevented: event.defaultPrevented,
              });
            };
            document.addEventListener("keydown", window.__nceTerminalKeyProbe, true);
          })()`);
          await waitForTerminalCondition(
            async () => (await run('Boolean(document.activeElement?.closest?.(".xterm"))')) === true,
            { timeout: 5000, description: "xterm to own keyboard focus" },
          );
          const sendPhysicalKey = (keyCode, { char, modifiers = [], repeats = 0 } = {}) => {
            win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
            if (char !== undefined)
              win.webContents.sendInputEvent({ type: "char", keyCode: char, modifiers });
            for (let index = 0; index < repeats; index++) {
              const repeatedModifiers = [...modifiers, "isautorepeat"];
              win.webContents.sendInputEvent({
                type: "keyDown",
                keyCode,
                modifiers: repeatedModifiers,
              });
              if (char !== undefined)
                win.webContents.sendInputEvent({
                  type: "char",
                  keyCode: char,
                  modifiers: repeatedModifiers,
                });
            }
            win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
          };
          const typePhysicalText = async (value) => {
            let expected = "";
            for (const character of value) {
              if (character === " ") {
                sendPhysicalKey("Space", { char: " " });
              } else {
                const shifted = "!@#$%^&*()_+{}|:\"<>?~".includes(character);
                const keyCode = /^[a-z]$/i.test(character)
                  ? character.toUpperCase()
                  : character;
                sendPhysicalKey(keyCode, {
                  char: character,
                  modifiers: shifted ? ["shift"] : [],
                });
              }
              expected += character;
              await waitForTerminalCondition(
                async () => (await run('window.__nceTerminalInput.join("")')) === expected,
                { timeout: 5000, description: `physical ${JSON.stringify(character)} key to reach xterm` },
              );
              await waitForTerminalCondition(
                async () => ptyInputData.join("") === expected,
                { timeout: 5000, description: `physical ${JSON.stringify(character)} key to reach the PTY` },
              );
            }
          };
          const pressTerminalInterrupt = () =>
            sendPhysicalKey("C", { modifiers: ["control"] });
          const waitForTypedInput = async (expected, description) => {
            await waitForTerminalCondition(
              async () => (await run('window.__nceTerminalInput.join("")')) === expected,
              { timeout: 5000, description },
            );
            await waitForTerminalCondition(
              async () => ptyInputData.join("") === expected,
              { timeout: 5000, description: `${description} to reach the PTY` },
            );
          };
          const interruptAndWaitForFreshShellLine = async (expectedInput, description) => {
            const cursorBeforeInterrupt = await run(
              getTerminalCursorState(firstTerminal.id),
            );
            pressTerminalInterrupt();
            await waitForTypedInput(expectedInput, description);
            await waitForTerminalCondition(
              async () => {
                const cursor = await run(getTerminalCursorState(firstTerminal.id));
                return cursor.row > cursorBeforeInterrupt.row &&
                  cursor.text.trim().length > 0;
              },
              {
                timeout: 10000,
                description: description + " to render the next shell input line",
              },
            );
          };

          ptyInputData.length = 0;
          await run("window.__nceTerminalInput.length = 0; window.__nceTerminalKeyEvents.length = 0");
          terminalStage = "Shift+Arrow terminal text selection";
          await typePhysicalText("nce_shift_arrow");
          await waitForTerminalCondition(
            async () => (await run(getLastNonEmptyTerminalLine(firstTerminal.id))).endsWith("nce_shift_arrow"),
            { timeout: 5000, description: "the shell to echo the input before extending its terminal selection" },
          );
          sendPhysicalKey("Left", { modifiers: ["shift"] });
          sendPhysicalKey("Left", { modifiers: ["shift"] });
          await waitForTerminalCondition(
            async () => (await run('editor.terminalPanel.getActiveSession().terminal.getSelection()')) === "ow",
            { timeout: 5000, description: "Shift+ArrowLeft to select the last two terminal input characters" },
          );
          const shiftedArrowInput = "nce_shift_arrow\u001b[D\u001b[D";
          await waitForTerminalCondition(
            async () => (await run('window.__nceTerminalInput.join("")')) === shiftedArrowInput &&
              ptyInputData.join("") === shiftedArrowInput,
            { timeout: 5000, description: "plain left arrows to reach the PTY and move the shell caret" },
          );
          assert.equal(await run('window.__nceTerminalInput.join("")'), shiftedArrowInput,
            "Shift+Arrow sends plain arrow input without the Shift modifier");
          assert.equal(ptyInputData.join(""), shiftedArrowInput,
            "Shift+Arrow moves the shell caret without sending deletion sequences");
          assert.equal(
            await run('window.__nceTerminalKeyEvents.some(event => event.key === "ArrowLeft" && event.shift) && window.__nceTerminalKeyEvents.filter(event => event.key === "ArrowLeft" && event.shift).every(event => event.prevented)'),
            true,
            "the global terminal key handler consumes Shift+Arrow before xterm forwards it",
          );
          await run(`(() => {
            editor.terminalPanel.resetKeyboardSelection?.();
            editor.terminalPanel.getActiveSession().terminal.clearSelection();
            return true;
          })()`);
          ptyInputData.length = 0;
          await run("window.__nceTerminalInput.length = 0");
          await interruptAndWaitForFreshShellLine(
            "\u0003",
            "Ctrl+C to discard the selected test command",
          );
          ptyInputData.length = 0;
          await run("window.__nceTerminalInput.length = 0; window.__nceTerminalKeyEvents.length = 0");

          terminalStage = "Space, Shift+Space, and held Space key events";
          sendPhysicalKey("Space", { char: " " });
          sendPhysicalKey("Space", { char: " ", modifiers: ["shift"] });
          sendPhysicalKey("Space", { char: " ", repeats: 2 });
          await waitForTypedInput("     ", "xterm to emit five physical space key events once");
          assert.equal(
            await run('window.__nceTerminalKeyEvents.some(event => event.key === " " && event.repeat)'),
            true,
            "holding Space produces a repeated keyboard event",
          );
          assert.equal(openFolderDialogCalls, 0,
            "ordinary and held Space never open the folder picker");
          await interruptAndWaitForFreshShellLine(
            "     \u0003",
            "Ctrl+C to clear the terminal input line",
          );

          ptyInputData.length = 0;
          await run("window.__nceTerminalInput.length = 0; window.__nceTerminalKeyEvents.length = 0");
          const command = 'echo "nce_space_input_hello  nce_space_input_world"';
          terminalStage = "physical command text containing consecutive spaces";
          await typePhysicalText(command);
          await waitForTerminalCondition(
            async () => (await run('window.__nceTerminalInput.join("")')) === command,
            { timeout: 5000, description: "xterm to emit the exact physically typed command once" },
          );
          assert.equal(
            await run('window.__nceTerminalInput.join("")'),
            command,
            "xterm forwards both consecutive command spaces once to the PTY input stream",
          );
          await waitForTerminalCondition(
            async () => ptyInputData.join("") === command,
            { timeout: 5000, description: "the exact xterm input to reach the main-process PTY" },
          );
          await waitForTerminalCondition(
            async () => {
              const lastLine = await run(getLastNonEmptyTerminalLine(firstTerminal.id));
              return lastLine.endsWith(command);
            },
            { timeout: 5000, description: "the shell to render the full typed command before Enter" },
          );
          const outputStart = ptyOutputData.length;
          terminalStage = "command Enter key";
          sendPhysicalKey("Enter");
          await waitForTerminalCondition(
            async () => {
              const output = ptyOutputData.slice(outputStart).join("");
              return output.includes("nce_space_input_hello") &&
                output.includes("nce_space_input_world");
            },
            { timeout: 10000, description: "the shell to execute the command and return both output markers" },
          );
          const output = ptyOutputData.slice(outputStart).join("");
          assert.ok(output.includes("nce_space_input_hello"),
            "the PTY output contains the first marker returned by the executed command");
          assert.ok(output.includes("nce_space_input_world"),
            "the PTY output contains the second marker returned by the executed command");
          assert.ok(output.includes("nce_space_input_hello  nce_space_input_world"),
            "the shell preserves consecutive spaces in its output across supported shells");
          await waitForTerminalCondition(
            async () => (await run(`${getTerminalText(firstTerminal.id)}.includes("nce_space_input_hello") && ${getTerminalText(firstTerminal.id)}.includes("nce_space_input_world")`)) === true,
            { timeout: 5000, description: "xterm to render both PTY output markers" },
          );
          assert.equal(ptyInputData.join(""), `${command}\r`,
            "the PTY receives the exact command and Enter exactly once");
          assert.equal(openFolderDialogCalls, 0,
            "Space in terminal input never opens the folder picker");

          const platformModifier = process.platform === "darwin" ? "meta" : "control";
          const pressConfiguredShortcut = (key) =>
            sendPhysicalKey(key, { modifiers: [platformModifier] });
          const terminalRecord = `editor.terminalPanel.sessions.get(${JSON.stringify(firstTerminal.id)})`;
          terminalStage = "configured Select All, Copy, and Cut shortcuts in xterm";
          await run(`${terminalRecord}.terminal.clearSelection(); ${terminalRecord}.terminal.selectAll()`);
          pressConfiguredShortcut("A");
          await waitForTerminalCondition(
            async () => (await run(`Boolean(${terminalRecord}.terminal.getSelection())`)) === true,
            { timeout: 5000, description: "the configured Select All shortcut to select terminal output" },
          );
          clipboard.clear();
          pressConfiguredShortcut("C");
          await waitForTerminalCondition(
            async () => clipboard.readText().includes("nce_space_input_hello"),
            { timeout: 5000, description: "the configured Copy shortcut to copy selected terminal output" },
          );
          assert.ok(clipboard.readText().includes("nce_space_input_world"),
            "Copy places the selected terminal text on the system clipboard");
          const terminalBufferBeforeCut = await run(getTerminalText(firstTerminal.id));
          clipboard.clear();
          pressConfiguredShortcut("X");
          await waitForTerminalCondition(
            async () => clipboard.readText().includes("nce_space_input_hello") &&
              clipboard.readText().includes("nce_space_input_world"),
            { timeout: 5000, description: "the configured Cut shortcut to copy selected terminal output" },
          );
          const terminalBufferAfterCut = await run(getTerminalText(firstTerminal.id));
          const preservedLines = terminalBufferBeforeCut
            .split("\n")
            .map(line => line.trimEnd())
            .filter(Boolean);
          const remainingLines = terminalBufferAfterCut
            .split("\n")
            .map(line => line.trimEnd())
            .filter(Boolean);
          let preservedIndex = 0;
          for (const line of remainingLines) {
            if (line === preservedLines[preservedIndex]) preservedIndex++;
          }
          assert.equal(preservedIndex, preservedLines.length,
            "Cut copies terminal output without deleting scrollback");

          terminalStage = "configured Paste shortcut in xterm";
          clipboard.writeText("nce_clipboard_paste");
          ptyInputData.length = 0;
          await run("window.__nceTerminalInput.length = 0");
          pressConfiguredShortcut("V");
          await waitForTerminalCondition(
            async () => {
              const input = await run('window.__nceTerminalInput.join("")');
              return input.includes("nce_clipboard_paste") &&
                input.split("nce_clipboard_paste").length === 2;
            },
            { timeout: 5000, description: "the configured Paste shortcut to send clipboard text through xterm once" },
          );
          const pastedInput = await run('window.__nceTerminalInput.join("")');
          await waitForTerminalCondition(
            async () => ptyInputData.join("").includes("nce_clipboard_paste") &&
              ptyInputData.join("").split("nce_clipboard_paste").length === 2,
            { timeout: 5000, description: "the exact configured paste data to reach the PTY once" },
          );
          assert.equal(ptyInputData.join(""), pastedInput,
            "the PTY receives the same paste bytes that xterm emitted");
          await interruptAndWaitForFreshShellLine(
            `${pastedInput}\u0003`,
            "Ctrl+C after terminal paste to interrupt the shell line",
          );
          traceStep("configured terminal Select All, Copy, Cut and Paste shortcuts passed");

          ptyInputData.length = 0;
          await run("window.__nceTerminalInput.length = 0; window.__nceTerminalKeyEvents.length = 0");
          terminalStage = "printable characters, Backspace, navigation, and Tab";
          await typePhysicalText("nce_special_!?");
          sendPhysicalKey("Backspace");
          sendPhysicalKey("Left");
          sendPhysicalKey("Right");
          sendPhysicalKey("Up");
          sendPhysicalKey("Down");
          sendPhysicalKey("Home");
          sendPhysicalKey("End");
          sendPhysicalKey("Tab");
          const specialInput = "nce_special_!?\u001b[D\u001b[C\u001b[A\u001b[B\u001b[H\u001b[F\t";
          await waitForTypedInput(specialInput, "xterm to forward ordinary, special, editing, and navigation keys once");
          const specialKeys = await run('window.__nceTerminalKeyEvents.map(event => event.key)');
          for (const key of ["n", "_", "!", "?", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Tab"])
            assert.ok(specialKeys.includes(key), `the real ${key} keydown reaches the terminal`);
          assert.equal(openFolderDialogCalls, 0,
            "ordinary, special, navigation, and Tab input never opens the folder picker");
          pressTerminalInterrupt();
          await waitForTypedInput(`${specialInput}\u0003`, "Ctrl+C to interrupt the shell navigation input");

          await run(`SETTINGS_SET("keybindings.open_folder", "Ctrl+Shift+O")`);
          terminalStage = "explicit Ctrl+Shift+O shortcut from terminal focus";
          sendPhysicalKey("O", { modifiers: ["control", "shift"] });
          await waitForTerminalCondition(
            async () => openFolderDialogCalls === 1,
            { timeout: 5000, description: "the explicit modified Open Folder shortcut to run once" },
          );
        } finally {
          await run(`window.__nceTerminalInputSubscription?.dispose();
            if (window.__nceTerminalKeyProbe)
              document.removeEventListener("keydown", window.__nceTerminalKeyProbe, true);
            delete window.__nceTerminalKeyProbe;
            delete window.__nceTerminalInputSubscription;
            delete window.__nceTerminalKeyEvents;
            delete window.__nceTerminalInput`);
          terminalManager.write = originalTerminalWrite;
          terminalSession.enqueue = originalTerminalEnqueue;
          dialog.showOpenDialog = originalShowOpenDialog;
          await run(`SETTINGS_SET("keybindings.open_folder", ${JSON.stringify(previousOpenFolderShortcut)})`);
        }
        await run(`window.api.writeTerminalSession(${JSON.stringify(firstTerminal.id)}, editor.terminalPanel.sessions.get(${JSON.stringify(firstTerminal.id)}).workspaceKey, ${JSON.stringify("echo NCE_PTY_FIRST\r")})`);
        await waitForCondition(
          async () => (await run(`${getTerminalText(firstTerminal.id)}.includes("NCE_PTY_FIRST")`)) === true,
          { timeout: 10000, description: "first real PTY shell output" },
        );
        traceStep("first PTY output received");

        assert.equal(
          await run("editor.terminalPanel.createTerminal()"),
          true,
          "the Terminal panel can create an additional session",
        );
        const secondTerminal = await run(`(() => {
          const records = [...editor.terminalPanel.sessions.values()];
          return records.length === 2 ? {
            id: records[1].id,
            labels: records.map(record => record.displayLabel),
          } : null;
        })()`);
        assert.ok(secondTerminal?.id, "two independent terminal tabs are present");
        assert.deepEqual(secondTerminal.labels, [
          firstTerminal.displayLabel,
          `${firstTerminal.displayLabel} (1)`,
        ], "adding a duplicate leaves the primary unchanged and suffixes only the new tab");
        await run(`window.api.writeTerminalSession(${JSON.stringify(secondTerminal.id)}, editor.terminalPanel.sessions.get(${JSON.stringify(secondTerminal.id)}).workspaceKey, ${JSON.stringify("echo NCE_PTY_SECOND\r")})`);
        await waitForCondition(
          async () => (await run(`${getTerminalText(secondTerminal.id)}.includes("NCE_PTY_SECOND")`)) === true,
          { timeout: 10000, description: "second real PTY shell output" },
        );
        traceStep("both PTY sessions produced independent output");
        const firstTerminalOutputAfterSecond = await run(
          getTerminalText(firstTerminal.id),
        );
        assert.equal(
          firstTerminalOutputAfterSecond.includes("NCE_PTY_SECOND"),
          false,
          `terminal output stays with its session (first=${firstTerminal.id}, second=${secondTerminal.id}; first buffer=${JSON.stringify(firstTerminalOutputAfterSecond)})`,
        );

        await run(`window.__terminalWorkspaceA = new Map(
          [...editor.terminalPanel.sessions].map(([id, record]) => [id, record.terminal]),
        ); window.__terminalWorkspaceARecords = new Map(editor.terminalPanel.sessions); true`);
        const cancelledSwitch = await run(`(async () => {
          const tabs = editor.tabManager;
          const prepare = tabs.prepareForQuit;
          tabs.prepareForQuit = async () => false;
          try {
            return await editor.fileExplorer.requestWorkspaceSwitch(${JSON.stringify(terminalWorkspaceB)});
          } finally {
            tabs.prepareForQuit = prepare;
          }
        })()`);
        assert.equal(
          cancelledSwitch,
          false,
          "canceling workspace preparation leaves workspace A active",
        );
        assert.equal(await run(`editor.fileExplorer.rootPath === ${JSON.stringify(canonicalTerminalWorkspaceA)} &&
          editor.terminalPanel.sessions.size === 2 &&
          editor.terminalPanel.sessions.has(${JSON.stringify(firstTerminal.id)})`), true,
        "a canceled switch preserves A's terminal tabs and live sessions");
        dialog.showMessageBox = async () => ({ response: 1 });
        assert.equal(
          await run(`editor.fileExplorer.requestWorkspaceSwitch(${JSON.stringify(terminalWorkspaceB)})`),
          true,
          "workspace A can switch to workspace B while both A PTYs remain live",
        );
        assert.equal(await run(`editor.fileExplorer.rootPath === ${JSON.stringify(canonicalTerminalWorkspaceB)}`), true,
          "workspace roots use the filesystem's canonical path after switching");
        assert.equal(await run("editor.terminalPanel.sessions.size === 0"), true, "workspace B never displays workspace A sessions");
        await run('editor.bottomPanelManager.openPanel("terminal")');
        await waitForCondition(
          async () => (await run("Boolean(editor.terminalPanel.sessions.size === 1 && [...editor.terminalPanel.sessions.values()][0].id)")) === true,
          { timeout: 15000, description: "workspace B's independent first terminal" },
        );
        let workspaceBTerminal = await run(`(() => {
          const [id, record] = [...editor.terminalPanel.sessions.entries()][0];
          return { id, workspaceKey: record.workspaceKey };
        })()`);
        assert.notEqual(workspaceBTerminal.id, firstTerminal.id);
        assert.notEqual(workspaceBTerminal.id, secondTerminal.id);
        traceStep("workspace B PTY started");
        await run(`window.__terminalWorkspaceB = editor.terminalPanel.sessions.get(${JSON.stringify(workspaceBTerminal.id)}).terminal; true`);

        const respawnIds = new Set([workspaceBTerminal.id]);
        const fdCount = () => process.platform === "darwin"
          ? fs.readdirSync("/dev/fd").length
          : null;
        for (let index = 0; index < 20; index++) {
          const previousId = workspaceBTerminal.id;
          const previousFdCount = fdCount();
          const previousPid = process.platform === "darwin"
            ? nce.window.terminalManager.sessions.get(previousId)?.process?.pid
            : null;
          if (process.platform === "darwin")
            assert.ok(previousPid, `cycle ${index} has a live native PTY process`);
          assert.equal(
            await run(`editor.terminalPanel.closeSession(${JSON.stringify(previousId)})`),
            true,
            `cycle ${index} closes the last terminal tab`,
          );
          let closeState;
          try {
            await waitForCondition(
              async () => {
                closeState = {
                  renderer: await run(`({
                    sessions: editor.terminalPanel.sessions.size,
                    panelVisible: editor.bottomPanelManager.visible,
                    initialOpenAttempted: editor.terminalPanel.currentState.initialOpenAttempted,
                  })`),
                  mainSessions: nce.window.terminalManager.sessions.size,
                  pendingCreates: nce.window.terminalManager.pendingCreates.size,
                };
                return closeState.renderer.sessions === 0 &&
                  closeState.renderer.panelVisible === false &&
                  closeState.renderer.initialOpenAttempted === false &&
                  !nce.window.terminalManager.sessions.has(previousId) &&
                  closeState.mainSessions === 2 && closeState.pendingCreates === 0;
              },
              { timeout: 5000, description: `cycle ${index} removes the last terminal session` },
            );
          } catch (error) {
            throw new Error(`${error.message}; last state=${JSON.stringify(closeState)}`, { cause: error });
          }
          if (process.platform === "darwin") {
            await waitForCondition(() => {
              try { process.kill(previousPid, 0); return false; }
              catch (error) { return error?.code === "ESRCH"; }
            }, { timeout: 5000, description: `cycle ${index} reaps PTY process ${previousPid}` });
          }

          assert.equal(await run('editor.bottomPanelManager.openPanel("terminal")'), true,
            `cycle ${index} reopens Terminal`);
          await waitForCondition(
            async () => (await run(`editor.terminalPanel.sessions.size === 1 &&
              [...editor.terminalPanel.sessions.values()].every(record => Boolean(record.id))`)) === true &&
              nce.window.terminalManager.sessions.size === 3 &&
              nce.window.terminalManager.pendingCreates.size === 0,
            { timeout: 10000, description: `cycle ${index} creates one workspace B PTY` },
          );
          workspaceBTerminal = await run(`(() => {
            const [id, record] = [...editor.terminalPanel.sessions.entries()][0];
            return { id, workspaceKey: record.workspaceKey };
          })()`);
          assert.equal(nce.window.terminalManager.sessions.has(workspaceBTerminal.id), true,
            `cycle ${index} registers the new PTY in the main process`);
          assert.equal(respawnIds.has(workspaceBTerminal.id), false,
            `cycle ${index} receives a fresh PTY ID`);
          respawnIds.add(workspaceBTerminal.id);
          const marker = `NCE_PTY_RESPAWN_${index}`;
          await run(`window.api.writeTerminalSession(
            ${JSON.stringify(workspaceBTerminal.id)},
            ${JSON.stringify(workspaceBTerminal.workspaceKey)},
            ${JSON.stringify(`echo ${marker}\r`)}
          )`);
          await waitForCondition(
            async () => (await run(`${getTerminalText(workspaceBTerminal.id)}.includes(${JSON.stringify(marker)})`)) === true,
            { timeout: 10000, description: `cycle ${index} receives real shell stdout` },
          );
          await run(`window.__terminalWorkspaceB = editor.terminalPanel.sessions.get(${JSON.stringify(workspaceBTerminal.id)}).terminal; true`);
          if (previousFdCount !== null) {
            await waitForCondition(() => fdCount() <= previousFdCount + 2, {
              timeout: 5000,
              description: `cycle ${index} releases native PTY descriptors`,
            });
          }
        }
        assert.equal(respawnIds.size, 21, "all 20 respawns use distinct PTY IDs");
        traceStep("20 PTY close and respawn cycles passed");

        assert.equal(
          await run(`editor.fileExplorer.requestWorkspaceSwitch(${JSON.stringify(terminalWorkspaceA)})`),
          true,
          "returning to workspace A restores its workspace state",
        );
        assert.equal(await run(`editor.terminalPanel.sessions.size === 2 &&
          editor.terminalPanel.sessions.has(${JSON.stringify(firstTerminal.id)}) &&
          editor.terminalPanel.sessions.has(${JSON.stringify(secondTerminal.id)})`), true);
        assert.equal(await run(`editor.terminalPanel.sessions.get(${JSON.stringify(firstTerminal.id)}).terminal ===
          window.__terminalWorkspaceA.get(${JSON.stringify(firstTerminal.id)})`), true, "workspace A reuses its existing xterm instance");
        assert.equal(await run(`editor.terminalPanel.activeSessionId === ${JSON.stringify(secondTerminal.id)}`), true, "workspace A restores its selected terminal");

        assert.equal(
          await run(`editor.fileExplorer.requestWorkspaceSwitch(${JSON.stringify(terminalWorkspaceB)})`),
          true,
          "workspace B can be restored after switching back to A",
        );
        assert.equal(await run(`editor.terminalPanel.sessions.size === 1 &&
          editor.terminalPanel.sessions.has(${JSON.stringify(workspaceBTerminal.id)})`), true);
        assert.equal(await run(`editor.terminalPanel.sessions.get(${JSON.stringify(workspaceBTerminal.id)}).terminal ===
          window.__terminalWorkspaceB`), true, "workspace B reuses its original xterm instance");
        await run(`window.api.writeTerminalSession(${JSON.stringify(firstTerminal.id)}, ${JSON.stringify(firstTerminal.workspaceKey || "")}, ${JSON.stringify("echo NCE_HIDDEN_WORKSPACE_OUTPUT\r")})`);
        await waitForCondition(
          async () => (await run(`${getTerminalText(firstTerminal.id)}.includes("NCE_HIDDEN_WORKSPACE_OUTPUT")`)) === true,
          { timeout: 10000, description: "workspace A PTY output while workspace B is active" },
        );
        assert.equal(await run("editor.terminalPanel.sessions.size === 1"), true, "background A output cannot add a tab to B");
        assert.equal(
          await run(`editor.fileExplorer.requestWorkspaceSwitch(${JSON.stringify(terminalWorkspaceA)})`),
          true,
        );

        assert.equal(await run('editor.bottomPanelManager.openPanel("terminal")'), true,
          "workspace A's restored Terminal view is activated before resize validation");
        const initialPanelHeight = await run("editor.bottomPanelManager.height");
        assert.equal(await run(`editor.bottomPanelManager.resize(${initialPanelHeight + 24})`), true,
          "the Bottom Panel accepts a height change within its bounds");
        await waitForCondition(
          async () => (await run(`(() => {
            const panel = document.querySelector(".bottom-panel");
            const manager = editor.bottomPanelManager;
            return manager.visible && !panel.hidden &&
              Math.round(panel.getBoundingClientRect().height) === manager.height;
          })()`)) === true,
          { timeout: 3000, description: "Bottom Panel resize layout" },
        );
        await run("editor.bottomPanelManager.closePanel()");
        assert.equal(nce.window.terminalManager.sessions.size, 3,
          "hiding the panel preserves A's PTYs and B's background PTY");
        assert.equal(await run("editor.terminalPanel.sessions.size === 2 && editor.bottomPanelManager.visible === false"), true);
        assert.equal(await run("window.api.getSettings().then(settings => settings.terminal.shell === '')"), true, "the renderer remains responsive while the panel is hidden");
        await run('editor.bottomPanelManager.openPanel("terminal")');
        assert.equal(await run("editor.terminalPanel.sessions.size === 2"), true, "reopening does not recreate terminal sessions");
        await run(`window.__smokeTerminalInstance = editor.terminalPanel.sessions.get(${JSON.stringify(firstTerminal.id)}).terminal; true`);
        assert.equal(await run(`window.__smokeTerminalInstance === editor.terminalPanel.sessions.get(${JSON.stringify(firstTerminal.id)}).terminal`), true, "the same xterm instance remains mounted");

        const longCommand = 'node -e "console.log(\'NCE_LONG_PROCESS_READY\');setTimeout(()=>{},30000)"\r';
        await run(`window.api.writeTerminalSession(${JSON.stringify(secondTerminal.id)}, editor.terminalPanel.sessions.get(${JSON.stringify(secondTerminal.id)}).workspaceKey, ${JSON.stringify(longCommand)})`);
        await waitForCondition(
          async () => (await run(`${getTerminalText(secondTerminal.id)}.includes("NCE_LONG_PROCESS_READY")`)) === true,
          { timeout: 10000, description: "long-running terminal process startup" },
        );
        await run("editor.bottomPanelManager.closePanel()");
        assert.equal(nce.window.terminalManager.sessions.get(secondTerminal.id).isExited, false, "a long-running PTY survives hiding the panel");
        assert.equal(await run("editor.tabManager.tabs.length >= 0"), true, "the editor stays responsive beside a long-running process");
        await run('editor.bottomPanelManager.openPanel("terminal")');
        assert.equal(await run(`editor.terminalPanel.closeSession(${JSON.stringify(firstTerminal.id)})`), true);
        assert.equal(nce.window.terminalManager.sessions.size, 2,
          "closing one terminal ends only that A session while B stays alive");
        assert.equal(await run("editor.terminalPanel.createTerminal()"), true, "a closed tab can be replaced without losing the running process");
        assert.equal(await run(`(() => {
          const record = editor.terminalPanel.getActiveSession();
          const button = [...document.querySelectorAll(".terminal-tab-select")]
            .find(candidate => candidate.getAttribute("aria-selected") === "true");
          if (!record || !button) return false;
          button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
          const input = document.querySelector(".terminal-tab-rename");
          if (!input) return false;
          input.value = "Workspace A Dev";
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          return record.customLabel === "Workspace A Dev";
        })()`), true, "terminal tab names can be customized and are persisted by workspace");
        fs.writeFileSync(
          path.join(directory, "terminal-previous-ids.json"),
          JSON.stringify(await run("[...editor.terminalPanel.sessions.keys()]")),
        );
        assert.equal(await run(`editor.bottomPanelManager.workspaceKey ===
          editor.terminalPanel.currentWorkspaceKey &&
          editor.fileExplorer.rootPath === ${JSON.stringify(canonicalTerminalWorkspaceA)} &&
          editor.bottomPanelManager.getPanelState().visible === true`), true,
        "workspace A is active and its Bottom Panel is visible before persisting");
        assert.equal(await run("editor.fileExplorer.closeProject()"), true, "the terminal smoke test returns to No Workspace without reassigning its live PTY");
        traceStep("terminal close, switch, and persistence checks passed");
        dialog.showMessageBox = async () => ({ response: 1 });
        traceStep("write phase complete; requesting clean quit");
        // The remaining long-running PTY is intentionally left for the window-close
        // lifecycle assertion below; closing the renderer must reap it.
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
        assert.equal(await run('typeof window.NCE_TERMINAL_RUNTIME === "undefined"'), true,
          "renderer startup does not load terminal UI eagerly");
        assert.equal(nce.window.terminalManager.sessions.size, 0,
          "cold startup does not create restored PTYs before opening their workspace");
        dialog.showMessageBox = async () => ({ response: 1 });
        const terminalWorkspaceA = path.join(directory, "terminal-workspace-a");
        const canonicalTerminalWorkspaceA = await fs.promises.realpath(terminalWorkspaceA);
        const previousTerminalIds = JSON.parse(fs.readFileSync(
          path.join(directory, "terminal-previous-ids.json"), "utf8",
        ));
        assert.equal(await run(`editor.fileExplorer.requestWorkspaceSwitch(${JSON.stringify(terminalWorkspaceA)})`), true,
          "workspace switching restores terminal metadata from disk");
        await waitForCondition(
          async () => (await run(`editor.terminalPanel?.sessions?.size === 2 &&
            [...editor.terminalPanel.sessions.values()].every(record => Boolean(record.id))`)) === true,
          { timeout: 15000, description: "new PTYs lazily restore the persisted workspace tabs" },
        );
        const restoredTerminals = await run(`(() => {
          const records = [...editor.terminalPanel.sessions.values()];
          return records.map(record => ({
            id: record.id,
            customLabel: record.customLabel,
            cwd: record.cwd,
            text: Array.from({ length: record.terminal.buffer.active.length }, (_, index) =>
              record.terminal.buffer.active.getLine(index)?.translateToString(true) || "",
            ).join("\\n"),
          }));
        })()`);
        assert.equal(restoredTerminals.length, 2);
        assert.equal(restoredTerminals.some(record => previousTerminalIds.includes(record.id)), false,
          "restart creates fresh PTY identifiers");
        assert.equal(restoredTerminals.some(record => record.customLabel === "Workspace A Dev"), true,
          "custom terminal names survive restart");
        assert.equal(restoredTerminals.every(record => record.cwd === canonicalTerminalWorkspaceA), true);
        assert.equal(restoredTerminals.some(record =>
          /NCE_PTY_FIRST|NCE_PTY_SECOND|NCE_LONG_PROCESS_READY|NCE_HIDDEN_WORKSPACE_OUTPUT/.test(record.text),
        ), false, "restart does not replay old commands or terminal output");
        assert.equal(await run("editor.fileExplorer.closeProject()"), true,
          "the terminal restore phase returns to No Workspace for the remaining smoke phases");
        traceStep("terminal restart and restore checks passed");
      }
      fs.writeFileSync(path.join(directory, `${phase}.ok`), "ok");
      if (phase === "write") {
        const terminalManager = nce.window.terminalManager;
        const prepareForQuit = nce.window.prepareForApplicationQuit.bind(nce.window);
        nce.window.prepareForApplicationQuit = async () => {
          const result = await prepareForQuit();
          traceStep(`application quit preparation resolved: ${result} (${nce.window.quitState})`);
          return result;
        };
        const commitPreparedClose = nce.window.commitPreparedClose.bind(nce.window);
        nce.window.commitPreparedClose = async () => {
          const result = await commitPreparedClose();
          traceStep(`application window close commit resolved: ${result} (${nce.window.quitState})`);
          return result;
        };
        win.once("closed", () => {
          traceStep("native BrowserWindow closed");
          if (terminalManager.sessions.size !== 0) {
            console.error("Terminal PTYs were left alive after the BrowserWindow closed");
            app.exit(1);
          }
        });
      }
      if (phase === "crash") {
        const crashedWindow = nce.window;
        win.webContents.once("render-process-gone", () => {
          void (async () => {
            await crashedWindow.waitForDisposal();
            await nce.requestQuitAll();
          })();
        });
        win.webContents.forcefullyCrashRenderer();
      } else {
        void nce.requestQuitAll().then(
          (result) => {
            traceStep(`requestQuitAll resolved: ${result} (${activeWindow.quitState})`);
            if (!result) app.exit(1);
          },
          (error) => console.error("requestQuitAll failed", error),
        );
      }
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  }, 20);
});
app.on("will-quit", () => clearTimeout(timer));
