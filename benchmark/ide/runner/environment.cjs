const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "../../..");

function gitValue(args) {
  const candidates = process.platform === "win32"
    ? ["git", "C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Sublime Merge\\Git\\cmd\\git.exe"]
    : ["git"];
  for (const binary of candidates) {
    try {
      return execFileSync(binary, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    } catch {}
  }
  return null;
}

function collectEnvironment({ machine, mode, configHash }) {
  let electronVersion = null;
  try { electronVersion = require("electron/package.json").version; } catch {}
  let appVersion = null;
  try { appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version; } catch {}
  const branch = gitValue(["branch", "--show-current"]);
  const commit = gitValue(["rev-parse", "HEAD"]);
  const dirty = gitValue(["status", "--porcelain"]);
  return {
    machine: machine || null,
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    architecture: process.arch,
    cpuModel: os.cpus()[0]?.model || null,
    logicalCpuCores: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    totalMemoryMB: os.totalmem() / 1024 / 1024,
    nodeVersion: process.version,
    electronVersion,
    nceVersion: appVersion,
    gitBranch: branch || null,
    gitCommit: commit || null,
    gitDirty: Boolean(dirty),
    benchmarkMode: mode,
    configHash,
    fixtureVersion: "1.0.0",
  };
}

module.exports = { collectEnvironment, gitValue };
