import { BrowserWindow } from "electron";

export class Window {
  window: BrowserWindow | null;
  width: number;
  height: number;

  construct() {
    this.window = null;
    this.width = 800;
    this.height = 600;
  }

  create() {
    this.window = new BrowserWindow({
      width: this.width,
      height: this.height,
    });
    this.window.loadFile("./html/index.html");

    this.window.on("closed", () => {
      this.window = null;
    });
  }
}
