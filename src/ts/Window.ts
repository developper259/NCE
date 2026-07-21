import { BrowserWindow, ipcMain } from "electron";
import path from "path";

import { FileManager } from "./addon/FileManager";
import { Watcher } from "./addon/Watcher";
import { AppMenu } from "./addon/Menu";

export class Window {
  window: InstanceType<typeof BrowserWindow> | null;
  fileManager: FileManager | undefined;
  watcher: Watcher | undefined;
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
      icon: path.join(__dirname, "../../assets/logo/NCE/dark-logo.png"), // build
      webPreferences: {
        sandbox: false,
        preload: path.join(__dirname, "../../src/js/main/Preload.js"),
        contextIsolation: true,
        nodeIntegration: true,
      },
    });

    this.fileManager = new FileManager(this.window);
    this.watcher = new Watcher(this.window);

    const menu = new AppMenu(this.window, this);

    this.window.loadFile(path.join(__dirname, "../../src/html/index.html")); // build

    this.window.webContents.on("did-finish-load", async () => {
      const state = await this.fileManager?.loadState();
      if (state) {
        this.window?.webContents.send("Request:loadState", state);
      }
    });

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

    ipcMain.handle("FileManager:selectFile", async () => {
      return await this.fileManager?.selectFile();
    });

    ipcMain.handle("FileManager:selectFiles", async () => {
      return await this.fileManager?.selectFiles();
    });

    ipcMain.handle("FileManager:selectNewFile", async (event, name) => {
      return await this.fileManager?.selectNewFile(name);
    });

    ipcMain.handle("FileManager:getFileContent", async (event, file) => {
      return await this.fileManager?.getFileContent(file);
    });

    ipcMain.handle("FileManager:saveFile", async (event, path, content) => {
      return await this.fileManager?.saveFile(path, content);
    });

    ipcMain.handle(
      "FileManager:confirmUnsavedChanges",
      async (event, fileName: string) => {
        if (!this.window) return "cancel";
        return await this.fileManager?.confirmUnsavedChanges(fileName);
      },
    );

    ipcMain.handle(
      "FileManager:getFolderContent",
      async (event, dirPath: string) => {
        return await this.fileManager?.getFolderContent(dirPath);
      },
    );

    ipcMain.handle("FileManager:selectFolder", async () => {
      return await this.fileManager?.selectFolder();
    });

    ipcMain.handle(
      "FileManager:initializeFile",
      async (event, filePath: string) => {
        return await this.fileManager?.initializeFile(filePath);
      },
    );

    ipcMain.handle(
      "FileManager:getFileChunk",
      async (event, filePath: string, startLine: number, lineCount: number) => {
        return await this.fileManager?.getFileChunk(
          filePath,
          startLine,
          lineCount,
        );
      },
    );

    ipcMain.handle(
      "FileManager:saveState",
      async (event, stateString: string) => {
        const saved = await this.fileManager?.saveState(stateString);
        if (this.forceQuit) {
          this.window?.close();
        }
        return saved;
      },
    );

    ipcMain.handle("FileManager:loadState", async () => {
      return (await this.fileManager?.loadState()) ?? null;
    });

    ipcMain.handle("Watcher:startWatching", async (event, projectPath: string) => {
      this.watcher?.startWatching(projectPath);
    });

    ipcMain.handle("Watcher:stopWatching", async () => {
      this.watcher?.stopWatching();
    });
  }
}
