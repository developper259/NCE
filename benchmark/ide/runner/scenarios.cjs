const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  resolveWorkspacePath,
  waitForFileFullyLoaded: waitForFileFullyLoadedInRenderer,
  logicalDocumentLength,
  validateLogicalSelectAll,
  performLogicalSelectAll,
  frameIntervalsFromTimestamps,
  summarizeFrameIntervals,
  calculateMainCpuMetrics,
  classifyWorkspaceFailure,
  horizontalScrollFixture,
  workspaceRootEntryCount,
  cleanupWorkspaceState,
} = require("./measurement-helpers.cjs");

const ROOT = path.resolve(__dirname, "../../..");

function js(value) { return JSON.stringify(value); }
function markName(name, sampleIndex, phase) {
  const safe = name.replace(/[^a-zA-Z0-9:._-]/g, "_");
  return `nce:benchmark:${safe}:${sampleIndex}:${phase}`;
}
function hrElapsed(start) { return Number(process.hrtime.bigint() - start) / 1e6; }
function rafTwo() { return "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"; }

function collectMainCpuMetrics(before, after, scenarioName) {
  const metrics = calculateMainCpuMetrics(before, after, os.cpus().length);
  if (!metrics.mainCpuMetricsValid) {
    console.warn(`[NCE benchmark] Invalid main-process CPU sample in ${scenarioName}: ${metrics.mainCpuMetricDiagnostic}`);
  }
  return metrics;
}

