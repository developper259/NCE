const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "../../..");

function js(value) { return JSON.stringify(value); }
function markName(name, sampleIndex, phase) {
  const safe = name.replace(/[^a-zA-Z0-9:._-]/g, "_");
  return `nce:benchmark:${safe}:${sampleIndex}:${phase}`;
}
function hrElapsed(start) { return Number(process.hrtime.bigint() - start) / 1e6; }
function rafTwo() { return "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"; }

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

function getWorkspacePath(fixtures, name) {
  const workspace = fixtures.workspaces.find((item) => item.name === name);
  if (!workspace) throw new Error(`Workspace fixture '${name}' is not present in the generated profile`);
  return workspace.path;
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
  await run.cdp.evaluate(rafTwo(), run.timeoutMs);
}

async function cleanTabs(run) {
  await run.cdp.evaluate(`(async () => {
    editor.searchController?.close?.();
    if (editor.tabManager?.tabs?.length) await editor.tabManager.closeFiles({ skipPrepare: true });
    return true;
  })()`, run.timeoutMs);
  await waitRendererStable(run);
}

async function openFixture(run, fixturePath) {
  const result = await run.cdp.evaluate(`(async () => {
    const filePath = ${js(fixturePath)};
    await editor.tabManager.openFileWithPath(filePath);
    const active = editor.tabManager.activeFile;
    return active ? {
      path: active.path,
      id: active.id,
      loaded: active.isLoaded === true,
      lineCount: active.totalLines,
      maxLineLength: active.maxLineLength,
      textLength: active.textLength,
      tabCount: editor.tabManager.tabs.length
    } : null;
  })()`, run.timeoutMs);
  if (!result || !result.loaded) throw new Error(`NCE did not load the fixture ${fixturePath}`);
  await waitRendererStable(run);
  return result;
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
    fileChunkMs: chunks.length ? chunkMs : null,
    fileReadBytes: initializes.reduce((sum, event) => sum + (Number(event.bytes) || 0), 0) || legacyReads.reduce((sum, event) => sum + (Number(event.bytes) || 0), 0) || null,
    fileChunks: chunks.length,
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
  const mainCpuBefore = mainBefore?.mainProcess?.cpu || {};
  const start = process.hrtime.bigint();
  const result = await run.cdp.evaluate(`(async () => {
    performance.mark(${js(startName)});
    const value = await (async () => { ${action} })();
    await ${rafTwo()};
    performance.mark(${js(paintName)});
    performance.measure(${js(measureName)}, ${js(startName)}, ${js(paintName)});
    const rendererDurationMs = performance.getEntriesByName(${js(measureName)}).at(-1)?.duration ?? null;
    performance.clearMarks(${js(startName)});
    performance.clearMarks(${js(paintName)});
    performance.clearMeasures(${js(measureName)});
    return { value, rendererDurationMs };
  })()`, run.timeoutMs);
  const durationMs = hrElapsed(start);
  const mainAfter = await diagnostics(run);
  const readMetrics = fileReadMetrics(mainAfter, mainEventCount);
  const mainCpuAfter = mainAfter?.mainProcess?.cpu || {};
  const tasks = await run.cdp.evaluate(`(() => {
    const values = window.__nceBenchmarkState?.longTasks || [];
    const result = { count: values.length, totalMs: values.reduce((sum, item) => sum + item, 0), maxMs: values.length ? Math.max(...values) : 0 };
    values.length = 0;
    return result;
  })()`);
  const rendererPerf = await run.cdp.send("Performance.getMetrics");
  const beforePerfByName = Object.fromEntries((performanceBefore.metrics || []).map((metric) => [metric.name, metric.value]));
  const afterPerfByName = Object.fromEntries((rendererPerf.metrics || []).map((metric) => [metric.name, metric.value]));
  const mainCpuUserMs = Number.isFinite(mainCpuAfter.user) && Number.isFinite(mainCpuBefore.user)
    ? (mainCpuAfter.user - mainCpuBefore.user) / 1000 : null;
  const mainCpuSystemMs = Number.isFinite(mainCpuAfter.system) && Number.isFinite(mainCpuBefore.system)
    ? (mainCpuAfter.system - mainCpuBefore.system) / 1000 : null;
  return {
    metrics: {
      durationMs,
      rendererDurationMs: result?.rendererDurationMs,
      ...readMetrics,
      mainCpuUserMs,
      mainCpuSystemMs,
      mainCpuSharePercent: Number.isFinite(mainCpuUserMs) && Number.isFinite(mainCpuSystemMs) && durationMs > 0
        ? ((mainCpuUserMs + mainCpuSystemMs) / durationMs) * 100 : null,
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

async function openNamed(run, fixtures, name, fixtureRoot) {
  await cleanTabs(run);
  const fixturePath = getFilePath(fixtures, name, fixtureRoot);
  return openFixture(run, fixturePath);
}

async function runScenario(name, context, sampleIndex) {
  const { run, fixtures, fixtureRoot } = context;
  const info = context.manifest.files;
  let prepared = null;
  let measured;

  if (name.startsWith("workspace.open.")) {
    const workspaceName = name.slice("workspace.open.".length);
    const workspacePath = getWorkspacePath(fixtures, workspaceName);
    await run.cdp.evaluate("editor.fileExplorer.invalidateWorkspace()", run.timeoutMs).catch(() => {});
    measured = await stableMeasured(run, name, sampleIndex,
      `await editor.fileExplorer.loadProject(${js(workspacePath)})`);
    if (measured.value !== true) throw new Error(`NCE failed to load workspace '${workspaceName}'`);
    const explorer = await run.cdp.evaluate(`({
      root: editor.fileExplorer.rootPath,
      files: editor.fileExplorer.files.length,
      renderedRows: document.querySelectorAll(".file-explorer-entry").length,
      loaded: editor.fileExplorer.isLoaded
    })`);
    const memory = await collectMemory(run);
    measured.metrics.workspaceEntries = fixtures.workspaces.find((item) => item.name === workspaceName)?.entries;
    measured.metrics.explorerRootEntries = explorer?.files;
    measured.metrics.explorerRenderedRows = explorer?.renderedRows;
    measured.metrics.rendererJsHeapMB = memory.rendererJsHeapMB;
    measured.metrics.mainProcessRssMB = memory.mainProcessRssMB;
    await run.cdp.evaluate("editor.fileExplorer.invalidateWorkspace()", run.timeoutMs).catch(() => {});
    return measured;
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
    measured = await stableMeasured(run, name, sampleIndex, `await editor.tabManager.openFileWithPath(${js(fixturePath)}); const active = editor.tabManager.activeFile; if (!active?.isLoaded) throw new Error("Active file did not finish loading"); return { path: active.path, loaded: active.isLoaded, lines: active.totalLines, maxLineLength: active.maxLineLength, tabs: editor.tabManager.tabs.length };`);
    measured.metrics.fileBytes = prepared.bytes;
    measured.metrics.lineCount = prepared.lines;
    measured.metrics.maxLineLength = prepared.maxLineLength;
    measured.metrics.modelLineCount = measured.value?.lines;
    measured.metrics.domNodes = await run.cdp.evaluate("document.querySelectorAll('*').length");
    if (Number(measured.value?.lines) !== prepared.lines) throw new Error(`Loaded line count ${measured.value?.lines} does not match fixture line count ${prepared.lines}`);
    return measured;
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
    const fixtureName = name.endsWith("large") ? "large" : "small";
    const fixturePath = getFilePath(fixtures, fixtureName, fixtureRoot);
    await cleanTabs(run);
    const before = await collectMemory(run, { forceGc: true });
    const openedStart = process.hrtime.bigint();
    const opened = await openFixture(run, fixturePath);
    const during = await collectMemory(run);
    const openMs = hrElapsed(openedStart);
    await run.cdp.evaluate(`editor.tabManager.closeFiles({ skipPrepare: true })`);
    await waitRendererStable(run);
    const after = await collectMemory(run, { forceGc: true });
    measured = {
      metrics: {
        durationMs: openMs,
        memoryBeforeJsHeapMB: before.rendererJsHeapMB,
        memoryDuringJsHeapMB: during.rendererJsHeapMB,
        memoryAfterCloseJsHeapMB: after.rendererJsHeapMB,
        memoryDeltaAfterCloseMB: after.rendererJsHeapMB - before.rendererJsHeapMB,
        mainRssBeforeMB: before.mainProcessRssMB,
        mainRssAfterCloseMB: after.mainProcessRssMB,
        fileBytes: fixtures.files[fixtureName].bytes,
        lineCount: fixtures.files[fixtureName].lines,
        forcedGc: 1,
      },
      value: { openedFileId: opened.id },
    };
    return measured;
  }

  if (name === "memory.repeated-open-close") {
    await cleanTabs(run);
    const fixtureName = fixtures.files["large"] ? "large" : "medium";
    const filePath = getFilePath(fixtures, fixtureName, fixtureRoot);
    const memorySeriesMB = [];
    const cycleCount = context.mode === "full" ? 10 : 5;
    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      await openFixture(run, filePath);
      await run.cdp.evaluate("editor.tabManager.closeFiles({ skipPrepare: true })");
      await waitRendererStable(run);
      const memory = await collectMemory(run, { forceGc: true });
      memorySeriesMB.push(memory.rendererJsHeapMB);
    }
    const first = memorySeriesMB[0];
    const last = memorySeriesMB[memorySeriesMB.length - 1];
    measured = {
      metrics: {
        durationMs: 0,
        cycles: cycleCount,
        memoryFirstCycleMB: first,
        memoryLastCycleMB: last,
        memoryChangeMB: last - first,
        memorySlopeMBPerCycle: (last - first) / Math.max(1, cycleCount - 1),
      },
      value: { memorySeriesMB },
    };
    return measured;
  }

  if (name === "editor.typing" || name === "editor.backspace" || name === "editor.enter" || name === "editor.cursor" || name === "editor.select-all") {
    await openNamed(run, fixtures, "small", fixtureRoot);
    await focusEditor(run);
    const before = await run.cdp.evaluate("editor.tabManager.activeFile.serializeContent().length");
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
    } else {
      const modifier = process.platform === "darwin" ? { key: "Meta", code: "MetaLeft", modifiers: 4 } : { key: "Control", code: "ControlLeft", modifiers: 2 };
      await run.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: modifier.key, code: modifier.code, modifiers: modifier.modifiers });
      await run.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: modifier.modifiers, text: "a", unmodifiedText: "a", windowsVirtualKeyCode: 65 });
      await run.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: modifier.modifiers, windowsVirtualKeyCode: 65 });
      await run.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: modifier.key, code: modifier.code });
    }
    await waitRendererStable(run);
    const after = await run.cdp.evaluate(`({ length: editor.tabManager.activeFile.serializeContent().length, selected: editor.selectController?.containsSelected?.length || 0, offsetX: editor.tabManager.activeFile.offsetX, offsetY: editor.tabManager.activeFile.offsetY })`);
    const durationMs = hrElapsed(start);
    const endMark = markName(name, sampleIndex, "paint");
    const rendererDurationMs = await run.cdp.evaluate(`(() => { performance.mark(${js(endMark)}); performance.measure(${js(markName(name, sampleIndex, "latency"))}, ${js(startMark)}, ${js(endMark)}); const entry = performance.getEntriesByName(${js(markName(name, sampleIndex, "latency"))}).at(-1); performance.clearMarks(${js(startMark)}); performance.clearMarks(${js(endMark)}); performance.clearMeasures(${js(markName(name, sampleIndex, "latency"))}); return entry?.duration ?? null; })()`);
    if (name === "editor.typing" && Number(after?.length) !== Number(before) + 1) throw new Error("Typing did not insert exactly one character");
    if (name === "editor.backspace" && Number(after?.length) !== Number(before)) throw new Error("Backspace did not remove the inserted character");
    if (name === "editor.enter" && Number(after?.length) <= Number(before)) throw new Error("Enter did not insert a line break");
    if (name === "editor.select-all" && Number(after?.selected) < Number(after?.length)) throw new Error("Select All did not select the complete file");
    return {
      metrics: {
        durationMs,
        rendererDurationMs,
        contentLengthBefore: Number(before),
        contentLengthAfter: Number(after?.length),
        selectedCharacters: Number(after?.selected),
        cursorOffsetX: Number(after?.offsetX),
        cursorOffsetY: Number(after?.offsetY),
        longTaskCount: 0,
      },
      value: after,
    };
  }

  if (name === "editor.search" || name === "editor.search-many-results") {
    const fixtureName = name.endsWith("many-results") ? "search-many" : "small";
    await openNamed(run, fixtures, fixtureName, fixtureRoot);
    measured = await stableMeasured(run, name, sampleIndex,
      `editor.searchController.open(); const input = editor.searchController.input; input.value = "benchmark"; input.dispatchEvent(new Event("input", { bubbles: true })); return { results: editor.searchController.results.length, query: input.value };`);
    measured.metrics.searchResults = measured.value?.results;
    measured.metrics.queryLength = measured.value?.query?.length;
    return measured;
  }

  if (name === "scroll.vertical" || name === "scroll.horizontal") {
    const fixtureName = name.endsWith("horizontal") ? "long-line-100k" : "large";
    const fallback = fixtures.files[fixtureName] ? fixtureName : "medium";
    await openNamed(run, fixtures, fallback, fixtureRoot);
    const before = await run.cdp.evaluate("({ x: editor.tabManager.activeFile.offsetX, y: editor.tabManager.activeFile.offsetY })");
    const point = await focusEditor(run);
    const start = process.hrtime.bigint();
    for (let step = 0; step < 4; step += 1) {
      await run.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: point.x, y: point.y,
        deltaX: name.endsWith("horizontal") ? 200 : 0,
        deltaY: name.endsWith("vertical") ? 500 : 0,
      });
    }
    await waitRendererStable(run);
    const after = await run.cdp.evaluate("({ x: editor.tabManager.activeFile.offsetX, y: editor.tabManager.activeFile.offsetY })");
    const moved = name.endsWith("horizontal") ? Number(after?.x) !== Number(before?.x) : Number(after?.y) !== Number(before?.y);
    if (!moved) throw new Error(`${name} did not change the editor scroll offset`);
    return {
      metrics: {
        durationMs: hrElapsed(start),
        scrollDeltaX: Number(after?.x) - Number(before?.x),
        scrollDeltaY: Number(after?.y) - Number(before?.y),
      },
      value: { before, after },
    };
  }

  if (name === "editor.syntax-highlight") {
    await cleanTabs(run);
    const filePath = getFilePath(fixtures, "sample-js", fixtureRoot);
    measured = await stableMeasured(run, name, sampleIndex,
      `await editor.tabManager.openFileWithPath(${js(filePath)}); const active = editor.tabManager.activeFile; return { loaded: active?.isLoaded, language: active?.language, tabs: editor.tabManager.tabs.length };`);
    measured.metrics.syntaxLineCount = fixtures.files["sample-js"].lines;
    measured.metrics.highlightedDomNodes = measured.value?.loaded ? await run.cdp.evaluate("document.querySelectorAll('.editor-output *').length") : 0;
    return measured;
  }

  if (name === "dom.count") {
    await openNamed(run, fixtures, "medium", fixtureRoot);
    const domCount = await run.cdp.evaluate("document.querySelectorAll('*').length");
    const outputNodes = await run.cdp.evaluate("document.querySelectorAll('.editor-output *').length");
    return { metrics: { durationMs: 0, domNodeCount: domCount, editorOutputNodeCount: outputNodes }, value: { domCount, outputNodes } };
  }

  if (name === "idle.renderer") {
    const frameCount = context.mode === "quick" ? 30 : 60;
    const frameTimes = await run.cdp.evaluate(`new Promise(resolve => {
      const values = []; let previous = performance.now();
      const frame = (now) => { values.push(now - previous); previous = now; if (values.length >= ${frameCount}) resolve(values); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    })`, 20000);
    const sorted = frameTimes.slice().sort((a, b) => a - b);
    const pick = (quantile) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
    return {
      metrics: {
        durationMs: frameTimes.reduce((sum, value) => sum + value, 0),
        frames: frameTimes.length,
        frameIntervalMedianMs: pick(0.5),
        frameIntervalP95Ms: pick(0.95),
        frameIntervalMaxMs: sorted.at(-1),
      },
      value: { frameTimesMs: frameTimes },
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
