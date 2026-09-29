const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CdpClient } = require("./cdp.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const PROFILE_ROOT = path.join(ROOT, ".benchmark-data", "ide", "profiles");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function devtoolsTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error(`DevTools returned HTTP ${response.status}`);
  return response.json();
}

class ElectronRun {
  constructor(child, profilePath, port, timeoutMs) {
    this.child = child;
    this.profilePath = profilePath;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.cdp = null;
    this.output = "";
    this.exitCode = null;
    this.exitSignal = null;
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        resolve({ code, signal });
      });
    });
    const capture = (chunk) => { this.output = `${this.output}${chunk.toString("utf8")}`.slice(-60000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
  }

  async connect() {
    const deadline = Date.now() + this.timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      if (this.exitCode !== null)
        throw new Error(`NCE exited before DevTools was ready (${this.exitCode}/${this.exitSignal})\n${this.output}`);
      try {
        const targets = await devtoolsTargets(this.port);
        const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl && item.url.startsWith("file:"));
        if (target) {
          this.cdp = await CdpClient.connect(target.webSocketDebuggerUrl, 5000);
          await this.cdp.initialize();
          return target;
        }
      } catch (error) { lastError = error; }
      await delay(50);
    }
    throw new Error(`Timed out waiting for NCE's Electron window${lastError ? `: ${lastError.message}` : ""}\n${this.output}`);
  }

  async waitFor(expression, description, timeoutMs = this.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
      if (this.exitCode !== null)
        throw new Error(`NCE exited while waiting for ${description} (${this.exitCode}/${this.exitSignal})\n${this.output}`);
      try {
        lastValue = await this.cdp.evaluate(expression, Math.min(5000, timeoutMs));
        if (lastValue) return lastValue;
      } catch (error) {
        if (/connection closed|not open/i.test(error.message)) throw error;
      }
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${description}; last value=${JSON.stringify(lastValue)}`);
  }

  async close() {
    if (this.exitCode === null) {
      try { await this.cdp?.evaluate("window.api.quit()", 5000); } catch {}
      const result = await Promise.race([this.exitPromise, delay(10000).then(() => null)]);
      if (!result && this.exitCode === null) {
        this.child.kill("SIGTERM");
        const afterTerm = await Promise.race([this.exitPromise, delay(3000).then(() => null)]);
        if (!afterTerm && this.exitCode === null) this.child.kill("SIGKILL");
      }
    }
    this.cdp?.close();
    await Promise.race([this.exitPromise, delay(2000)]);
    if (fs.existsSync(this.profilePath)) fs.rmSync(this.profilePath, { recursive: true, force: true });
    return { exitCode: this.exitCode, exitSignal: this.exitSignal, output: this.output };
  }
}

async function launchElectron({ timeoutMs = 30000 } = {}) {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const profilePath = fs.mkdtempSync(path.join(PROFILE_ROOT, `highlight-scroll-${process.pid}-`));
  const userDataPath = path.join(profilePath, "user-data");
  fs.mkdirSync(userDataPath, { recursive: true });
  const port = await getFreePort();
  const mainPath = path.join(ROOT, "dist", "main.js");
  if (!fs.existsSync(mainPath)) throw new Error("dist/main.js is missing; run npm run build:main first");
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [
    mainPath,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataPath}`,
  ], {
    cwd: ROOT,
    env: { ...electronEnv, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  return new ElectronRun(child, profilePath, port, timeoutMs);
}

module.exports = { launchElectron, ElectronRun };
