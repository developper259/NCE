const path = require("node:path");

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.floor((sorted.length - 1) * quantile);
  return sorted[index];
}

async function installProbe(run) {
  await run.cdp.evaluate(`(() => {
    if (window.__nceHighlightScrollProbe?.installed) return true;
    const probe = window.__nceHighlightScrollProbe = {
      installed: true,
      active: false,
      counters: {},
      previousRows: new Set(),
      previousSpans: new Set(),
      previousScrollPosition: null,
      frameHandle: null,
      reset() {
        this.counters = {
          renderPassCount: 0,
          rowsRebound: 0,
          scrollEventCount: 0,
          highlightRowsRebuilt: 0,
          highlightRowsRendered: 0,
          tokenCacheHits: 0,
          tokenCacheMisses: 0,
          highlightRequests: 0,
          documentLineQueries: 0,
          tokenSetCalls: 0,
          tokenProjectionCalls: 0,
          tokenProjectionTotalMs: 0,
          tokenProjectionMaxMs: 0,
          highlightRenderDurationMs: 0,
          domCommitDurationMs: 0,
          spansCreated: 0,
          spansReused: 0,
          spansRemoved: 0,
          replaceChildrenCalls: 0,
          appendChildCalls: 0,
          rowsEntered: 0,
          rowsLeaving: 0,
          rowsUnchanged: 0,
          visibleRowsTotal: 0,
          visibleRowsFrames: 0,
          visibleRowsPerFrame: [],
          syncGeometryReads: 0,
        };
      },
      currentRows() {
        return new Set(Array.from(document.querySelectorAll('.editor-output > [data-display-line]'), node => String(node.dataset.displayLine)));
      },
      currentSpans() {
        return new Set(document.querySelectorAll('.editor-output span'));
      },
      tick() {
        if (!this.active) return;
        const rows = this.currentRows();
        for (const row of rows) {
          if (this.previousRows.has(row)) this.counters.rowsUnchanged += 1;
          else this.counters.rowsEntered += 1;
        }
        for (const row of this.previousRows) {
          if (!rows.has(row)) this.counters.rowsLeaving += 1;
        }
        this.counters.visibleRowsTotal += rows.size;
        this.counters.visibleRowsFrames += 1;
        this.counters.visibleRowsPerFrame.push(rows.size);
        const lineController = editor.lineController;
        const scrollPosition = String(lineController.startIndex) + ":" + String(lineController.offsetY);
        const spans = this.currentSpans();
        if (scrollPosition !== this.previousScrollPosition) {
          for (const span of spans) {
            if (this.previousSpans.has(span)) this.counters.spansReused += 1;
          }
        }
        this.previousScrollPosition = scrollPosition;
        this.previousRows = rows;
        this.previousSpans = spans;
        this.frameHandle = requestAnimationFrame(() => this.tick());
      },
      begin() {
        this.reset();
        this.previousRows = this.currentRows();
        this.previousSpans = this.currentSpans();
        const lineController = editor.lineController;
        this.previousScrollPosition = String(lineController.startIndex) + ":" + String(lineController.offsetY);
        this.active = true;
        this.frameHandle = requestAnimationFrame(() => this.tick());
      },
      end() {
        this.active = false;
        return {
          ...this.counters,
          visibleRowsAverage: this.counters.visibleRowsFrames
            ? this.counters.visibleRowsTotal / this.counters.visibleRowsFrames
            : 0,
        };
      },
    };
    probe.reset();
    const lineController = editor.lineController;
    const verticalScroller = lineController.outputScroller?.vScroller;
    if (verticalScroller && typeof verticalScroller.onScroll === 'function') {
      const originalOnScroll = verticalScroller.onScroll;
      verticalScroller.onScroll = function(...args) {
        if (probe.active) probe.counters.scrollEventCount += 1;
        return originalOnScroll.apply(this, args);
      };
    }
    const originalCreateLineOBJ = lineController.createLineOBJ;
    lineController.createLineOBJ = function(...args) {
      const startedAt = performance.now();
      const displayIndex = this.startIndex + args[1];
      const displayRow = this.getDisplayRow(displayIndex);
      const lineNode = Number.isInteger(displayRow?.documentIndex)
        ? this.lines[displayRow.documentIndex]
        : null;
      const highlighted = editor.tabManager.activeFile?.language !== 'plaintext';
      if (probe.active) {
        probe.counters.rowsRebound += 1;
        if (highlighted) {
          probe.counters.highlightRowsRendered += 1;
          probe.counters.highlightRowsRebuilt += 1;
          if (lineNode?.getTokens?.() != null) probe.counters.tokenCacheHits += 1;
          else probe.counters.tokenCacheMisses += 1;
        }
      }
      const result = originalCreateLineOBJ.apply(this, args);
      if (probe.active && highlighted)
        probe.counters.highlightRenderDurationMs += performance.now() - startedAt;
      return result;
    };
    const originalVisibleTokens = lineController.getVisibleTokens;
    lineController.getVisibleTokens = function(...args) {
      const startedAt = performance.now();
      const result = originalVisibleTokens.apply(this, args);
      if (probe.active) {
        const elapsed = performance.now() - startedAt;
        probe.counters.tokenProjectionCalls += 1;
        probe.counters.tokenProjectionTotalMs += elapsed;
        probe.counters.tokenProjectionMaxMs = Math.max(probe.counters.tokenProjectionMaxMs, elapsed);
      }
      return result;
    };
    const originalRefresh = lineController.refresh;
    lineController.refresh = function(...args) {
      if (probe.active) probe.counters.renderPassCount += 1;
      return originalRefresh.apply(this, args);
    };
    const originalSetTokens = editor.tabManager.activeFile.lines[0].setTokens;
    editor.tabManager.activeFile.lines[0].constructor.prototype.setTokens = function(...args) {
      if (probe.active) probe.counters.tokenSetCalls += 1;
      return originalSetTokens.apply(this, args);
    };
    const originalRequest = editor.highlightController.nshClient.request.bind(editor.highlightController.nshClient);
    editor.highlightController.nshClient.request = async function(type, ...args) {
      if (probe.active) {
        if (type === 'highlightLine') probe.counters.highlightRequests += 1;
        if (type === 'getDocumentLines') probe.counters.documentLineQueries += 1;
      }
      return originalRequest(type, ...args);
    };
    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName, ...args) {
      if (probe.active && String(tagName).toLowerCase() === 'span') probe.counters.spansCreated += 1;
      return originalCreateElement.call(this, tagName, ...args);
    };
    const originalReplaceChildren = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function(...args) {
      const tracked = this.matches('.editor-output') || this.parentElement?.matches('.editor-output');
      const startedAt = performance.now();
      const removedSpans = tracked ? this.querySelectorAll('span').length : 0;
      if (probe.active && tracked) {
        probe.counters.replaceChildrenCalls += 1;
      }
      const result = originalReplaceChildren.apply(this, args);
      if (probe.active && tracked) {
        probe.counters.spansRemoved += removedSpans;
        probe.counters.domCommitDurationMs += performance.now() - startedAt;
      }
      return result;
    };
    const originalReplaceWith = Element.prototype.replaceWith;
    Element.prototype.replaceWith = function(...args) {
      const tracked = this.parentElement?.matches('.editor-output');
      const startedAt = performance.now();
      const removedSpans = tracked ? this.querySelectorAll('span').length : 0;
      const result = originalReplaceWith.apply(this, args);
      if (probe.active && tracked) {
        probe.counters.spansRemoved += removedSpans;
        probe.counters.domCommitDurationMs += performance.now() - startedAt;
      }
      return result;
    };
    const originalAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function(node) {
      const tracked = this === lineController.editor.output || this.parentElement?.matches('.editor-output');
      const result = originalAppendChild.call(this, node);
      if (probe.active && tracked) probe.counters.appendChildCalls += 1;
      return result;
    };
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function(...args) {
      if (probe.active) probe.counters.syncGeometryReads += 1;
      return originalGetBoundingClientRect.apply(this, args);
    };
    probe.reset();
    probe.counters.syncGeometryReads = 0;
    return true;
  })()`);
}

