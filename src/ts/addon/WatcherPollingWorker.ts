const chokidar = require("chokidar");

const ASAR_IGNORED = /(?:^|[\\/])[^\\/]+\.asar(?:$|[\\/])/i;
const projectPath = process.argv[2];

if (!projectPath) process.exit(1);

const watcher = chokidar.watch(projectPath, {
  ignored: [ASAR_IGNORED],
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: 400,
  binaryInterval: 1000,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
});

watcher.on("all", (event: string, filePath: string) => {
  process.send?.({ type: "all", event, filePath });
});

watcher.on("error", (error: any) => {
  process.send?.({
    type: "error",
    error: {
      message: String(error?.message || error),
      code: error?.code,
      path: error?.path,
    },
  });
});
watcher.on("ready", () => process.send?.({ type: "ready" }));

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await watcher.close();
  process.exit(0);
};

process.on("message", (message: any) => {
  if (message?.type === "close") void close();
});
process.on("disconnect", () => void close());
process.on("SIGTERM", () => void close());