function loadFixtureManifest(fixtureRoot) {
  const manifestPath = path.join(fixtureRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("Fixture manifest is missing; regenerate the fixtures for this benchmark mode.");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function getFilePath(fixtures, name, fixtureRoot) {
  const file = fixtures.files[name];
  if (!file) throw new Error(`Fixture '${name}' is not present in the generated profile`);
  return path.join(fixtureRoot, file.path);
}

function getWorkspacePath(fixtures, name, fixtureRoot) {
  return resolveWorkspacePath(fixtures, name, fixtureRoot);
}

async function prepareRenderer(cdp) {
  await cdp.evaluate(`(async () => {
    if (!window.editor || !window.api?.getBenchmarkDiagnostics) throw new Error("NCE benchmark bridge is unavailable");
    await window.api.setAutoSaveState(false);
    window.__nceBenchmarkState = { longTasks: [], observer: null };
    try {
      window.__nceBenchmarkState.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__nceBenchmarkState.longTasks.push(entry.duration);
      });
      window.__nceBenchmarkState.observer.observe({ type: "longtask", buffered: true });
    } catch {}
    return true;
  })()`, 10000);
  await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (window.__nceBenchmarkState) window.__nceBenchmarkState.longTasks.length = 0;
    resolve(true);
  })))`, 10000);
}

async function warmInteractiveApp(run, fixtureRoot) {
  const startedAt = process.hrtime.bigint();
  const tinyPath = path.join(fixtureRoot, "files", "tiny.txt");
  await run.cdp.evaluate(`(async () => {
    await editor.tabManager.openFileWithPath(${js(tinyPath)});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await editor.tabManager.closeFiles({ skipPrepare: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__nceBenchmarkState.longTasks.length = 0;
    return true;
  })()`, run.timeoutMs);
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

async function waitRendererStable(run) {
  await run.cdp.evaluate(rafTwo(), run.scenarioTimeoutMs || run.timeoutMs);
}

async function cleanTabs(run) {
  await run.cdp.evaluate(`(async () => {
    editor.searchController?.close?.();
    if (editor.tabManager?.tabs?.length) await editor.tabManager.closeFiles({ skipPrepare: true });
    return true;
  })()`, run.scenarioTimeoutMs || run.timeoutMs);
  await waitRendererStable(run);
}

async function cleanupWorkspace(run) {
  await run.cdp.evaluate(`(async () => {
    const cleanupWorkspaceState = ${cleanupWorkspaceState.toString()};
    return cleanupWorkspaceState(editor.fileExplorer, window.api);
  })()`, run.scenarioTimeoutMs || run.timeoutMs);
  await waitRendererStable(run);
}

async function openFixture(run, fixturePath, { expected = null, waitForFullModel = true } = {}) {
  const hostOpenStart = process.hrtime.bigint();
  const initial = await run.cdp.evaluate(`(async () => {
    const filePath = ${js(fixturePath)};
    const requestStartedAt = performance.now();
    await editor.tabManager.openFileWithPath(filePath);
    const requestResolvedAt = performance.now();
    const active = editor.tabManager.activeFile;
    if (!active) throw new Error("NCE did not create an active file for the fixture");
    await ${rafTwo()};
    const initialViewportStableAt = performance.now();
    return {
      path: active.path,
      id: active.id,
      isLoaded: active.isLoaded === true,
      lineCount: active.totalLines,
      maxLineLength: active.maxLineLength,
      tabCount: editor.tabManager.tabs.length,
      fileOpenRequestMs: requestResolvedAt - requestStartedAt,
      initialViewportStableMs: initialViewportStableAt - requestStartedAt,
      initialViewportRendererMs: initialViewportStableAt - requestStartedAt
    };
  })()`, run.scenarioTimeoutMs || run.timeoutMs);
  const initialViewportDurationMs = hrElapsed(hostOpenStart);
  if (!initial || initial.path !== fixturePath || !initial.isLoaded) {
    throw new Error(`NCE did not open the expected fixture path '${fixturePath}'`);
  }

  let fullLoad = null;
  if (waitForFullModel) {
    const loadStartedAt = process.hrtime.bigint();
    fullLoad = await run.cdp.evaluate(`(async () => {
      const waitForFileFullyLoaded = ${waitForFileFullyLoadedInRenderer.toString()};
      const file = editor.tabManager.getFileByID(${js(initial.id)});
      const startedAt = performance.now();
      const state = await waitForFileFullyLoaded({
        file,
        getActiveFile: () => editor.tabManager.activeFile,
        expectedPath: ${js(fixturePath)},
        expectedLines: ${js(expected?.lines ?? null)},
        expectedBytes: ${js(expected?.bytes ?? null)},
        timeoutMs: ${js(run.scenarioTimeoutMs || run.timeoutMs)}
      });
      const modelReadyAt = performance.now();
      await ${rafTwo()};
      const stableAt = performance.now();
      return {
        ...state,
        fileModelReadyMs: modelReadyAt - startedAt,
        fileStableRenderMs: stableAt - modelReadyAt,
        fileFullyReadyRendererMs: stableAt - startedAt,
        lineCount: file.totalLines,
        maxLineLength: file.maxLineLength,
        hasFinalNewline: file.hasFinalNewline === true,
        logicalTextLength: ${logicalDocumentLength.toString()}(file.lines.map((line) => line.getText()), file.hasFinalNewline === true),
        tabCount: editor.tabManager.tabs.length
      };
    })()`, run.scenarioTimeoutMs || run.timeoutMs);
    fullLoad.fileModelLoadWaitDurationMs = hrElapsed(loadStartedAt);
    fullLoad.fileFullyReadyDurationMs = hrElapsed(hostOpenStart);
  }
  return {
    ...initial,
    ...(fullLoad || {}),
    fileOpenRequestMs: initial.fileOpenRequestMs,
    initialViewportStableMs: initial.initialViewportStableMs,
    initialViewportRendererMs: initial.initialViewportRendererMs,
    initialViewportDurationMs,
  };
}

async function diagnostics(run) {
  return run.diagnostics();
}

function fileReadMetrics(diagnostic, afterCount = 0) {
  const events = (diagnostic?.events || []).slice(afterCount);
  const initializes = events.filter((event) => event.name === "file-initialize-complete");
  const chunks = events.filter((event) => event.name === "file-chunk-complete");
  const legacyReads = events.filter((event) => event.name === "file-read-complete");
  const diskReadMs = initializes.reduce((sum, event) => sum + (Number(event.durationMs) || 0), 0);
  const chunkMs = chunks.reduce((sum, event) => sum + (Number(event.durationMs) || 0), 0);
  return {
    fileSystemReadMs: diskReadMs || (legacyReads.reduce((sum, event) => sum + (Number(event.durationMs) || 0), 0) || null),
    fileInitializeMs: initializes.length ? diskReadMs : null,
    fileReadBytes: initializes.reduce((sum, event) => sum + (Number(event.bytes) || 0), 0) || legacyReads.reduce((sum, event) => sum + (Number(event.bytes) || 0), 0) || null,
    fileChunks: chunks.length,
    fileChunkLines: chunks.reduce((sum, event) => sum + (Number(event.lines) || 0), 0),
  };
}

function memoryMetrics(heap, performanceMetrics, diagnostic) {
  const processes = diagnostic?.electronProcesses || [];
  const privateBytes = processes.reduce((total, process) => total + (Number(process.memory?.privateBytes) || 0) * 1024, 0);
  const mainRssBytes = diagnostic?.mainProcess?.memory?.rss;
  const jsHeapBytes = heap?.usedSize;
  const perfByName = Object.fromEntries((performanceMetrics?.metrics || []).map((metric) => [metric.name, metric.value]));
  return {
    rendererJsHeapMB: Number.isFinite(jsHeapBytes) ? jsHeapBytes / 1024 / 1024 : null,
    rendererDomNodes: Number.isFinite(perfByName.Nodes) ? perfByName.Nodes : null,
    mainProcessRssMB: Number.isFinite(mainRssBytes) ? mainRssBytes / 1024 / 1024 : null,
    electronPrivateMemoryMB: privateBytes > 0 ? privateBytes / 1024 / 1024 : null,
    metricProcessCount: processes.length,
  };
}

async function collectMemory(run, { forceGc = false } = {}) {
  if (forceGc) await run.cdp.send("HeapProfiler.collectGarbage", {}, 10000).catch(() => {});
  const [heap, perf, main] = await Promise.all([
    run.cdp.send("Runtime.getHeapUsage"),
    run.cdp.send("Performance.getMetrics"),
    diagnostics(run),
  ]);
  return memoryMetrics(heap, perf, main);
}

async function stableMeasured(run, name, index, action) {
  const startName = markName(name, index, "start");
  const paintName = markName(name, index, "paint");
  const measureName = markName(name, index, "renderer");
  const mainBefore = await diagnostics(run);
  const mainEventCount = mainBefore?.events?.length || 0;
  const performanceBefore = await run.cdp.send("Performance.getMetrics");
  const mainCpuBefore = mainBefore?.mainProcess?.cpu;
  const start = process.hrtime.bigint();
  const result = await run.cdp.evaluate(`(async () => {
    performance.mark(${js(startName)});
    const actionStartedAt = performance.now();
    const value = await (async () => { ${action} })();
    const actionDurationMs = performance.now() - actionStartedAt;
    const stableWaitStartedAt = performance.now();
    await ${rafTwo()};
    const stableFrameWaitMs = performance.now() - stableWaitStartedAt;
    performance.mark(${js(paintName)});
    performance.measure(${js(measureName)}, ${js(startName)}, ${js(paintName)});
    const inputToStableFrameMs = performance.getEntriesByName(${js(measureName)}).at(-1)?.duration ?? null;
    performance.clearMarks(${js(startName)});
    performance.clearMarks(${js(paintName)});
    performance.clearMeasures(${js(measureName)});
    return { value, actionDurationMs, stableFrameWaitMs, inputToStableFrameMs };
  })()`, run.scenarioTimeoutMs || run.timeoutMs);
  const durationMs = hrElapsed(start);
  const mainAfter = await diagnostics(run);
  const readMetrics = fileReadMetrics(mainAfter, mainEventCount);
  const mainCpuAfter = mainAfter?.mainProcess?.cpu;
  const tasks = await run.cdp.evaluate(`(() => {
    const values = window.__nceBenchmarkState?.longTasks || [];
    const result = { count: values.length, totalMs: values.reduce((sum, item) => sum + item, 0), maxMs: values.length ? Math.max(...values) : 0 };
    values.length = 0;
    return result;
  })()`);
  const rendererPerf = await run.cdp.send("Performance.getMetrics");
  const beforePerfByName = Object.fromEntries((performanceBefore.metrics || []).map((metric) => [metric.name, metric.value]));
  const afterPerfByName = Object.fromEntries((rendererPerf.metrics || []).map((metric) => [metric.name, metric.value]));
  const mainCpuMetrics = collectMainCpuMetrics(mainCpuBefore, mainCpuAfter, name);
  return {
    metrics: {
      durationMs,
      actionDurationMs: result?.actionDurationMs,
      stableFrameWaitMs: result?.stableFrameWaitMs,
      inputToStableFrameMs: result?.inputToStableFrameMs,
      // Compatibility metric: renderer wall duration includes the two RAFs.
      rendererDurationMs: result?.inputToStableFrameMs,
      ...readMetrics,
      ...mainCpuMetrics,
      longTaskCount: tasks?.count || 0,
      longTaskTotalMs: tasks?.totalMs || 0,
      longTaskMaxMs: tasks?.maxMs || 0,
      scriptDurationMs: Number.isFinite(afterPerfByName.ScriptDuration) && Number.isFinite(beforePerfByName.ScriptDuration)
        ? (afterPerfByName.ScriptDuration - beforePerfByName.ScriptDuration) * 1000 : null,
    },
    value: result?.value,
  };
}

async function sendKey(run, key, { code, modifiers = 0, text = "", windowsVirtualKeyCode } = {}) {
  await run.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code,
    ...(modifiers ? { modifiers } : {}),
    ...(text ? { text, unmodifiedText: text } : {}),
    ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode } : {}),
  });
  await run.cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key, code,
    ...(modifiers ? { modifiers } : {}),
    ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode } : {}),
  });
}

async function focusEditor(run) {
  const point = await run.cdp.evaluate(`(() => {
    const element = document.querySelector(".editor-output");
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 200), y: rect.top + Math.min(rect.height / 2, 100) };
  })()`);
  if (!point) throw new Error("Could not find the NCE editor output for input simulation");
  await run.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await run.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return point;
}

async function dispatchShortcut(run, key) {
  const modifier = process.platform === "darwin"
    ? { key: "Meta", code: "MetaLeft", modifiers: 4 }
    : { key: "Control", code: "ControlLeft", modifiers: 2 };
  await run.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: modifier.key, code: modifier.code, modifiers: modifier.modifiers });
  await run.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: key.toLowerCase(), code: `Key${key.toUpperCase()}`,
    modifiers: modifier.modifiers, text: key.toLowerCase(), unmodifiedText: key.toLowerCase(),
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  });
  await run.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.toLowerCase(), code: `Key${key.toUpperCase()}`, modifiers: modifier.modifiers, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  await run.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: modifier.key, code: modifier.code });
}

async function startFrameWindow(run) {
  return run.cdp.evaluate(`(() => {
    const state = window.__nceBenchmarkState;
    if (!state) throw new Error("NCE benchmark instrumentation is unavailable");
    state.longTasks.length = 0;
    const windowState = { active: true, timestamps: [] };
    state.frameWindow = windowState;
    const tick = (now) => {
      if (!windowState.active) return;
      windowState.timestamps.push(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  })()`);
}

async function stopFrameWindow(run) {
  return run.cdp.evaluate(`(async () => {
    const state = window.__nceBenchmarkState;
    const frameWindow = state?.frameWindow;
    if (!frameWindow) return { frameTimestamps: [], longTasks: [] };
    frameWindow.active = false;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = {
      frameTimestamps: frameWindow.timestamps.slice(),
      longTasks: state.longTasks.slice(),
    };
    state.longTasks.length = 0;
    state.frameWindow = null;
    return result;
  })()`, 10000);
}

function summarizeLongTasks(values = []) {
  return {
    longTaskCount: values.length,
    longTaskTotalMs: values.reduce((sum, value) => sum + value, 0),
    longTaskMaxMs: values.length ? Math.max(...values) : 0,
  };
}

async function sampleWheel(run, point, { horizontal, count = 7, delta = 240, cadenceMs = 100 }) {
  await startFrameWindow(run);
  const start = process.hrtime.bigint();
  for (let index = 0; index < count; index += 1) {
    await run.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: point.x, y: point.y,
      deltaX: horizontal ? delta : 0,
      deltaY: horizontal ? 0 : delta,
    });
    if (index + 1 < count) await new Promise((resolve) => setTimeout(resolve, cadenceMs));
  }
  await waitRendererStable(run);
  const observed = await stopFrameWindow(run);
  const intervals = frameIntervalsFromTimestamps(observed.frameTimestamps);
  return {
    ...observed,
    ...intervals,
    totalInteractionDurationMs: hrElapsed(start),
  };
}

async function openNamed(run, fixtures, name, fixtureRoot) {
  await cleanTabs(run);
  const fixturePath = getFilePath(fixtures, name, fixtureRoot);
  return openFixture(run, fixturePath, { expected: fixtures.files[name] });
}

async function runScenario(name, context, sampleIndex) {
  const { run, fixtures, fixtureRoot } = context;
  const info = context.manifest.files;
  let prepared = null;
  let measured;

  if (name.startsWith("workspace.open.")) {
    const workspaceName = name.slice("workspace.open.".length);
    const workspace = fixtures.workspaces.find((item) => item.name === workspaceName);
    const workspacePath = getWorkspacePath(fixtures, workspaceName, fixtureRoot);
    await cleanupWorkspace(run);
    try {
      measured = await stableMeasured(run, name, sampleIndex,
        `return await editor.fileExplorer.loadProject(${js(workspacePath)});`);
      const explorer = await run.cdp.evaluate(`({
        rootPathMatches: editor.fileExplorer.rootPath === ${js(workspacePath)},
        files: editor.fileExplorer.files.length,
        entries: editor.fileExplorer.files.map((item) => ({ name: item.name, type: item.type })),
        renderedRows: document.querySelectorAll(".file-explorer-entry").length,
        loaded: editor.fileExplorer.isLoaded === true,
        diagnostic: editor.fileExplorer.__benchmarkWorkspaceDiagnostic || null
      })`, run.scenarioTimeoutMs || run.timeoutMs);
      const diagnostic = explorer?.diagnostic || {};
      const expectedRootEntries = workspace?.rootEntries;
      const logicalRootEntries = workspaceRootEntryCount(explorer?.entries);
      const loaded = measured.value === true && explorer?.loaded === true &&
        explorer?.rootPathMatches === true && logicalRootEntries === expectedRootEntries &&
        diagnostic.watcherStarted === true && diagnostic.initialFolderLoadCompleted === true;
      measured.metrics.workspaceEntries = workspace?.entries;
      measured.metrics.workspaceFiles = workspace?.files;
      measured.metrics.workspaceFolders = workspace?.folders;
      measured.metrics.expectedRootEntries = expectedRootEntries;
      measured.metrics.explorerRootEntries = logicalRootEntries;
      measured.metrics.explorerRootEntriesRaw = explorer?.files;
      measured.metrics.nceInternalRootEntry = explorer?.entries?.some((entry) => entry.name === ".nce") ? 1 : 0;
      measured.metrics.explorerRenderedRows = explorer?.renderedRows;
      measured.metrics.rendererJsHeapMB = (await collectMemory(run)).rendererJsHeapMB;
      measured.metrics.workspaceOpenRequestMs = measured.metrics.actionDurationMs;
      measured.value = { ...measured.value, diagnostic: {
        failureCode: diagnostic.failureCode || null,
        pathExists: diagnostic.pathStatus?.exists === true,
        pathIsDirectory: diagnostic.pathStatus?.isDirectory === true,
        pathReadable: diagnostic.pathStatus?.readable !== false,
        watcherStarted: diagnostic.watcherStarted === true,
        watcherError: diagnostic.watcherError || null,
        initialFolderLoadCompleted: diagnostic.initialFolderLoadCompleted === true,
        initialFolderEntryCount: diagnostic.initialFolderEntryCount,
        logicalRootEntryCount: logicalRootEntries,
        rawRootEntryCount: explorer?.files,
        nceInternalRootEntry: explorer?.entries?.some((entry) => entry.name === ".nce") === true,
        rootPathMatches: explorer?.rootPathMatches === true,
        loaded: explorer?.loaded === true,
      } };
      if (!loaded) {
        const failureCode = diagnostic.failureCode || classifyWorkspaceFailure({
          pathStatus: diagnostic.pathStatus,
          watcherStarted: diagnostic.watcherStarted,
          watcherError: diagnostic.watcherError,
          initialFolderLoadCompleted: diagnostic.initialFolderLoadCompleted,
          initialFolderEntryCount: diagnostic.initialFolderEntryCount,
        });
        throw new Error(`Workspace '${workspaceName}' failed (${failureCode}): path exists=${diagnostic.pathStatus?.exists === true}, ` +
          `directory=${diagnostic.pathStatus?.isDirectory === true}, readable=${diagnostic.pathStatus?.readable !== false}, ` +
          `watcherStarted=${diagnostic.watcherStarted === true}, folderLoadCompleted=${diagnostic.initialFolderLoadCompleted === true}, ` +
          `rootEntries=${logicalRootEntries ?? "unknown"}/${expectedRootEntries ?? "unknown"} (raw=${explorer?.files ?? "unknown"}), rootPathMatches=${explorer?.rootPathMatches === true}`);
      }
      return measured;
    } finally {
      await cleanupWorkspace(run);
    }
  }

  if (name.startsWith("file.open.")) {
    const rawFixtureName = name.slice("file.open.".length);
    const fixtureName = /^(?:10kb|100kb|1mb|5mb|10mb|50mb)$/.test(rawFixtureName)
      ? `size-${rawFixtureName}` : rawFixtureName;
    prepared = info[fixtureName];
    if (!prepared) throw new Error(`Unknown file fixture '${fixtureName}'`);
    await cleanTabs(run);
    const fixturePath = getFilePath(fixtures, fixtureName, fixtureRoot);
    if (fixtureName === "binary") {
      measured = await stableMeasured(run, name, sampleIndex, `let refused = false; let error = null; try { await editor.tabManager.openFileWithPath(${js(fixturePath)}); } catch (caught) { refused = true; error = String(caught?.message || caught); } const active = editor.tabManager.activeFile; if (active?.loadingState?.status === "failed" || active?.isLoaded !== true) refused = true; return { refused, error, activePath: active?.path || null };`);
      if (measured.value?.refused !== true) throw new Error("NCE accepted the binary fixture as a text file");
      measured.metrics.binaryRejected = 1;
      measured.metrics.fileBytes = prepared.bytes;
      return measured;
    }
    const diagnosticsBefore = await diagnostics(run);
    const eventOffset = diagnosticsBefore?.events?.length || 0;
    const opened = await openFixture(run, fixturePath, { expected: prepared, waitForFullModel: true });
    const diagnosticsAfter = await diagnostics(run);
    const readMetrics = fileReadMetrics(diagnosticsAfter, eventOffset);
    const domNodes = await run.cdp.evaluate("document.querySelectorAll('*').length");
    const editorDomNodes = await run.cdp.evaluate("document.querySelectorAll('.editor-output *').length");
    const lineCount = Number(opened.lineCount);
    if (lineCount !== prepared.lines) throw new Error(`FILE_LINE_COUNT_MISMATCH: expected ${prepared.lines}, loaded ${lineCount}`);
    if (readMetrics.fileReadBytes !== prepared.bytes) throw new Error(`FILE_BYTE_COUNT_MISMATCH: expected ${prepared.bytes} bytes read, got ${readMetrics.fileReadBytes}`);
    if (readMetrics.fileChunkLines !== prepared.lines) throw new Error(`FILE_CHUNK_COUNT_MISMATCH: expected ${prepared.lines} lines, chunk events report ${readMetrics.fileChunkLines}`);
    const metrics = {
      durationMs: opened.initialViewportDurationMs,
      rendererDurationMs: opened.initialViewportRendererMs,
      fileOpenRequestMs: opened.fileOpenRequestMs,
      fileInitialViewportStableMs: opened.initialViewportStableMs,
      fileModelReadyMs: opened.fileModelReadyMs,
      fileStableRenderMs: opened.fileStableRenderMs,
      fileModelLoadWaitMs: opened.fileModelLoadWaitDurationMs,
      fileFullyReadyMs: opened.fileFullyReadyDurationMs,
      fileBytes: prepared.bytes,
      expectedFileBytes: prepared.bytes,
      lineCount: prepared.lines,
      modelLineCount: lineCount,
      maxLineLength: prepared.maxLineLength,
      domNodeCount: domNodes,
      editorOutputNodeCount: editorDomNodes,
      ...readMetrics,
    };
    return { metrics, value: { path: opened.path, loaded: true, lines: lineCount, tabs: opened.tabCount, phases: {
      fileOpenRequestMs: opened.fileOpenRequestMs,
      fileModelReadyMs: opened.fileModelReadyMs,
      fileStableRenderMs: opened.fileStableRenderMs,
    } } };
  }

  if (name === "tabs.open") {
    await cleanTabs(run);
    const filePaths = ["tiny", "small", "medium"].map((fixture) => getFilePath(fixtures, fixture, fixtureRoot));
    const measuredIndex = sampleIndex % filePaths.length;
    for (let index = 0; index < measuredIndex; index += 1) await openFixture(run, filePaths[index]);
    const target = filePaths[measuredIndex];
    measured = await stableMeasured(run, name, sampleIndex,
      `await editor.tabManager.openFileWithPath(${js(target)}); return { tabs: editor.tabManager.tabs.length, activePath: editor.tabManager.activeFile?.path };`);
    measured.metrics.openTabs = measured.value?.tabs;
    return measured;
  }

  if (name === "tabs.switch") {
    if (!context.switchTabs?.length) {
      await cleanTabs(run);
      for (const fixture of ["tiny", "small", "medium"]) await openFixture(run, getFilePath(fixtures, fixture, fixtureRoot));
      context.switchTabs = await run.cdp.evaluate("editor.tabManager.files.map(file => file.id)");
    }
    const id = context.switchTabs[sampleIndex % context.switchTabs.length];
    measured = await stableMeasured(run, name, sampleIndex,
      `const tab = editor.tabManager.getFileByID(${js(id)}); await editor.tabManager.setFocusFile(tab); return { activeId: editor.tabManager.activeFile?.id, tabCount: editor.tabManager.tabs.length };`);
    measured.metrics.openTabs = measured.value?.tabCount;
    measured.metrics.activeTabId = Number(measured.value?.activeId);
    return measured;
  }

  if (name === "tabs.close") {
    await cleanTabs(run);
    const opened = await openFixture(run, getFilePath(fixtures, "small", fixtureRoot));
    measured = await stableMeasured(run, name, sampleIndex,
      `await editor.tabManager.closeFile(${js(opened.id)}); return { tabs: editor.tabManager.tabs.length };`);
    measured.metrics.remainingTabs = measured.value?.tabs;
    if (measured.value?.tabs !== 0) throw new Error("Closing the tab did not leave the editor empty");
    return measured;
  }

  if (name === "tabs.close-all") {
    await cleanTabs(run);
    for (const fixture of ["tiny", "small", "medium"]) await openFixture(run, getFilePath(fixtures, fixture, fixtureRoot));
    measured = await stableMeasured(run, name, sampleIndex,
      `await editor.tabManager.closeFiles({ skipPrepare: true }); return { tabs: editor.tabManager.tabs.length };`);
    measured.metrics.remainingTabs = measured.value?.tabs;
    if (measured.value?.tabs !== 0) throw new Error("Close all did not close every editor tab");
    return measured;
  }

  if (name.startsWith("memory.open-close-")) {
    const fixtureName = name.endsWith("long-line") ? "long-line-1m" : name.endsWith("large") ? "large" : "small";
    const fixture = fixtures.files[fixtureName];
    const fixturePath = getFilePath(fixtures, fixtureName, fixtureRoot);
    await cleanTabs(run);
    const before = await collectMemory(run, { forceGc: true });
    const cycleStart = process.hrtime.bigint();
    const opened = await openFixture(run, fixturePath, { expected: fixture });
    const during = await collectMemory(run);
    const openCycleMs = hrElapsed(cycleStart);
    const closeStart = process.hrtime.bigint();
    await run.cdp.evaluate(`editor.tabManager.closeFiles({ skipPrepare: true })`);
    await waitRendererStable(run);
    const after = await collectMemory(run, { forceGc: true });
    const closeMs = hrElapsed(closeStart);
    measured = {
      metrics: {
        durationMs: hrElapsed(cycleStart),
        openCloseCycleDurationMs: hrElapsed(cycleStart),
        fileOpenRequestMs: opened.fileOpenRequestMs,
        fileModelReadyMs: opened.fileModelReadyMs,
        fileStableRenderMs: opened.fileStableRenderMs,
        fileModelLoadWaitMs: opened.fileModelLoadWaitDurationMs,
        fileFullyReadyMs: opened.fileFullyReadyDurationMs,
        closeDurationMs: closeMs,
        memoryBeforeJsHeapMB: before.rendererJsHeapMB,
        memoryDuringJsHeapMB: during.rendererJsHeapMB,
        memoryAfterCloseJsHeapMB: after.rendererJsHeapMB,
        memoryDeltaAfterCloseMB: after.rendererJsHeapMB - before.rendererJsHeapMB,
        mainRssBeforeMB: before.mainProcessRssMB,
        mainRssDuringMB: during.mainProcessRssMB,
        mainRssAfterCloseMB: after.mainProcessRssMB,
        mainRssDeltaDuringMB: Number.isFinite(during.mainProcessRssMB) && Number.isFinite(before.mainProcessRssMB) ? during.mainProcessRssMB - before.mainProcessRssMB : null,
        mainRssDeltaAfterCloseMB: Number.isFinite(after.mainProcessRssMB) && Number.isFinite(before.mainProcessRssMB) ? after.mainProcessRssMB - before.mainProcessRssMB : null,
        electronPrivateMemoryBeforeMB: before.electronPrivateMemoryMB,
        electronPrivateMemoryDuringMB: during.electronPrivateMemoryMB,
        electronPrivateMemoryAfterCloseMB: after.electronPrivateMemoryMB,
        fileBytes: fixture.bytes,
        lineCount: fixture.lines,
        fileFullyLoaded: opened.loadedLines === fixture.lines ? 1 : 0,
        forcedGc: 1,
      },
      value: { openedFileId: opened.id, phases: {
        fileOpenRequestMs: opened.fileOpenRequestMs,
        fileModelReadyMs: opened.fileModelReadyMs,
        fileStableRenderMs: opened.fileStableRenderMs,
        fileFullyReadyMs: opened.fileFullyReadyDurationMs,
        openCloseCycleMs: openCycleMs,
      } },
    };
    return measured;
  }

  if (name === "memory.repeated-open-close") {
    await cleanTabs(run);
    const fixtureName = fixtures.files["large"] ? "large" : "medium";
    const fixture = fixtures.files[fixtureName];
    const filePath = getFilePath(fixtures, fixtureName, fixtureRoot);
    const memorySeriesMB = [];
    const cycleDurationsMs = [];
    const cycleOpenDurationsMs = [];
    const cycleCloseDurationsMs = [];
    const cycleCount = context.mode === "full" ? 10 : 5;
    const totalStart = process.hrtime.bigint();
    await cleanTabs(run);
    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      const cycleStart = process.hrtime.bigint();
      const opened = await openFixture(run, filePath, { expected: fixture });
      cycleOpenDurationsMs.push(opened.fileFullyReadyDurationMs);
      const closeStart = process.hrtime.bigint();
      await run.cdp.evaluate("editor.tabManager.closeFiles({ skipPrepare: true })");
      await waitRendererStable(run);
      cycleCloseDurationsMs.push(hrElapsed(closeStart));
      const memory = await collectMemory(run, { forceGc: true });
      memorySeriesMB.push(memory.rendererJsHeapMB);
      cycleDurationsMs.push(hrElapsed(cycleStart));
    }
    const first = memorySeriesMB[0];
    const last = memorySeriesMB[memorySeriesMB.length - 1];
    const totalScenarioDurationMs = hrElapsed(totalStart);
    measured = {
      metrics: {
        durationMs: totalScenarioDurationMs,
        totalScenarioDurationMs,
        cycles: cycleCount,
        fileBytes: fixture.bytes,
        lineCount: fixture.lines,
        openCloseCycleP50Ms: [...cycleDurationsMs].sort((a, b) => a - b)[Math.floor((cycleDurationsMs.length - 1) * 0.5)],
        averageOpenCloseCycleMs: cycleDurationsMs.reduce((sum, value) => sum + value, 0) / cycleCount,
        averageFileFullyReadyMs: cycleOpenDurationsMs.reduce((sum, value) => sum + value, 0) / cycleCount,
        averageCloseDurationMs: cycleCloseDurationsMs.reduce((sum, value) => sum + value, 0) / cycleCount,
        memoryFirstCycleMB: first,
        memoryLastCycleMB: last,
        memoryChangeMB: last - first,
        memorySlopeMBPerCycle: (last - first) / Math.max(1, cycleCount - 1),
      },
      value: { memorySeriesMB, cycleDurationsMs, cycleOpenDurationsMs, cycleCloseDurationsMs },
    };
    return measured;
  }

  if (["editor.typing", "editor.backspace", "editor.enter", "editor.cursor"].includes(name)) {
    const opened = await openNamed(run, fixtures, "small", fixtureRoot);
    await focusEditor(run);
    const before = await run.cdp.evaluate(`(() => {
      const file = editor.tabManager.activeFile;
      const lineLengths = file.lines.map(line => line.getText().length);
      return { length: lineLengths.reduce((sum, item) => sum + item, 0) + Math.max(0, lineLengths.length - 1) + (file.hasFinalNewline ? 1 : 0), row: editor.cursorController.row, column: editor.cursorController.column };
    })()`);
    const start = process.hrtime.bigint();
    const startMark = markName(name, sampleIndex, "input");
    await run.cdp.evaluate(`performance.mark(${js(startMark)}); true`);
    if (name === "editor.typing") {
      await sendKey(run, "x", { code: "KeyX", text: "x", windowsVirtualKeyCode: 88 });
    } else if (name === "editor.backspace") {
      await sendKey(run, "x", { code: "KeyX", text: "x", windowsVirtualKeyCode: 88 });
      await sendKey(run, "Backspace", { code: "Backspace", windowsVirtualKeyCode: 8 });
    } else if (name === "editor.enter") {
      await sendKey(run, "Enter", { code: "Enter", windowsVirtualKeyCode: 13 });
    } else if (name === "editor.cursor") {
      for (let index = 0; index < 10; index += 1) await sendKey(run, "ArrowRight", { code: "ArrowRight", windowsVirtualKeyCode: 39 });
    }
    const actionDispatchMs = hrElapsed(start);
    const renderPhases = await run.cdp.evaluate(`(async () => {
      const file = editor.tabManager.activeFile;
      const lineLengths = file.lines.map(line => line.getText().length);
      const length = lineLengths.reduce((sum, item) => sum + item, 0) + Math.max(0, lineLengths.length - 1) + (file.hasFinalNewline ? 1 : 0);
      const modelUpdatedAt = performance.now();
      await ${rafTwo()};
      const stableAt = performance.now();
      const inputMark = performance.getEntriesByName(${js(startMark)}).at(-1)?.startTime;
      performance.clearMarks(${js(startMark)});
      return { length, row: editor.cursorController.row, column: editor.cursorController.column, rendererLogicalMs: modelUpdatedAt - inputMark, stableFrameWaitMs: stableAt - modelUpdatedAt, inputToStableFrameMs: stableAt - inputMark };
    })()`, run.scenarioTimeoutMs || run.timeoutMs);
    const after = await run.cdp.evaluate("({ offsetX: editor.tabManager.activeFile.offsetX, offsetY: editor.tabManager.activeFile.offsetY })");
    const lengthDelta = Number(renderPhases.length) - Number(before.length);
    if (name === "editor.typing" && lengthDelta !== 1) throw new Error(`Typing changed logical document length by ${lengthDelta}, expected +1`);
    if (name === "editor.backspace" && lengthDelta !== 0) throw new Error(`Backspace cycle changed logical document length by ${lengthDelta}, expected 0`);
    if (name === "editor.enter" && lengthDelta !== 1) throw new Error(`Enter changed logical document length by ${lengthDelta}, expected +1`);
    return {
      metrics: {
        durationMs: renderPhases?.inputToStableFrameMs,
        actionDurationMs: actionDispatchMs,
        rendererLogicalMs: renderPhases?.rendererLogicalMs,
        stableFrameWaitMs: renderPhases?.stableFrameWaitMs,
        inputToStableFrameMs: renderPhases?.inputToStableFrameMs,
        // Compatibility metric; includes the two RAF stability wait.
        rendererDurationMs: renderPhases?.inputToStableFrameMs,
        contentLengthBefore: Number(before.length),
        contentLengthAfter: Number(renderPhases?.length),
        fileFullyReadyMs: opened.fileFullyReadyDurationMs,
        cursorOffsetX: Number(after?.offsetX),
        cursorOffsetY: Number(after?.offsetY),
        longTaskCount: 0,
      },
      value: { ...renderPhases, actionDispatchMs },
    };
  }

  if (["editor.select-all", "editor.select-all-large", "editor.select-all-long-line", "editor.copy-selection", "editor.copy-large-selection"].includes(name)) {
    const isCopy = name.startsWith("editor.copy-");
    const fixtureName = name.endsWith("long-line") || name.endsWith("large-selection")
      ? "long-line-1m" : name.endsWith("-large") ? "large" : "small";
    const fixture = fixtures.files[fixtureName];
    const opened = await openNamed(run, fixtures, fixtureName, fixtureRoot);
    await focusEditor(run);
    const startMark = markName(name, sampleIndex, "input");
    await run.cdp.evaluate(`performance.mark(${js(startMark)}); true`);
    let getSelectedTextCallCount = null;
    if (!isCopy) {
      await run.cdp.evaluate(`(() => {
        const controller = editor.selectController;
        const original = controller.getSelectedText;
        const ownDescriptor = Object.getOwnPropertyDescriptor(controller, "getSelectedText");
        window.__nceGetSelectedTextCalls = 0;
        controller.getSelectedText = function(...args) { window.__nceGetSelectedTextCalls += 1; return original.apply(this, args); };
        window.__nceGetSelectedTextRestore = () => {
          if (ownDescriptor) Object.defineProperty(controller, "getSelectedText", ownDescriptor);
          else delete controller.getSelectedText;
        };
      })()`);
    }
    const actionStart = process.hrtime.bigint();
    await dispatchShortcut(run, "a");
    const selectDispatchMs = hrElapsed(actionStart);
    let result;
    if (isCopy) {
      result = await run.cdp.evaluate(`(async () => {
        const selectController = editor.selectController;
        const file = editor.tabManager.activeFile;
        const logicalLength = selectController.getSelectionLength();
        const actionStartedAt = performance.now();
        await editor.keyBinding.control_copy();
        const actionFinishedAt = performance.now();
        await ${rafTwo()};
        const stableAt = performance.now();
        return { logicalLength, actionDurationMs: actionFinishedAt - actionStartedAt, stableFrameWaitMs: stableAt - actionFinishedAt, inputToStableFrameMs: stableAt - performance.getEntriesByName(${js(startMark)}).at(-1).startTime, expectedFinalNewline: file.hasFinalNewline === true };
      })()`, run.scenarioTimeoutMs || run.timeoutMs);
      result.clipboard = await run.cdp.evaluate(`(async () => { const text = await window.api.readClipboardText(); return { length: text.length, finalNewline: text.endsWith("\\n"), matchesLogicalLength: text.length === ${js(result.logicalLength)} }; })()`, run.scenarioTimeoutMs || run.timeoutMs);
      if (!result.clipboard?.matchesLogicalLength || result.clipboard.finalNewline !== result.expectedFinalNewline) {
        throw new Error(`COPY_SELECTION_MISMATCH: clipboard length=${result.clipboard?.length}, logical length=${result.logicalLength}, final newline=${result.clipboard?.finalNewline}`);
      }
    } else {
      result = await run.cdp.evaluate(`(async () => {
        const validateLogicalSelectAll = ${validateLogicalSelectAll.toString()};
        const selectController = editor.selectController;
        const file = editor.tabManager.activeFile;
        const selection = selectController.getLogicalSelection();
        const selectedLength = selectController.getSelectionLength();
        const expected = validateLogicalSelectAll({ selection, selectedLength, lineLengths: file.lines.map(line => line.getText().length), hasFinalNewline: file.hasFinalNewline === true });
        const actionFinishedAt = performance.now();
        await ${rafTwo()};
        const stableAt = performance.now();
        const calls = window.__nceGetSelectedTextCalls || 0;
        window.__nceGetSelectedTextRestore?.();
        delete window.__nceGetSelectedTextCalls;
        delete window.__nceGetSelectedTextRestore;
        return { selection, selectedLength, expectedLength: expected.expectedLength, expectedFinalNewline: file.hasFinalNewline === true, getSelectedTextCallCount: calls, actionDurationMs: actionFinishedAt - performance.getEntriesByName(${js(startMark)}).at(-1).startTime, stableFrameWaitMs: stableAt - actionFinishedAt, inputToStableFrameMs: stableAt - performance.getEntriesByName(${js(startMark)}).at(-1).startTime };
      })()`, run.scenarioTimeoutMs || run.timeoutMs);
      getSelectedTextCallCount = Number(result?.getSelectedTextCallCount);
      if (getSelectedTextCallCount !== 0) throw new Error(`Select All materialized selection text ${getSelectedTextCallCount} time(s)`);
    }
    await run.cdp.evaluate(`performance.clearMarks(${js(startMark)})`);
    if (isCopy) {
      result.materializedCopyCharacters = result.clipboard?.length;
    }
    measured = {
      metrics: {
        durationMs: result?.inputToStableFrameMs,
        actionDurationMs: selectDispatchMs + (result?.actionDurationMs || 0),
        stableFrameWaitMs: result?.stableFrameWaitMs,
        inputToStableFrameMs: result?.inputToStableFrameMs,
        rendererDurationMs: result?.inputToStableFrameMs,
        selectedCharacters: Number(result?.selectedLength ?? result?.logicalLength),
        expectedSelectedCharacters: Number(result?.expectedLength ?? result?.logicalLength),
        fileBytes: fixture.bytes,
        lineCount: fixture.lines,
        hasFinalNewline: result?.expectedFinalNewline ? 1 : 0,
        getSelectedTextCallCount,
        ...(isCopy ? { copyCharacters: result.clipboard?.length, copyFinalNewline: result.clipboard?.finalNewline ? 1 : 0 } : {}),
        fileFullyReadyMs: opened.fileFullyReadyDurationMs,
      },
      value: { ...result, actionDispatchMs: selectDispatchMs },
    };
    return measured;
  }

  if (name === "editor.search" || name === "editor.search-many-results" || name === "editor.search-long-line") {
    const fixtureName = name.endsWith("many-results") ? "search-many" : name.endsWith("long-line") ? "long-line-1m" : "small";
    const query = name.endsWith("long-line") ? "xxxxxxxxxx" : "benchmark";
    await openNamed(run, fixtures, fixtureName, fixtureRoot);
    measured = await stableMeasured(run, name, sampleIndex,
      `editor.searchController.open(); const input = editor.searchController.input; input.value = ${js(query)}; input.dispatchEvent(new Event("input", { bubbles: true })); return { results: editor.searchController.results.length, query: input.value, resultRows: editor.searchController.resultsByRow.size, visibleResultNodes: editor.searchOutput?.children?.length || 0 };`);
    measured.metrics.searchResults = measured.value?.results;
    measured.metrics.searchResultRows = measured.value?.resultRows;
    measured.metrics.visibleSearchResultNodes = measured.value?.visibleResultNodes;
    measured.metrics.queryLength = measured.value?.query?.length;
    measured.metrics.fileBytes = fixtures.files[fixtureName].bytes;
    measured.metrics.lineCount = fixtures.files[fixtureName].lines;
    if (name.endsWith("long-line") && measured.value?.results !== 100000) {
      throw new Error(`SEARCH_RESULT_COUNT_MISMATCH: expected 100000, got ${measured.value?.results}`);
    }
    return measured;
  }

  if (name === "scroll.vertical" || name.startsWith("scroll.horizontal")) {
    const horizontal = name.startsWith("scroll.horizontal");
    const fixtureName = name.endsWith("tabs-1m") ? "long-line-tabs-1m"
      : name.endsWith("unicode") ? "long-unicode"
        : horizontal ? horizontalScrollFixture(context.mode) : (fixtures.files.large ? "large" : "medium");
    await openNamed(run, fixtures, fixtureName, fixtureRoot);
    const point = await focusEditor(run);
    const zones = horizontal && context.mode === "full" ? ["beginning", "middle", "near-end"] : [horizontal ? "middle" : "document"];
    const zoneResults = [];
    for (const zone of zones) {
      if (horizontal) {
        await run.cdp.evaluate(`(() => {
          const file = editor.tabManager.activeFile;
          const scroller = editor.lineController.outputScroller;
          const maxOffset = Math.max(0, file.maxLineLength + 10 - Math.floor(scroller.getVisibleHorizontalWidth() / editor.letterSize));
          const target = ${js(zone)} === "beginning" ? 0 : ${js(zone)} === "near-end" ? Math.max(0, maxOffset - 1500) : Math.floor(maxOffset / 2);
          scroller.setHorizontalOffset(target);
          return { target, maxOffset, offset: file.offsetX };
        })()`);
      }
      await waitRendererStable(run);
      const before = await run.cdp.evaluate("({ x: editor.tabManager.activeFile.offsetX, y: editor.tabManager.activeFile.offsetY })");
      const delta = horizontal && zone === "near-end" ? -240 : 240;
      const frameSample = await sampleWheel(run, point, { horizontal, count: 8, delta, cadenceMs: 100 });
      const after = await run.cdp.evaluate("({ x: editor.tabManager.activeFile.offsetX, y: editor.tabManager.activeFile.offsetY })");
      const moved = horizontal ? Number(after?.x) !== Number(before?.x) : Number(after?.y) !== Number(before?.y);
      if (!moved) throw new Error(`${name} did not change ${horizontal ? "horizontal" : "vertical"} offset in zone '${zone}'`);
      zoneResults.push({ zone, before, after, deltaX: Number(after?.x) - Number(before?.x), deltaY: Number(after?.y) - Number(before?.y), ...frameSample });
    }
    const intervals = zoneResults.flatMap((zone) => zone.frameIntervalsMs);
    const invalidFrameIntervalCount = zoneResults.reduce((total, zone) => total + zone.invalidFrameIntervalCount, 0);
    const frameCallbackCount = zoneResults.reduce((total, zone) => total + zone.frameCallbackCount, 0);
    const longTasks = zoneResults.flatMap((zone) => zone.longTasks);
    const frameSummary = summarizeFrameIntervals(intervals, { invalidFrameIntervalCount, frameCallbackCount });
    const interactionDurationMs = zoneResults.reduce((sum, zone) => sum + zone.totalInteractionDurationMs, 0);
    return {
      metrics: {
        durationMs: interactionDurationMs,
        totalInteractionDurationMs: interactionDurationMs,
        ...frameSummary,
        ...summarizeLongTasks(longTasks),
        scrollDeltaX: zoneResults.reduce((sum, zone) => sum + zone.deltaX, 0),
        scrollDeltaY: zoneResults.reduce((sum, zone) => sum + zone.deltaY, 0),
        scrollZones: zoneResults.length,
        fileBytes: fixtures.files[fixtureName].bytes,
        lineCount: fixtures.files[fixtureName].lines,
      },
      value: { fixtureName, zones: zoneResults.map(({ frameIntervalsMs, frameTimestamps, longTasks, ...zone }) => zone) },
    };
  }

  if (name === "editor.syntax-highlight") {
    const opened = await openNamed(run, fixtures, "sample-js", fixtureRoot);
    const state = await run.cdp.evaluate(`({ loaded: editor.tabManager.activeFile?.isLoaded === true, language: editor.tabManager.activeFile?.language, tabs: editor.tabManager.tabs.length, highlightedDomNodes: document.querySelectorAll(".editor-output *").length })`);
    if (!state.loaded) throw new Error("JavaScript syntax fixture did not load");
    return { metrics: {
      durationMs: opened.initialViewportDurationMs,
      rendererDurationMs: opened.initialViewportRendererMs,
      fileOpenRequestMs: opened.fileOpenRequestMs,
      fileModelReadyMs: opened.fileModelReadyMs,
      fileStableRenderMs: opened.fileStableRenderMs,
      fileFullyReadyMs: opened.fileFullyReadyDurationMs,
      syntaxLineCount: fixtures.files["sample-js"].lines,
      highlightedDomNodes: state.highlightedDomNodes,
    }, value: { ...state, phases: { fileOpenRequestMs: opened.fileOpenRequestMs, fileModelReadyMs: opened.fileModelReadyMs, fileStableRenderMs: opened.fileStableRenderMs } } };
  }

  if (["dom.count", "dom.count-large", "dom.count-long-line"].includes(name)) {
    const fixtureName = name === "dom.count-large" ? "large" : name === "dom.count-long-line" ? horizontalScrollFixture(context.mode) : "medium";
    await openNamed(run, fixtures, fixtureName, fixtureRoot);
    const dom = await run.cdp.evaluate(`({ domNodeCount: document.querySelectorAll("*").length, editorOutputNodeCount: document.querySelectorAll(".editor-output *").length, editorRowNodeCount: editor.output?.children?.length || 0, modelLineCount: editor.tabManager.activeFile?.totalLines, isFullyLoaded: editor.tabManager.activeFile?.loadingState?.status === "loaded" })`);
    if (!dom.isFullyLoaded) throw new Error("DOM scenario started before the file model was fully loaded");
    if (name === "dom.count-large" && dom.editorRowNodeCount >= 5000) throw new Error(`EDITOR_VIRTUALIZATION_FAILED: ${dom.editorRowNodeCount} output rows for ${dom.modelLineCount} model lines`);
    return { metrics: { durationMs: 0, ...dom, fileBytes: fixtures.files[fixtureName].bytes }, value: { fixtureName, ...dom } };
  }

  if (name === "idle.renderer" || name === "renderer.raf-cadence") {
    const durationMs = context.mode === "quick" ? 1500 : 2500;
    await startFrameWindow(run);
    const start = process.hrtime.bigint();
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const observed = await stopFrameWindow(run);
    const actualDurationMs = hrElapsed(start);
    const intervals = frameIntervalsFromTimestamps(observed.frameTimestamps);
    const summary = summarizeFrameIntervals(intervals.frameIntervalsMs, intervals);
    return {
      metrics: {
        durationMs: actualDurationMs,
        observationDurationMs: actualDurationMs,
        ...summary,
        ...summarizeLongTasks(observed.longTasks),
      },
      value: { ...intervals },
    };
  }

  if (name === "idle.activity") {
    const observationDurationMs = context.mode === "quick" ? 2000 : 5000;
    const before = await collectMemory(run);
    const beforePerf = await run.cdp.send("Performance.getMetrics");
    const beforeDiag = await diagnostics(run);
    await run.cdp.evaluate("window.__nceBenchmarkState.longTasks.length = 0");
    const start = process.hrtime.bigint();
    await new Promise((resolve) => setTimeout(resolve, observationDurationMs));
    const elapsedMs = hrElapsed(start);
    const [after, afterPerf, afterDiag, longTasks] = await Promise.all([
      collectMemory(run),
      run.cdp.send("Performance.getMetrics"),
      diagnostics(run),
      run.cdp.evaluate(`(() => { const values = window.__nceBenchmarkState?.longTasks || []; const result = values.slice(); values.length = 0; return result; })()`),
    ]);
    const perfMap = (response) => Object.fromEntries((response?.metrics || []).map((metric) => [metric.name, metric.value]));
    const beforeMetrics = perfMap(beforePerf);
    const afterMetrics = perfMap(afterPerf);
    const cpuBefore = beforeDiag?.mainProcess?.cpu;
    const cpuAfter = afterDiag?.mainProcess?.cpu;
    const mainCpuMetrics = collectMainCpuMetrics(cpuBefore, cpuAfter, name);
    return {
      metrics: {
        durationMs: elapsedMs,
        observationDurationMs: elapsedMs,
        ...mainCpuMetrics,
        rendererScriptDurationDeltaMs: Number.isFinite(afterMetrics.ScriptDuration) && Number.isFinite(beforeMetrics.ScriptDuration) ? (afterMetrics.ScriptDuration - beforeMetrics.ScriptDuration) * 1000 : null,
        rendererTaskDurationDeltaMs: Number.isFinite(afterMetrics.TaskDuration) && Number.isFinite(beforeMetrics.TaskDuration) ? (afterMetrics.TaskDuration - beforeMetrics.TaskDuration) * 1000 : null,
        rendererHeapBeforeMB: before.rendererJsHeapMB,
        rendererHeapAfterMB: after.rendererJsHeapMB,
        rendererHeapDriftMB: Number.isFinite(before.rendererJsHeapMB) && Number.isFinite(after.rendererJsHeapMB) ? after.rendererJsHeapMB - before.rendererJsHeapMB : null,
        ...summarizeLongTasks(longTasks),
      },
      value: { observationDurationMs: elapsedMs, rendererDomNodesBefore: before.rendererDomNodes, rendererDomNodesAfter: after.rendererDomNodes },
    };
  }

  throw new Error(`No runner is implemented for scenario '${name}'`);
}

async function runStartupIteration({ timeoutMs, profileLabel }) {
  const run = await require("./application.cjs").launchNce({ timeoutMs, profileLabel });
  try {
    await run.connect();
    const spawnToWindowTargetMs = run.elapsedMs();
    await run.waitFor("window.editor && editor.isOnInit === false", "NCE editor initialization");
    await run.cdp.evaluate(`(async () => { await window.api.setAutoSaveState(false); await ${rafTwo()}; return true; })()`, 10000);
    const timeToInteractiveMs = run.elapsedMs();
    const diagnosticsBeforeClose = await diagnostics(run);
    const navTiming = await run.cdp.evaluate(`(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      if (!navigation) return null;
      return {
        domContentLoadedMs: navigation.domContentLoadedEventEnd,
        loadEventMs: navigation.loadEventEnd,
        responseMs: navigation.responseEnd,
        transferSizeBytes: navigation.transferSize
      };
    })()`);
    const current = run.elapsedMs();
    const metrics = {
      durationMs: current,
      spawnToRendererWindowMs: spawnToWindowTargetMs,
      spawnToInteractiveMs: timeToInteractiveMs,
      spawnToFirstStableFrameMs: current,
      rendererDomContentLoadedMs: navTiming?.domContentLoadedMs,
      rendererLoadEventMs: navTiming?.loadEventMs,
      mainProcessStartToAppReadyMs: diagnosticsBeforeClose?.events?.find((event) => event.name === "app-ready")?.offsetMs,
      appReadyToWindowCreateRequestMs: (() => {
        const events = diagnosticsBeforeClose?.events || [];
        const ready = events.find((event) => event.name === "app-ready")?.offsetMs;
        const request = events.find((event) => event.name === "window-create-request")?.offsetMs;
        return Number.isFinite(ready) && Number.isFinite(request) ? request - ready : null;
      })(),
      windowCreateRequestToBrowserWindowCreatedMs: (() => {
        const events = diagnosticsBeforeClose?.events || [];
        const request = events.find((event) => event.name === "window-create-request")?.offsetMs;
        const created = events.find((event) => event.name === "browser-window-created")?.offsetMs;
        return Number.isFinite(request) && Number.isFinite(created) ? created - request : null;
      })(),
      appReadyToWindowCreateMs: (() => {
        const events = diagnosticsBeforeClose?.events || [];
        const ready = events.find((event) => event.name === "app-ready")?.offsetMs;
        const created = events.find((event) => event.name === "browser-window-created")?.offsetMs;
        return Number.isFinite(ready) && Number.isFinite(created) ? created - ready : null;
      })(),
      browserWindowCreateToReadyToShowMs: (() => {
        const events = diagnosticsBeforeClose?.events || [];
        const created = events.find((event) => event.name === "browser-window-created")?.offsetMs;
        const ready = events.find((event) => event.name === "window-ready-to-show")?.offsetMs;
        return Number.isFinite(created) && Number.isFinite(ready) ? ready - created : null;
      })(),
      domReadyToRendererReadyMs: (() => {
        const events = diagnosticsBeforeClose?.events || [];
        const dom = events.find((event) => event.name === "renderer-dom-ready")?.offsetMs;
        const ready = events.find((event) => event.name === "renderer-ready")?.offsetMs;
        return Number.isFinite(dom) && Number.isFinite(ready) ? ready - dom : null;
      })(),
    };
    const closeStartedAt = process.hrtime.bigint();
    const closeResult = await run.close();
    metrics.applicationShutdownMs = hrElapsed(closeStartedAt);
    return {
      metrics,
      value: {
        phases: diagnosticsBeforeClose?.events || [],
        closeCode: closeResult.exitCode,
        closeSignal: closeResult.exitSignal,
        totalRunWallMs: run.elapsedMs(),
      },
    };
  } catch (error) {
    await run.close();
    throw error;
  }
}

module.exports = {
  runScenario,
  runStartupIteration,
  prepareRenderer,
  warmInteractiveApp,
  waitRendererStable,
  collectMemory,
  loadFixtureManifest,
  getFilePath,
  getWorkspacePath,
};