async function prepareFile(run, fixturePath, expected, callbacks, { plain = false } = {}) {
  const { openFixture, cleanTabs, waitRendererStable } = callbacks;
  await cleanTabs(run);
  await openFixture(run, fixturePath, { expected });
  const prewarm = await run.cdp.evaluate(`(async () => {
    const file = editor.tabManager.activeFile;
    const highlighter = editor.highlightController;
    if (!file || file.language !== 'javascript') throw new Error('Highlight fixture was not detected as JavaScript');
    await highlighter.openFile(file);
    await highlighter.documentQueues.get(file.id)?.catch(() => {});
    if (highlighter.documentModes.get(file.id) !== 'incremental') {
      throw new Error('Highlight fixture did not select incremental document highlighting');
    }
    const batchSize = 200;
    for (let start = 0; start < file.lines.length; start += batchSize) {
      await highlighter.loadDocumentLines(file, start, Math.min(file.lines.length, start + batchSize));
    }
    await Promise.all([
      highlighter.documentQueues.get(file.id)?.catch(() => {}),
      highlighter.rangeRequests.get(file.id)?.promise?.catch(() => {}),
    ]);
    const expectedLines = ${expected.lines};
    const cachedLines = file.lines.reduce((count, line) => count + (line.getTokens() != null ? 1 : 0), 0);
    if (cachedLines !== expectedLines) throw new Error('Token cache coverage mismatch: ' + cachedLines + '/' + expectedLines);
    if (${plain}) {
      file.language = 'plaintext';
      for (const line of file.lines) line.clearTokens();
    }
    editor.lineController.outputScroller.resetScroll();
    editor.lineController.refresh(true);
    await highlighter.refresh();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      language: file.language,
      lines: file.lines.length,
      cachedLines,
      warmCacheCoverage: cachedLines / expectedLines,
      documentMode: highlighter.documentModes.get(file.id),
      viewportRows: editor.lineController.renderedLineCount,
      startIndex: editor.lineController.startIndex,
      bytes: file.loadingState?.loadedBytes ?? null,
    };
  })()`, run.scenarioTimeoutMs || run.timeoutMs);
  if (prewarm?.cachedLines !== expected.lines || prewarm?.warmCacheCoverage !== 1) {
    throw new Error(`Warm cache assertion failed: ${JSON.stringify(prewarm)}`);
  }
  await waitRendererStable(run);
  return prewarm;
}

