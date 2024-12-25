import { BrowserWindow } from 'electron';

export class Window {
  window: InstanceType<typeof BrowserWindow> | null;
  name: string;

  constructor(name: string) {
    this.window = null;
    this.name = name;
  }

  create() {
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 800,
      minHeight: 600,
      title: this.name,
      fullscreen: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: true,
      },
    });

    this.window.loadFile("../src/html/index.html");

    this.window.on("closed", () => {
      this.window = null;
    });

    this.window.webContents.openDevTools();
  }
}
