import { Menu, MenuItem, BrowserWindow, dialog } from "electron";

import { Window } from "../Window";
import { toElectronAccelerator } from "../keybindings/ElectronAccelerator";

export class AppMenu {
  menu: InstanceType<typeof Menu> | null;
  window: BrowserWindow;
  WinAPP: Window;
  autoSaveItem: InstanceType<typeof MenuItem> | null = null;
  hasActiveFile = false;

  readonly fileActionIds = [
    "save",
    "save-as",
    "close-file",
    "close-all-files",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "find",
    "go-to-line",
    "select-all",
    "new-line",
    "delete-line",
  ];

  constructor(window: BrowserWindow, WinAPP: Window) {
    this.window = window;
    this.WinAPP = WinAPP;

    this.menu = null;
    if (process.platform === "darwin") {
      this.refreshKeybindings();
    } else {
      Menu.setApplicationMenu(null);
    }
  }

  getAccelerator(action: string): string | undefined {
    const shortcut = this.WinAPP.app.settings?.get?.(`keybindings.${action}`);
    return toElectronAccelerator(
      typeof shortcut === "string" || shortcut === null ? shortcut : null,
    );
  }

  refreshKeybindings() {
    if (process.platform !== "darwin") return;

    this.menu = new Menu();
    this.autoSaveItem = null;
    this.init();
    this.setAutoSaveState(
      this.WinAPP.app.settings?.get?.("files.autoSave") === true,
    );
    this.setFileActionsEnabled(this.hasActiveFile);
    Menu.setApplicationMenu(this.menu);
  }

  setFileActionsEnabled(enabled: boolean) {
    this.hasActiveFile = enabled === true;
    for (const id of this.fileActionIds) {
      const item = this.menu?.getMenuItemById?.(id);
      if (item) item.enabled = this.hasActiveFile;
    }
  }

  getRecentFolderItems() {
    const folders = this.WinAPP.app.recentFolders?.getAll?.() || [];
    if (folders.length === 0) {
      return [{ label: "No Recent Folders", enabled: false }];
    }
    return [
      ...folders.map((folderPath: string) => ({
        label: folderPath,
        click: () => this.WinAPP.requestOpenRecentFolder(folderPath),
      })),
      { type: "separator" as const },
      {
        label: "Clear Recently Opened",
        click: () => void this.WinAPP.clearRecentFolders(),
      },
    ];
  }

