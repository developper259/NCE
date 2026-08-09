import { app } from 'electron';
import { Window } from './Window';
import { NSHServer } from '../modules/NSH/core/Socket'

export class App {
  window: Window;
  nsh: NSHServer;
  name = "NCE";
  port = 1212;

  constructor() {
    this.window = new Window(this.name);
    this.nsh = new NSHServer(this.port);

    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
    } else {
      this.setupAppEvents();
    }
  }
  setupAppEvents() {
    app.on("ready", () => {
      this.nsh.start();
      
      this.window.create();
    });

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