async function runHighlightScrollScenario({ name, context, sampleIndex, callbacks }) {
  const { run, fixtures, fixtureRoot } = context;
  const fixture = fixtures.files["highlight-scroll"];
  const fixturePath = path.join(fixtureRoot, fixture.path);
  const plain = name === "highlight.scroll-plain-control";
  const prepared = await prepareFile(run, fixturePath, fixture, callbacks, { plain });
  await callbacks.installProbe(run);
  const point = await callbacks.focusEditor(run);
  await callbacks.waitRendererStable(run);

  const initialScroll = await run.cdp.evaluate("({ startIndex: editor.lineController.startIndex, offsetY: editor.lineController.offsetY })");
  await callbacks.startFrameWindow(run);
  await run.cdp.evaluate("window.__nceHighlightScrollProbe.begin()");
  const startedAt = process.hrtime.bigint();
  const eventCount = 75;
  const cadenceMs = 20;
  const pendingInputEvents = [];
  for (let index = 0; index < eventCount; index += 1) {
    pendingInputEvents.push(run.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: 20,
    }));
    if (index + 1 < eventCount) await new Promise((resolve) => setTimeout(resolve, cadenceMs));
  }
  await Promise.all(pendingInputEvents);
  await callbacks.waitRendererStable(run);
  const finalScroll = await run.cdp.evaluate("({ startIndex: editor.lineController.startIndex, offsetY: editor.lineController.offsetY })");
  if (initialScroll.startIndex === finalScroll.startIndex && initialScroll.offsetY === finalScroll.offsetY) throw new Error("The dedicated scroll pattern did not move the viewport");
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const counters = await run.cdp.evaluate("window.__nceHighlightScrollProbe.end()");
  const observed = await callbacks.stopFrameWindow(run);
  const frameStats = callbacks.summarizeFrameIntervals(
    callbacks.frameIntervalsFromTimestamps(observed.frameTimestamps).frameIntervalsMs,
    callbacks.frameIntervalsFromTimestamps(observed.frameTimestamps),
  );
  const intervals = callbacks.frameIntervalsFromTimestamps(observed.frameTimestamps).frameIntervalsMs;
  const tasks = observed.longTasks || [];
  const warmCacheCoverage = plain ? null : prepared.warmCacheCoverage;
  const tokenCacheMisses = plain ? 0 : counters.tokenCacheMisses + counters.highlightRequests;
  if (!plain && warmCacheCoverage !== 1) throw new Error(`Warm cache coverage was ${warmCacheCoverage}`);
  if (!plain && tokenCacheMisses !== 0) throw new Error(`Warm cache miss during scroll: ${tokenCacheMisses}`);

  return {
    metrics: {
      durationMs: elapsedMs,
      scrollDurationMs: elapsedMs,
      frameIntervalP50Ms: frameStats.frameIntervalP50Ms,
      frameIntervalP95Ms: frameStats.frameIntervalP95Ms,
      frameIntervalP99Ms: percentile(intervals, 0.99),
      frameIntervalMaxMs: frameStats.frameIntervalMaxMs,
      framesOver16_7Ms: frameStats.framesOver16_7Ms,
      framesOver33_3Ms: frameStats.framesOver33_3Ms,
      framesOver50Ms: frameStats.framesOver50Ms,
      framesOver100Ms: intervals.filter((value) => value > 100).length,
      longTaskCount: tasks.length,
      longTaskTotalMs: tasks.reduce((sum, value) => sum + value, 0),
      longTaskMaxMs: tasks.length ? Math.max(...tasks) : 0,
      warmCacheCoverage: warmCacheCoverage ?? 0,
      tokenCacheHits: counters.tokenCacheHits,
      tokenCacheMisses,
      tokenizerCallsDuringMeasuredScroll: counters.highlightRequests,
      highlightRequests: counters.highlightRequests,
      documentLineQueries: counters.documentLineQueries,
      tokenSetCalls: counters.tokenSetCalls,
      visibleRowsAverage: counters.visibleRowsAverage,
      rowsEntered: counters.rowsEntered,
      rowsLeaving: counters.rowsLeaving,
      rowsUnchanged: counters.rowsUnchanged,
      rowsRebound: counters.rowsRebound,
      scrollEventCount: counters.scrollEventCount,
      visibleRowsPerFrame: counters.visibleRowsPerFrame,
      highlightRowsRendered: counters.highlightRowsRendered,
      highlightRowsRebuilt: counters.highlightRowsRebuilt,
      highlightRowsSkipped: counters.rowsUnchanged,
      tokenProjectionCalls: counters.tokenProjectionCalls,
      tokenProjectionTotalMs: counters.tokenProjectionTotalMs,
      tokenProjectionMaxMs: counters.tokenProjectionMaxMs,
      highlightRenderDurationMs: counters.highlightRenderDurationMs,
      domCommitDurationMs: counters.domCommitDurationMs,
      spansCreated: counters.spansCreated,
      spansReused: counters.spansReused,
      spansRemoved: counters.spansRemoved,
      replaceChildrenCalls: counters.replaceChildrenCalls,
      appendChildCalls: counters.appendChildCalls,
      syncGeometryReads: counters.syncGeometryReads,
      renderPassCount: counters.renderPassCount,
      framesObserved: intervals.length,
      wheelEvents: eventCount,
      fixtureLines: fixture.lines,
      fixtureBytes: fixture.bytes,
    },
    value: {
      scenario: name,
      warmCacheCoverage,
      prepared,
      initialScroll,
      finalScroll,
      counters,
      frameIntervalsMs: intervals,
      longTasks: tasks,
    },
  };
}

module.exports = { runHighlightScrollScenario, installProbe };