  init() {
    if (!this.menu) return;
    const quitAccelerator = this.getAccelerator("quit_app");
    this.menu.append(
      new MenuItem({
        label: "NCE",

        submenu: [
          {
            label: "About NCE",
            click: () => this.showAbout(),
          },
          {
            label: "Quit NCE",

            accelerator: quitAccelerator,

            click: () => this.exitApp(),
          },
        ],
      }),
    );

    /*
     * =======================================================
     * FILE
     * =======================================================
     */

    this.menu.append(
      new MenuItem({
        label: "File",

        submenu: [
          {
            label: "New File",

            accelerator: this.getAccelerator("new_file"),

            click: () => this.newFile(),
          },

          {
            type: "separator",
          },

          {
            label: "Open File...",

            accelerator: this.getAccelerator("open_file"),

            click: () => this.openFile(),
          },

          {
            label: "Open Folder...",

            accelerator: this.getAccelerator("open_folder"),

            click: () => this.openFolder(),
          },

          {
            label: "Open Recent",
            submenu: this.getRecentFolderItems(),
          },

          {
            type: "separator",
          },

          {
            id: "save",
            label: "Save",

            accelerator: this.getAccelerator("save"),

            click: () => this.saveFile(),
          },

          {
            id: "save-as",
            label: "Save As...",

            accelerator: "CommandOrControl+Shift+S",

            click: () => this.saveFileAs(),
          },

          {
            type: "separator",
          },

          {
            id: "auto-save",
            label: "Auto Save",
            type: "checkbox",
            checked: false,
            click: () =>
              this.window.webContents.send("auto-save-toggle-requested"),
          },

          {
            type: "separator",
          },

          {
            id: "close-file",
            label: "Close File",

            accelerator: this.getAccelerator("close_file"),

            click: () => this.closeFile(),
          },

          {
            id: "close-all-files",
            label: "Close All Files",

            accelerator: this.getAccelerator("close_all_file"),

            click: () => this.closeAllFiles(),
          },

          {
            type: "separator",
          },

          {
            label: "Quit NCE",

            accelerator: quitAccelerator,

            click: () => this.exitApp(),
          },
        ],
      }),
    );
    this.autoSaveItem = this.menu.getMenuItemById?.("auto-save") || null;

    /*
     * =======================================================
     * EDIT
     * =======================================================
     */

    this.menu.append(
      new MenuItem({
        label: "Edit",

        submenu: [
          {
            id: "undo",
            label: "Undo",

            accelerator: this.getAccelerator("undo"),

            click: () => this.editAction("undo"),
          },

          {
            id: "redo",
            label: "Redo",

            accelerator: this.getAccelerator("redo"),

            click: () => this.editAction("redo"),
          },

          {
            type: "separator",
          },

          {
            id: "cut",
            label: "Cut",

            accelerator: this.getAccelerator("cut"),

            click: () => this.editAction("cut"),
          },

          {
            id: "copy",
            label: "Copy",

            accelerator: this.getAccelerator("copy"),

            click: () => this.editAction("copy"),
          },

          {
            id: "paste",
            label: "Paste",

            accelerator: this.getAccelerator("paste"),

            click: () => this.editAction("paste"),
          },

          {
            type: "separator",
          },

          {
            id: "find",
            label: "Find",

            accelerator: this.getAccelerator("find"),

            click: () => this.find(),
          },

          {
            id: "go-to-line",
            label: "Go to Line...",

            accelerator: this.getAccelerator("go_to_line"),

            click: () => this.goToLine(),
          },

          {
            type: "separator",
          },

          {
            id: "select-all",
            label: "Select All",

            accelerator: this.getAccelerator("select_all"),

            click: () => this.editAction("selectAll"),
          },

          {
            label: "Unselect All",

            click: () => this.unSelectAll(),
          },

          {
            type: "separator",
          },

          {
            id: "new-line",
            label: "New Line",

            click: () => this.newLine(),
          },

          {
            id: "delete-line",
            label: "Delete Line",

            accelerator: this.getAccelerator("delete_line"),

            click: () => this.deleteLine(),
          },
          { type: "separator" },
          {
            label: "Settings...",

            accelerator: this.getAccelerator("open_settings"),

            click: () =>
              this.window.webContents.send("open-settings-requested"),
          },
        ],
      }),
    );

    /*
     * =======================================================
     * VIEW
     * =======================================================
     */

    this.menu.append(
      new MenuItem({
        label: "View",

        submenu: [
          {
            type: "separator",
          },

          {
            label: "File Explorer",

            accelerator: this.getAccelerator("toggle_file_explorer"),

            click: () => this.toggleFileExplorer(),
          },

          {
            label: "Search",

            accelerator: this.getAccelerator("toggle_search"),

            click: () => this.toggleSearch(),
          },

          {
            label: "Agent",

            accelerator: this.getAccelerator("toggle_agent"),

            click: () => this.toggleAgent(),
          },

          {
            label: "Quick Open...",

            accelerator: this.getAccelerator("quick_open"),

            click: () => this.quickOpen(),
          },

          {
            label: "Command Palette",

            accelerator: this.getAccelerator("open_command"),

            click: () => this.openCommandPalette(),
          },

          {
            type: "separator",
          },

          {
            label: "Toggle Fullscreen",

            accelerator: process.platform === "darwin" ? "Ctrl+Cmd+F" : "F11",

            click: () => this.toggleFullscreen(),
          },

          {
            label: "Reload Window",

            accelerator: this.getAccelerator("reload_window"),

            click: () => this.reloadWindow(),
          },
        ],
      }),
    );

    /*
     * =======================================================
     * HELP
     * =======================================================
     */

    this.menu.append(
      new MenuItem({
        label: "Help",

        submenu: [
          {
            type: "separator",
          },

          {
            label: "About NCE",

            click: () => this.showAbout(),
          },
        ],
      }),
    );
  }

  setAutoSaveState(enabled: boolean) {
    if (this.autoSaveItem) this.autoSaveItem.checked = enabled === true;
  }

  async editAction(action: string) {
    const script = `
      (() => {
        const element =
          document.activeElement;

        const isInput =
          element instanceof HTMLInputElement;

        const isTextarea =
          element instanceof HTMLTextAreaElement;

        const isSelect =
          element instanceof HTMLSelectElement;

        const isEditable =
          element instanceof HTMLElement &&
          element.isContentEditable;

        const nativeInput =
          isInput ||
          isTextarea ||
          isSelect ||
          isEditable;

        if (!nativeInput) {
          return false;
        }

        switch (${JSON.stringify(action)}) {

          case "selectAll":
            if (
              isInput ||
              isTextarea
            ) {
              element.select();
            } else if (isEditable) {
              const selection =
                window.getSelection();

              const range =
                document.createRange();

              range.selectNodeContents(
                element,
              );

              selection.removeAllRanges();

              selection.addRange(
                range,
              );
            }

            return true;

          case "copy":
            return document.execCommand(
              "copy",
            );

          case "cut":
            return document.execCommand(
              "cut",
            );

          case "undo":
            return document.execCommand(
              "undo",
            );

          case "redo":
            return document.execCommand(
              "redo",
            );

          default:
            return false;
        }
      })();
    `;

    try {
      const handled = await this.window.webContents.executeJavaScript(script);

      if (handled) {
        return;
      }
    } catch (error) {
      console.error("Native edit action error:", error);
    }

    switch (action) {
      case "undo":
        this.undo();
        break;

      case "redo":
        this.redo();
        break;

      case "cut":
        this.cut();
        break;

      case "copy":
        this.copy();
        break;

      case "paste":
        await this.paste();
        break;

      case "selectAll":
        this.selectAll();
        break;
    }
  }

