import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  ipcMain,
} from "electron";

export class ContextMenu {
  window: BrowserWindow;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  handleIPC() {
    ipcMain.handle(
      "ContextMenu:show",
      async (event, actions: Array<{ name: string; keys?: string }>) => {
        return this.openContext(actions);
      },
    );
  }

  async openContext(
    actions: Array<{ name: string; type?: string; keys?: string }>,
  ) {
    const template: MenuItemConstructorOptions[] = actions.map((action) => {
      if (action.type === "separator") {
        return { type: "separator" };
      }
      return {
        label: action.name,
        accelerator: action.keys,
        click: () => {
          this.window.webContents.send("ContextMenu:triggered", action.name);
        },
      };
    });

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: this.window });
  }
}
