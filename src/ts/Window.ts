import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';

import { FileManager } from './FileManager';
import { AppMenu } from './Menu';

export class Window {
  window: InstanceType<typeof BrowserWindow> | null;
  fileManager: FileManager | undefined;
  name: string;

  constructor(name: string ) {
    this.window = null;
    this.name = name;
  }

  create() {
    this.fileManager = new FileManager();

    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 800,
      minHeight: 600,
      title: this.name,
      fullscreen: true,
      webPreferences: {
        sandbox: false,
        preload: path.join(__dirname, '../js/main/Preload.js'),
        contextIsolation: true,
        nodeIntegration: true,
      },
    });

    const menu = new AppMenu(this.window, this);

    this.window.loadFile("../src/html/index.html");

    this.window.on("closed", () => {
      this.window = null;
    });

    this.window.webContents.openDevTools();

    if (!this.fileManager) console.log('FileManager is not defined');

    ipcMain.handle('App:quit', async () => {
      return app.quit();
    });

    ipcMain.handle('FileManager:selectFile', async () => {
      return await this.fileManager?.selectFile();
    });

    ipcMain.handle('FileManager:selectFiles', async () => {
      return await this.fileManager?.selectFiles();
    });

    ipcMain.handle('FileManager:selectNewFile', async (event, name) => {
      return await this.fileManager?.selectNewFile(name);
    });

    ipcMain.handle('FileManager:getFileContent', async (event, file) => {
      return await this.fileManager?.getFileContent(file);
    });

    ipcMain.handle('FileManager:saveFile', async (event, path, content) => {
      return await this.fileManager?.saveFile(path, content);
    });
  
  }
}