  // =========================================================
  // FILE
  // =========================================================

  newFile() {
    this.executeEditor("control_new_file");
  }

  openFile() {
    this.executeEditor("control_open_file");
  }

  openFolder() {
    this.executeEditor("control_open_folder");
  }

  quickOpen() {
    this.executeEditor("control_quick_open");
  }

  saveFile() {
    this.executeEditor("control_save");
  }

  saveFileAs() {
    this.executeEditor("control_save", "true");
  }

  closeFile() {
    this.executeEditor("control_close_file");
  }

  closeAllFiles() {
    this.executeEditor("control_close_all_file");
  }

  // =========================================================
  // EDIT
  // =========================================================

  undo() {
    this.executeEditor("control_undo");
  }

  redo() {
    this.executeEditor("control_redo");
  }

  cut() {
    this.executeEditor("control_cut");
  }

  copy() {
    this.executeEditor("control_copy");
  }

  async paste() {
    const script = `
      (async () => {
        const element =
          document.activeElement;

        const isInput =
          element instanceof HTMLInputElement;

        const isTextarea =
          element instanceof HTMLTextAreaElement;

        const isEditable =
          element instanceof HTMLElement &&
          element.isContentEditable;

        if (
          !isInput &&
          !isTextarea &&
          !isEditable
        ) {
          return false;
        }

        try {
          const text =
            await navigator.clipboard.readText();

          if (
            isInput ||
            isTextarea
          ) {
            const start =
              element.selectionStart ?? 0;

            const end =
              element.selectionEnd ?? 0;

            const value =
              element.value ?? "";

            element.value =
              value.slice(0, start) +
              text +
              value.slice(end);

            const cursor =
              start + text.length;

            element.selectionStart =
              cursor;

            element.selectionEnd =
              cursor;

            element.dispatchEvent(
              new Event("input", {
                bubbles: true,
              }),
            );

            return true;
          }

          if (isEditable) {
            return document.execCommand(
              "insertText",
              false,
              text,
            );
          }
        } catch (error) {
          console.error(
            "Native paste error:",
            error,
          );
        }

        return false;
      })();
    `;

    try {
      const handled = await this.window.webContents.executeJavaScript(script);

      if (handled) {
        return;
      }
    } catch (error) {
      console.error("Paste error:", error);
    }

    this.executeEditor("control_paste");
  }

  find() {
    this.executeEditor("control_find");
  }

  goToLine() {
    this.executeEditor("control_go_to_line");
  }

  replace() {
    this.executeEditor("control_replace");
  }

  selectAll() {
    this.executeEditor("control_select_all");
  }

  unSelectAll() {
    this.window.webContents.executeJavaScript(
      `
        if (
          editor &&
          editor.selectController
        ) {
          editor.selectController.unSelectAll();
        }
      `,
    );
  }

  newLine() {
    this.executeEditor("key_enter");
  }

  deleteLine() {
    this.executeEditor("control_delete_line");
  }

  // =========================================================
  // VIEW
  // =========================================================

  toggleFileExplorer() {
    this.executeEditor("control_toggle_file_explorer");
  }

  toggleSearch() {
    this.executeEditor("control_toggle_search");
  }

  toggleAgent() {
    this.executeEditor("control_toggle_agent");
  }

  openCommandPalette() {
    this.executeEditor("control_open_command");
  }

  toggleFullscreen() {
    const fullscreen = this.window.isFullScreen();

    this.window.setFullScreen(!fullscreen);
  }

  reloadWindow() {
    this.executeEditor("control_reload_window");
  }

  // =========================================================
  // APPLICATION
  // =========================================================

  exitApp() {
    this.window.close();
  }

  // =========================================================
  // ABOUT
  // =========================================================

  async showAbout() {
    await dialog.showMessageBox(this.window, {
      type: "info",

      title: "About NCE",

      message: "NCE Code Editor",

      detail:
        "A lightweight and powerful code editor.\n\n" +
        `Version ${this.WinAPP.app.version}`,

      buttons: ["OK"],

      defaultId: 0,
    });
  }

  // =========================================================
  // UTILITIES
  // =========================================================

  executeEditor(method: string, ...args: string[]) {
    const serializedArgs = args.length > 0 ? `, ${args.join(", ")}` : "";

    const script = `
      (() => {
        if (
          typeof editor === "undefined" ||
          !editor ||
          !editor.keyBinding
        ) {
          return;
        }

        editor.keyBinding.${method}(
          ${serializedArgs}
        );
      })();
    `;

    this.window.webContents.executeJavaScript(script);
  }
}
