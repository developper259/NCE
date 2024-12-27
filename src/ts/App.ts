import { app } from 'electron';
import { Window } from './Window';

export class App {
  window: Window;
  name = "NCE";

  constructor() {
    this.window = new Window(this.name);

    app.on("ready", this.window.create);

    app.on("window-all-closed", () => {
      app.quit();
    });

    app.on("activate", () => {
      if (this.window.window === null) {
        this.window.create();
      }
    });
  }
}
