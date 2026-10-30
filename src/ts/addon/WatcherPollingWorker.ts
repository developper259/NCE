const chokidar = require("chokidar");
const { watcherIgnored } = require("./WatcherIgnore");
const {
  FOREGROUND_INTERVALS,
  BACKGROUND_INTERVALS,
  WRITE_SETTLE_MS,
} = require("./WatcherPollingConfig");
const { onParentMessage, sendToParent } = require("./WorkerParentPort");
const projectPath = process.argv[2];
const foreground = process.argv[3] !== "background";
const { interval, binaryInterval } = foreground ? FOREGROUND_INTERVALS : BACKGROUND_INTERVALS;

if (!projectPath) process.exit(1);

const watcher = chokidar.watch(projectPath, {
  ignored: watcherIgnored,
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval,
  binaryInterval,
  awaitWriteFinish: {
    stabilityThreshold: WRITE_SETTLE_MS,
    pollInterval: 100,
  },
});

watcher.on("all", (event: string, filePath: string, stats: any) => {
  const signature = stats
    ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`
    : null;
  sendToParent({ type: "all", event, filePath, signature });
});

watcher.on("error", (error: any) => {
  sendToParent({
    type: "error",
    error: {
      message: String(error?.message || error),
      code: error?.code,
      path: error?.path,
    },
  });
});
watcher.on("ready", () => sendToParent({
  type: "ready",
  foreground,
  interval,
  binaryInterval,
}));

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await watcher.close();
  process.exit(0);
};

onParentMessage((message: any) => {
  if (message?.type === "close") void close();
});
process.on("disconnect", () => void close());
process.on("SIGTERM", () => void close());
