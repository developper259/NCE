import { BrowserWindow, ipcMain } from "electron";
import path from "path";

import { FileManager } from "./addon/FileManager";
import { Watcher } from "./addon/Watcher";
import { AppMenu } from "./addon/Menu";
import { NSH } from './NSH'
import { ContextMenu } from "./addon/ContextMenu";

export class Window {
  window: InstanceType<typeof BrowserWindow> | null;
  fileManager: FileManager | undefined;
  watcher: Watcher | undefined;
  contextMenu: ContextMenu | undefined;
  nsh: NSH | undefined;
  name: string;
  forceQuit: boolean;

  constructor(name: string) {
    this.window = null;
    this.name = name;
    this.forceQuit = false;
  }

  create() {
    this.forceQuit = false;
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 800,
      minHeight: 600,
      title: this.name,
      fullscreen: true,
      icon: path.join(__dirname, "../../assets/logo/NCE/dark-logo.png"),
      webPreferences: {
        sandbox: false,
        preload: path.join(__dirname, "../../src/js/main/Preload.js"),
        contextIsolation: true,
        nodeIntegration: true,
      },
    });

    this.fileManager = new FileManager(this);
    this.watcher = new Watcher(this.window);
    this.contextMenu = new ContextMenu(this.window);
    this.nsh = new NSH(this);

    const menu = new AppMenu(this.window, this);

    this.window.loadFile(path.join(__dirname, "../../src/html/index.html"));

    this.window.on("close", (event) => {
      if (this.forceQuit) return;
      event.preventDefault();
      this.forceQuit = true;
      this.window?.webContents.send("Request:saveState");
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    this.window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const isReload =
        (input.meta || input.control) && input.key.toLowerCase() === "r";
      if (!isReload) return;
      event.preventDefault();
      this.window?.webContents.reload();
    });

    //this.window.webContents.openDevTools();

    if (!this.fileManager) console.log("FileManager is not defined");

    ipcMain.handle("App:quit", async () => {
      this.window?.close();
    });

    this.fileManager.handleIPC();

    this.watcher.handleIPC();

    this.contextMenu.handleIPC();
  }
}
