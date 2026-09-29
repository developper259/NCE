import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Window } from './Window';
import { NSHServer } from 'nsh/server';
import { SettingsManager } from './manager/SettingsManager';
import { RecentFoldersManager } from './manager/RecentFoldersManager';
import { AgentConversationStore } from './manager/AgentConversationStore';
import { performance } from 'node:perf_hooks';

function getPackageVersion() {
  try {
    const packagePath = path.join(app.getAppPath(), 'package.json');
    const packageVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    if (typeof packageVersion === 'string' && packageVersion.trim()) {
      return packageVersion;
    }
  } catch {}
  return app.getVersion();
}

export class App {
  window: Window;
  nsh: NSHServer;
  nshEndpoint: { host: string; port: number } | null = null;
  nshStarting = false;
  nshStopping = false;
  settings!: SettingsManager;
  recentFolders!: RecentFoldersManager;
  agentConversations!: AgentConversationStore;
  name = "NCE";

  readonly benchmarkEnabled = typeof process !== "undefined" && process.env.NCE_BENCHMARK === "1";
  private readonly benchmarkOrigin = performance.now();
  private readonly benchmarkEvents: Array<{ name: string; offsetMs: number }> = [];

  version = getPackageVersion();

  constructor() {
    this.configureBenchmarkProfile();
    this.recordBenchmarkEvent("process-start");
    this.window = new Window(this);
    this.nsh = new NSHServer({ host: "127.0.0.1", port: 0 });

    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
    } else {
      this.setupAppEvents();
    }
  }
  setupAppEvents() {
    app.on("ready", async () => {
      this.recordBenchmarkEvent("app-ready");
      this.settings = new SettingsManager(app.getPath("userData"));
      await this.settings.initialize();
      this.recentFolders = new RecentFoldersManager(app.getPath("userData"));
      await this.recentFolders.initialize();
      this.agentConversations = new AgentConversationStore(app.getPath("userData"));
      await this.agentConversations.initialize();
      await this.startNsh();
      this.window.create();
    });

    app.on("before-quit", (event) => {
      if (this.nshStopping) return;
      event.preventDefault();
      if (this.window.window && !this.window.forceQuit) {
        this.window.requestQuit();
        return;
      }
      this.stopNsh().finally(() => app.quit());
    });

    app.on("window-all-closed", () => {
      app.quit();
    });

    app.on("activate", () => {
      if (this.window.window === null) {
        this.window.create();
      }
    });
  }

  private configureBenchmarkProfile() {
    if (!this.benchmarkEnabled) return;
    const userDataPath = process.env.NCE_BENCHMARK_USER_DATA;
    const sessionDataPath = process.env.NCE_BENCHMARK_SESSION_DATA;
    if (userDataPath && path.isAbsolute(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
      app.setPath("userData", userDataPath);
    }
    if (sessionDataPath && path.isAbsolute(sessionDataPath)) {
      fs.mkdirSync(sessionDataPath, { recursive: true });
      app.setPath("sessionData", sessionDataPath);
    }
  }

  recordBenchmarkEvent(name: string, details?: Record<string, number>) {
    if (!this.benchmarkEnabled) return;
    this.benchmarkEvents.push({
      name,
      offsetMs: performance.now() - this.benchmarkOrigin,
      ...(details || {}),
    });
  }

  getBenchmarkDiagnostics() {
    if (!this.benchmarkEnabled) return null;
    const cpuSampleStartedAtMs = performance.now();
    const cpuUsage = process.cpuUsage();
    const cpuSampleFinishedAtMs = performance.now();
    return {
      enabled: true,
      events: this.benchmarkEvents.slice(),
      mainProcess: {
        memory: process.memoryUsage(),
        // Node reports cumulative process CPU time in microseconds. Bracket it
        // with the same monotonic clock so the runner can pair matching windows.
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system,
          sampledAtMonotonicMs: (cpuSampleStartedAtMs + cpuSampleFinishedAtMs) / 2,
        },
      },
      electronProcesses: app.getAppMetrics().map((metric) => ({
        type: metric.type,
        memory: metric.memory,
        cpu: metric.cpu,
      })),
    };
  }

  async startNsh() {
    if (this.nshStarting || this.nshEndpoint) return this.nshEndpoint;

    this.nshStarting = true;
    try {
      const port = await this.nsh.start();
      this.nshEndpoint = { host: "127.0.0.1", port };
      return this.nshEndpoint;
    } catch (error) {
      console.error("[NSH] Failed to start syntax server", error);
      this.nshEndpoint = null;
      return null;
    } finally {
      this.nshStarting = false;
    }
  }

  async stopNsh() {
    if (this.nshStopping) return;
    this.nshStopping = true;
    try {
      if (this.nsh.getPort() !== null) await this.nsh.stop();
    } catch (error) {
      console.error("[NSH] Failed to stop syntax server", error);
    } finally {
      this.nshEndpoint = null;
    }
  }
}
