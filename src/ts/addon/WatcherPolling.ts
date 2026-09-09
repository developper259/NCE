import { EventEmitter } from "node:events";
import { fork, ChildProcess } from "node:child_process";
const path = require("node:path");

export class PollingWatcher extends EventEmitter {
  private child: ChildProcess | null;
  private closing: Promise<void> | null = null;

  constructor(projectPath: string) {
    super();
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    this.child = fork(
      path.join(__dirname, "WatcherPollingWorker.js"),
      [projectPath],
      { execPath: process.execPath, env, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    this.child.on("message", (message: any) => {
      if (message?.type === "ready") this.emit("ready");
      if (message?.type === "all") this.emit("all", message.event, message.filePath);
      if (message?.type === "error") {
        const error: any = new Error(message.error?.message || "Polling watcher failed");
        error.code = message.error?.code;
        error.path = message.error?.path;
        this.emit("error", error);
      }
    });
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("exit", (code, signal) => {
      const wasClosing = Boolean(this.closing);
      this.child = null;
      if (!wasClosing && code !== 0) {
        this.emit("error", new Error(`Polling watcher exited (${code ?? signal}).`));
      }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.closing = new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.send({ type: "close" });
      else child.kill("SIGTERM");
    });
    return this.closing;
  }
}
