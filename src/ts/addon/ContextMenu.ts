import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  ipcMain,
  nativeTheme,
} from "electron";
import type { IpcHandlerRegistrar } from "../manager/IpcRouter";

export class ContextMenu {
  window: BrowserWindow;
  private readonly ipc: IpcHandlerRegistrar;

  constructor(window: BrowserWindow, ipc: IpcHandlerRegistrar = ipcMain as any) {
    this.window = window;
    this.ipc = ipc;
  }

  handleIPC() {
    this.ipc.handle(
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
    this.ipc.handle(
      "ContextMenu:show",
      async (
        event,
        actions: Array<{
          name: string;
          keys?: string;
          enabled?: boolean;
          type?: string;
          checked?: boolean;
        }>,
      ) => {
        return this.openContext(actions);
      },
    );
  }

  async openContext(
    actions: Array<{
      name: string;
      type?: string;
      checked?: boolean;
      keys?: string;
      enabled?: boolean;
    }>,
  ) {
    const template: MenuItemConstructorOptions[] = actions.map((action) => {
      if (action.type === "separator") {
        return { type: "separator" };
      }
      return {
        ...(action.type === "checkbox"
          ? { type: "checkbox" as const, checked: action.checked === true }
          : {}),
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
