import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  ipcMain,
  nativeTheme,
} from "electron";
import type { IpcHandlerRegistrar } from "../manager/IpcRouter";
import {
  titleBarOverlayFor,
  type ResolvedTheme,
} from "../manager/TitleBarTheme";

export type MenuPosition = {
  x: number;
  y: number;
  verticalAlign?: "top" | "bottom";
};

// Native menus do not expose their pixel height, so a bottom anchor is
// converted to the popup's top-left origin using per-platform row metrics.
const MENU_ROW_METRICS: Record<
  string,
  { row: number; separator: number; padding: number }
> = {
  darwin: { row: 22, separator: 11, padding: 8 },
  win32: { row: 26, separator: 9, padding: 4 },
  linux: { row: 24, separator: 9, padding: 4 },
};

function estimateMenuHeight(
  template: MenuItemConstructorOptions[],
  platform: string,
): number {
  const metrics = MENU_ROW_METRICS[platform] ?? MENU_ROW_METRICS.linux;
  return template.reduce(
    (height, item) =>
      height + (item.type === "separator" ? metrics.separator : metrics.row),
    metrics.padding,
  );
}

export class ContextMenu {
  window: BrowserWindow;
  private readonly ipc: IpcHandlerRegistrar;
  /** Last theme the renderer reported, so the scrim toggle can re-apply it. */
  private resolvedTheme: ResolvedTheme = "dark";
  /** Surfaces currently showing a scrim; the overlay dims while non-empty. */
  private readonly scrimOwners = new Set<string>();

  constructor(window: BrowserWindow, ipc: IpcHandlerRegistrar = ipcMain as any) {
    this.window = window;
    this.ipc = ipc;
  }

  /**
   * The native overlay sits above the web contents, so a renderer scrim cannot
   * darken it. The renderer reports when a modal scrim goes up or down and the
   * overlay is repainted to match.
   */
  private applyTitleBarOverlay() {
    this.window.setTitleBarOverlay?.(
      titleBarOverlayFor(this.resolvedTheme, this.scrimOwners.size > 0),
    );
  }

  handleIPC() {
    this.ipc.handle(
      "Theme:setNativeSource",
      (_event, source: unknown, resolvedTheme: unknown) => {
      if (source !== "system" && source !== "dark" && source !== "light") {
        return false;
      }
      nativeTheme.themeSource = source;
      this.resolvedTheme = resolvedTheme === "light" ? "light" : "dark";
      this.applyTitleBarOverlay();
      return true;
      },
    );
    this.ipc.handle(
      "Theme:setModalScrim",
      (_event, owner: unknown, active: unknown) => {
        if (typeof owner !== "string" || !owner) return false;
        if (active === true) this.scrimOwners.add(owner);
        else this.scrimOwners.delete(owner);
        this.applyTitleBarOverlay();
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
        position?: MenuPosition | null,
      ) => {
        return this.openContext(actions, position);
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
    position?: MenuPosition | null,
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
    const popupOptions: { window: BrowserWindow; x?: number; y?: number } = {
      window: this.window,
    };
    // Anchor to an explicit point (e.g. beside the Settings icon) instead of
    // the mouse cursor when the renderer supplies one. A "bottom" anchor means
    // the supplied y is the menu's desired bottom edge, so lift the top origin
    // by the estimated menu height.
    if (
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
    ) {
      popupOptions.x = Math.round(position.x);
      const top =
        position.verticalAlign === "bottom"
          ? position.y - estimateMenuHeight(template, process.platform)
          : position.y;
      popupOptions.y = Math.round(top);
    }
    menu.popup(popupOptions);
  }
}
