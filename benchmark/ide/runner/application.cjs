const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CdpClient } = require("./cdp.cjs");
const { ensureDirectory } = require("../utils/files.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const PROFILE_ROOT = path.join(ROOT, ".benchmark-data", "ide", "profiles");

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error(`DevTools returned HTTP ${response.status}`);
  return response.json();
}

class ElectronRun {
  constructor(child, profilePath, port, timeoutMs, startedAt) {
    this.child = child;
    this.profilePath = profilePath;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.startedAt = startedAt;
    this.cdp = null;
    this.output = "";
    this.exitCode = null;
    this.exitSignal = null;
    this.exited = false;
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        this.exited = true;
        resolve({ code, signal });
      });
    });
    const capture = (chunk) => {
      this.output = `${this.output}${chunk.toString("utf8")}`.slice(-120000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
  }

  elapsedMs() { return Number(process.hrtime.bigint() - this.startedAt) / 1e6; }

  async connect() {
    const deadline = Date.now() + this.timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error(`NCE exited before DevTools was ready (code ${this.exitCode}, signal ${this.exitSignal})\n${this.output}`);
      try {
        const targets = await getJson(`http://127.0.0.1:${this.port}/json/list`);
        const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl && item.url.startsWith("file:"));
        if (target) {
          this.cdp = await CdpClient.connect(target.webSocketDebuggerUrl, 5000);
          await this.cdp.initialize();
          return target;
        }
      } catch (error) { lastError = error; }
      await wait(50);
    }
    throw new Error(`Timed out waiting for NCE's Electron window${lastError ? `: ${lastError.message}` : ""}\n${this.output}`);
  }

  async waitFor(expression, description, timeoutMs = this.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error(`NCE exited while waiting for ${description} (code ${this.exitCode}, signal ${this.exitSignal})\n${this.output}`);
      try {
        lastValue = await this.cdp.evaluate(expression, Math.min(5000, timeoutMs));
        if (lastValue) return lastValue;
      } catch (error) {
        if (/connection closed|not open/i.test(error.message)) throw error;
      }
      await wait(25);
    }
    throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`);
  }

  async stabilize() {
    await this.cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))", 10000);
  }

  async diagnostics() {
    return this.cdp.evaluate("window.api.getBenchmarkDiagnostics()", 5000);
  }

  async close() {
    if (this.exitCode === null) {
      try {
        if (this.cdp) await this.cdp.evaluate("window.api.quit()", 5000);
      } catch {}
      const result = await Promise.race([
        this.exitPromise,
        wait(10000).then(() => null),
      ]);
      if (!result && this.exitCode === null) {
        this.child.kill("SIGTERM");
        const afterTerm = await Promise.race([this.exitPromise, wait(3000).then(() => null)]);
        if (!afterTerm && this.exitCode === null) this.child.kill("SIGKILL");
      }
    }
    this.cdp?.close();
    await Promise.race([this.exitPromise, wait(2000)]);
    if (fs.existsSync(this.profilePath)) fs.rmSync(this.profilePath, { recursive: true, force: true });
    return { exitCode: this.exitCode, exitSignal: this.exitSignal, output: this.output };
  }
}

async function launchNce({ timeoutMs = 30000, profileLabel = "run" } = {}) {
  ensureDirectory(PROFILE_ROOT);
  const profilePath = fs.mkdtempSync(path.join(PROFILE_ROOT, `${profileLabel}-${process.pid}-`));
  const userDataPath = path.join(profilePath, "user-data");
  const sessionDataPath = path.join(profilePath, "session-data");
  const chromiumPath = path.join(profilePath, "chromium");
  for (const directory of [userDataPath, sessionDataPath, chromiumPath]) ensureDirectory(directory);
  const port = await getFreePort();
  const electronExecutable = require("electron");
  const mainPath = path.join(ROOT, "dist", "main.js");
  if (!fs.existsSync(mainPath)) throw new Error("dist/main.js is missing. Run npm run build:main first.");
  const startedAt = process.hrtime.bigint();
  const electronEnv = { ...process.env };
  // Codex and some Electron tooling set this globally so Electron runs as Node.
  // The benchmark needs an actual GUI process, so remove it only for this child.
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExecutable, [
    mainPath,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${chromiumPath}`,
  ], {
    cwd: ROOT,
    env: {
      ...electronEnv,
      NCE_BENCHMARK: "1",
      NCE_BENCHMARK_USER_DATA: userDataPath,
      NCE_BENCHMARK_SESSION_DATA: sessionDataPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  return new ElectronRun(child, profilePath, port, timeoutMs, startedAt);
}

async function recoverInteractiveApp(run) {
  if (!run || run.exited || !run.cdp || run.cdp.closed) return false;
  try {
    const state = await run.cdp.evaluate(`(async () => {
      try { await editor.fileExplorer?.invalidateWorkspace?.(); } catch {}
      try { await window.api.stopWatching(); } catch {}
      try { await editor.tabManager?.closeFiles?.({ skipPrepare: true }); } catch {}
      try { editor.searchController?.close?.(); } catch {}
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        editorReady: !!window.editor && editor.isOnInit === false,
        tabs: editor.tabManager?.tabs?.length ?? -1,
        workspaceRoot: editor.fileExplorer?.rootPath || "",
        workspaceLoaded: editor.fileExplorer?.isLoaded === true
      };
    })()`, 5000);
    return state?.editorReady === true && state.tabs === 0 &&
      state.workspaceRoot === "" && state.workspaceLoaded === false;
  } catch {
    return false;
  }
}

module.exports = { launchNce, recoverInteractiveApp };
