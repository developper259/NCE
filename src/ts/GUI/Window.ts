import { BrowserWindow } from "electron";

export class Window {
  window: BrowserWindow | null;

  constructor() {
    this.window = null;
  }

  create() {
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 800,
      minHeight: 600,
    });
    this.window.loadFile("./html/index.html");

    this.window.on("closed", () => {
      this.window = null;
    });
  }
}
