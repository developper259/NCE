const chokidar = require("chokidar");
const { watcherIgnored } = require("./WatcherIgnore");
const projectPath = process.argv[2];
const foreground = process.argv[3] !== "background";
const interval = foreground ? 400 : 2000;
const binaryInterval = foreground ? 1000 : 5000;

if (!projectPath) process.exit(1);

const watcher = chokidar.watch(projectPath, {
  ignored: watcherIgnored,
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval,
  binaryInterval,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
});

watcher.on("all", (event: string, filePath: string, stats: any) => {
  const signature = stats
    ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`
    : null;
  process.send?.({ type: "all", event, filePath, signature });
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
watcher.on("ready", () => process.send?.({
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

process.on("message", (message: any) => {
  if (message?.type === "close") void close();
});
process.on("disconnect", () => void close());
process.on("SIGTERM", () => void close());
