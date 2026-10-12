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
  const selections = [];
  for (let index = 0; index < cursorCount; index++) {
    const row = cursorCount === 1
      ? Math.max(1, Math.floor(lineCount / 2))
      : 1 + Math.floor(index * (lineCount - 1) / (cursorCount - 1));
    const line = file.lines[row - 1].getText();
    const column = Math.floor(line.length / 2);
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
  const scenarios = [
    [100, 2], [100, 10],
    [10_000, 2], [10_000, 10], [10_000, 50], [10_000, 100], [10_000, 500], [10_000, 1_000],
    [100_000, 2], [100_000, 50], [100_000, 500], [100_000, 1_000],
  ];
  const samples = Number(process.env.NCE_BENCH_SAMPLES) || 5;
  const warmups = Number(process.env.NCE_BENCH_WARMUPS) || 1;
  const results = [];

  for (const [lineCount, cursorCount] of scenarios) {
    const timings = [];
    let heapDelta = 0;
    for (let iteration = 0; iteration < warmups + samples; iteration++) {
      if (global.gc) global.gc();
      const { editor } = makeFixture(lineCount, cursorCount);
      const heapBefore = process.memoryUsage().heapUsed;
      const start = process.hrtime.bigint();
      editor.writerController.write("x");
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      const used = process.memoryUsage().heapUsed;
      if (iteration >= warmups) {
        timings.push(elapsedMs);
        heapDelta += used - heapBefore;
      }
    }
    results.push({
      lines: lineCount,
      cursors: cursorCount,
      samples,
      medianMs: Number(percentile(timings, 0.5).toFixed(3)),
      p95Ms: Number(percentile(timings, 0.95).toFixed(3)),
      meanHeapDeltaBytes: Math.round(heapDelta / samples),
    });
  }

  process.stdout.write(`${JSON.stringify({
    benchmark: "NCE multi-cursor insertion transaction",
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: os.cpus().length,
    samples,
    warmups,
    forcedGc: typeof global.gc === "function",
    results,
  }, null, 2)}\n`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
