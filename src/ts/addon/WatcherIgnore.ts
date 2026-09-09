const path = require("node:path");

export const WATCHER_IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  "release",
  ".git",
  ".svn",
  ".hg",
]);

export function isWatcherPathIgnored(filePath: string): boolean {
  if (typeof filePath !== "string" || !filePath) return false;
  const parts = path.normalize(filePath).split(/[\\/]+/);
  return parts.some((part: string) => WATCHER_IGNORED_DIRECTORIES.has(part)) ||
    parts.some((part: string) => /^\..+\.nce-\d+-[a-f0-9]+\.tmp$/i.test(part)) ||
    parts.some((part: string) => /\.asar$/i.test(part));
}

export const watcherIgnored = (filePath: string): boolean =>
  isWatcherPathIgnored(filePath);
