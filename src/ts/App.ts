import { app } from "electron";
import { Window } from "./GUI/Window";

export class App {
  window: Window;

  constructor() {
    this.window = new Window();

    app.on("ready", this.window.create);

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });

    app.on("activate", () => {
      if (this.window.window === null) {
        this.window.create();
      }
    });
  }
}
