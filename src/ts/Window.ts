import { BrowserWindow, ipcMain } from 'electron';
import { FileManager } from './FileManager';
import path from 'path';

export class Window {
  window: InstanceType<typeof BrowserWindow> | null;
  fileManager: FileManager | undefined;
  name: string;

  constructor(name: string) {
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

    this.window.loadFile("../src/html/index.html");

    this.window.on("closed", () => {
      this.window = null;
    });

    this.window.webContents.openDevTools();

    if (!this.fileManager) console.log('FileManager is not defined');

    ipcMain.handle('FileManager:selectFile', async () => {
      return await this.fileManager?.selectFile();
    });


    ipcMain.handle('FileManager:getFileContent', async (event, arg) => {
      return await this.fileManager?.getFileContent(arg);
    });
  
  }
}
