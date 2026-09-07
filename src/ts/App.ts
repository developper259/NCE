import { app } from 'electron';
import { Window } from './Window';
import { NSHServer } from 'nsh/server';

export class App {
  window: Window;
  nsh: NSHServer;
  nshEndpoint: { host: string; port: number } | null = null;
  nshStarting = false;
  nshStopping = false;
  name = "NCE";

  version = app.getVersion();

  constructor() {
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
