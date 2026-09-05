import { Menu, MenuItem, BrowserWindow, dialog } from "electron";

import { Window } from "../Window";

export class AppMenu {
  menu: InstanceType<typeof Menu>;
  window: BrowserWindow;
  WinAPP: Window;

  constructor(window: BrowserWindow, WinAPP: Window) {
    this.window = window;
    this.WinAPP = WinAPP;

    this.menu = new Menu();

    this.init();

    Menu.setApplicationMenu(this.menu);
  }

  init() {
    /*
     * =======================================================
     * NCE
     * =======================================================
     */

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

            accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4",

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

            accelerator: "CommandOrControl+N",

            click: () => this.newFile(),
          },

          {
            type: "separator",
          },

          {
            label: "Open File...",

            accelerator: "CommandOrControl+O",

            click: () => this.openFile(),
          },

          {
            label: "Open Folder...",

            accelerator: "CommandOrControl+Shift+O",

            click: () => this.openFolder(),
          },

          {
            type: "separator",
          },

          {
            label: "Save",

            accelerator: "CommandOrControl+S",

            click: () => this.saveFile(),
          },

          {
            label: "Save As...",

            accelerator: "CommandOrControl+Shift+S",

            click: () => this.saveFileAs(),
          },

          {
            type: "separator",
          },

          {
            label: "Close File",

            accelerator: "CommandOrControl+W",

            click: () => this.closeFile(),
          },

          {
            label: "Close All Files",

            accelerator: "CommandOrControl+Shift+W",

            click: () => this.closeAllFiles(),
          },

          {
            type: "separator",
          },

          {
            label: "Quit NCE",

            accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4",

            click: () => this.exitApp(),
          },
        ],
      }),
    );

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
            label: "Undo",

            accelerator: "CommandOrControl+Z",

            click: () => this.editAction("undo"),
          },

          {
            label: "Redo",

            accelerator: "CommandOrControl+Shift+Z",

            click: () => this.editAction("redo"),
          },

          {
            type: "separator",
          },

          {
            label: "Cut",

            accelerator: "CommandOrControl+X",

            click: () => this.editAction("cut"),
          },

          {
            label: "Copy",

            accelerator: "CommandOrControl+C",

            click: () => this.editAction("copy"),
          },

          {
            label: "Paste",

            accelerator: "CommandOrControl+V",

            click: () => this.editAction("paste"),
          },

          {
            type: "separator",
          },

          {
            label: "Find",

            accelerator: "CommandOrControl+F",

            click: () => this.find(),
          },

          {
            label: "Replace",

            accelerator: "CommandOrControl+H",

            click: () => this.replace(),
          },

          {
            type: "separator",
          },

          {
            label: "Select All",

            accelerator: "CommandOrControl+A",

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
            label: "New Line",

            click: () => this.newLine(),
          },

          {
            label: "Delete Line",

            click: () => this.deleteLine(),
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
            label: "Reload Window",

            accelerator: "CommandOrControl+R",

            click: () => this.reloadWindow(),
          },

          {
            type: "separator",
          },

          {
            label: "File Explorer",

            accelerator: "CommandOrControl+Shift+E",

            click: () => this.toggleFileExplorer(),
          },

          {
            label: "Search",

            accelerator: "CommandOrControl+Shift+F",

            click: () => this.toggleSearch(),
          },

          {
            label: "Command Palette",

            accelerator: "CommandOrControl+Shift+P",

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
            label: "Toggle Developer Tools",

            accelerator:
              process.platform === "darwin" ? "Alt+Cmd+I" : "Ctrl+Shift+I",

            click: () => this.openDevTools(),
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
            label: "Documentation",

            click: () => this.openDocumentation(),
          },

          {
            label: "Check for Updates",

            click: () => this.checkUpdate(),
          },

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

  openCommandPalette() {
    this.executeEditor("control_open_command");
  }

  reloadWindow() {
    this.window.webContents.reload();
  }

  toggleFullscreen() {
    const fullscreen = this.window.isFullScreen();

    this.window.setFullScreen(!fullscreen);
  }

  openDevTools() {
    if (this.window.webContents.isDevToolsOpened()) {
      this.window.webContents.closeDevTools();
    } else {
      this.window.webContents.openDevTools();
    }
  }

  // =========================================================
  // APPLICATION
  // =========================================================

  exitApp() {
    this.window.close();
  }

  settings() {
    console.log("Open NCE Settings");
  }

  NDLSettings() {
    console.log("Open NDL Settings");
  }

  checkUpdate() {
    console.log("Check for updates");
  }

  openDocumentation() {
    console.log("Open documentation");
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
