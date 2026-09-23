import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  ipcMain,
  nativeTheme,
} from "electron";

export class ContextMenu {
  window: BrowserWindow;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  handleIPC() {
    ipcMain.handle(
      "Theme:setNativeSource",
      (_event, source: unknown, resolvedTheme: unknown) => {
      if (source !== "system" && source !== "dark" && source !== "light") {
        return false;
      }
      nativeTheme.themeSource = source;
      const theme = resolvedTheme === "light" ? "light" : "dark";
      this.window.setTitleBarOverlay?.({
        color: theme === "light" ? "#f5f6f8" : "#181818",
        symbolColor: theme === "light" ? "#59636f" : "#b8b8b8",
      });
      return true;
      },
    );
    ipcMain.handle(
      "ContextMenu:show",
      async (
        event,
        actions: Array<{ name: string; keys?: string; enabled?: boolean }>,
      ) => {
        return this.openContext(actions);
      },
    );
  }

  async openContext(
    actions: Array<{
      name: string;
      type?: string;
      keys?: string;
      enabled?: boolean;
    }>,
  ) {
    const template: MenuItemConstructorOptions[] = actions.map((action) => {
      if (action.type === "separator") {
        return { type: "separator" };
      }
      return {
        label: action.name,
        accelerator: action.keys,
        enabled: action.enabled !== false,
        click: () => {
          this.window.webContents.send("ContextMenu:triggered", action.name);
        },
      };
    });

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: this.window });
  }
}
