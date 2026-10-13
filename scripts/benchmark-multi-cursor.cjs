const os = require("node:os");
const { createEditor, loadGlobal } = require("../tests/helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const MultiCursorController = loadGlobal(
  "src/js/controller/MultiCursorController.js",
  "MultiCursorController",
  { Events: {} },
);
const WriterController = loadGlobal(
  "src/js/controller/WriterController.js",
  "WriterController",
  { LineNode, Events: { ON_CHANGE: "change" } },
);
const HistoryController = loadGlobal(
  "src/js/controller/HistoryController.js",
  "HistoryController",
  { Events: {} },
);

function makeFixture(lineCount, cursorCount) {
  const source = Array.from({ length: lineCount }, (_, index) =>
    `const value${String(index).padStart(6, "0")} = ${index};`,
  ).join("\n");
  const { editor, file } = createEditor(source);
  file.largeFileMode = false;
  file.loadingState = { status: "loaded" };
  file.eol = "\n";
  file.lineEndings = Array(lineCount - 1).fill("\n");
  editor.multiCursorController = new MultiCursorController(editor);
  editor.writerController = new WriterController(editor);
  editor.historyController = new HistoryController(editor);
  editor.lineController.syncLineLengthsForBatch = () => {};
  editor.lineController.refresh = () => {};
  editor.lineController.markDirtyFrom = () => {};
  editor.cursorController.getViewPosition = (row, column) => ({ row, column });
  const selections = [];
  for (let index = 0; index < cursorCount; index++) {
    const row = cursorCount === 1
      ? Math.max(1, Math.floor(lineCount / 2))
      : 1 + Math.floor(index / 20);
    const line = file.lines[row - 1].getText();
    const column = cursorCount === 1
      ? Math.floor(line.length / 2)
      : index % 20;
    selections.push({
      id: index + 1,
      anchor: { row, column },
      active: { row, column },
      preferredVisualColumn: column,
    });
  }
  editor.multiCursorController.setSelections(selections, {
    primaryId: 1,
    render: false,
  });
  return { editor, file };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function run() {
  const lineCounts = [100, 10_000, 100_000];
  const cursorCounts = [1, 2, 10, 50, 100, 500, 1000];
  const scenarios = lineCounts.flatMap((lineCount) =>
    cursorCounts.map((cursorCount) => [lineCount, cursorCount]),
  );
  const samples = Number(process.env.NCE_BENCH_SAMPLES) || 5;
  const warmups = Number(process.env.NCE_BENCH_WARMUPS) || 1;
  const results = [];

  const measure = (times, heaps, iteration, start, heapBefore) => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const heapAfter = process.memoryUsage().heapUsed;
    if (iteration >= warmups) {
      times.push(elapsedMs);
      heaps.push(heapAfter - heapBefore);
    }
  };

  for (const [lineCount, cursorCount] of scenarios) {
    const timings = [];
    const heapDeltas = [];
    for (let iteration = 0; iteration < warmups + samples; iteration++) {
      if (global.gc) global.gc();
      const { editor } = makeFixture(lineCount, cursorCount);
      const heapBefore = process.memoryUsage().heapUsed;
      const start = process.hrtime.bigint();
      editor.writerController.write("x");
      measure(timings, heapDeltas, iteration, start, heapBefore);
    }
    results.push({
      lines: lineCount,
      cursors: cursorCount,
      samples,
      medianMs: Number(percentile(timings, 0.5).toFixed(3)),
      p95Ms: Number(percentile(timings, 0.95).toFixed(3)),
      meanHeapDeltaBytes: Math.round(heapDeltas.reduce((sum, value) => sum + value, 0) / samples),
    });
  }

  const verticalResults = [];
  for (const cursorCount of [1, 10, 100, 500, 1000]) {
    const timings = [];
    const heapDeltas = [];
    for (let iteration = 0; iteration < warmups + samples; iteration++) {
      if (global.gc) global.gc();
      const { editor } = makeFixture(2_000, cursorCount);
      const heapBefore = process.memoryUsage().heapUsed;
      const start = process.hrtime.bigint();
      editor.multiCursorController.addCursorsVertically(1);
      measure(timings, heapDeltas, iteration, start, heapBefore);
    }
    verticalResults.push({
      cursorsBefore: cursorCount,
      samples,
      medianMs: Number(percentile(timings, 0.5).toFixed(3)),
      p95Ms: Number(percentile(timings, 0.95).toFixed(3)),
      meanHeapDeltaBytes: Math.round(heapDeltas.reduce((sum, value) => sum + value, 0) / samples),
    });
  }

  const occurrenceResults = [];
  for (const cursorCount of [1, 10, 100, 500, 1000]) {
    const timings = [];
    const heapDeltas = [];
    for (let iteration = 0; iteration < warmups + samples; iteration++) {
      if (global.gc) global.gc();
      const { editor, file } = makeFixture(10_000, cursorCount);
      const selections = Array.from({ length: cursorCount }, (_, index) => ({
        id: index + 1,
        anchor: { row: index + 1, column: 6 },
        active: { row: index + 1, column: 11 },
      }));
      editor.multiCursorController.setSelections(selections, {
        primaryId: 1,
        file,
        render: false,
      });
      const heapBefore = process.memoryUsage().heapUsed;
      const start = process.hrtime.bigint();
      editor.multiCursorController.findOccurrences("value", { excludeSelections: true });
      measure(timings, heapDeltas, iteration, start, heapBefore);
    }
    occurrenceResults.push({
      excludedSelections: cursorCount,
      lines: 10_000,
      samples,
      medianMs: Number(percentile(timings, 0.5).toFixed(3)),
      p95Ms: Number(percentile(timings, 0.95).toFixed(3)),
      meanHeapDeltaBytes: Math.round(heapDeltas.reduce((sum, value) => sum + value, 0) / samples),
    });
  }

  process.stdout.write(`${JSON.stringify({
    benchmark: "NCE multi-cursor transaction-core microbenchmarks (fixture omits DOM rendering and line metrics)",
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: os.cpus().length,
    samples,
    warmups,
    forcedGc: typeof global.gc === "function",
    results,
    verticalCursorAddition: verticalResults,
    occurrenceExclusion: occurrenceResults,
  }, null, 2)}\n`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
