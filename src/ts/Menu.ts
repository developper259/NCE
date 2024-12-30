import { Menu, MenuItem, BrowserWindow } from 'electron';
import { Window } from './Window';

export class AppMenu {
  menu: InstanceType<typeof Menu>;
  window: BrowserWindow;
  WinAPP: Window;

  constructor(window: BrowserWindow, WinAPP: Window) {
    this.menu = new Menu();
    this.window = window;
    this.WinAPP = WinAPP;

    this.init();
    Menu.setApplicationMenu(this.menu);
  }

  init() {
    // NCE Menu
    this.menu.append(new MenuItem({
        label: 'NCE',
        submenu: [
            {
            label: 'About NCE',
            click: () => this.showAbout(),
            },
            {
            label: 'Check Update',
            click: () => this.checkUpdate(),
            },
            { type: 'separator' },
            {
            label: 'NCE Settings',
            click: () => this.settings(),
            },
            {
            label: 'NDL Settings',
            click: () => this.NDLSettings(),
            },
            { type: 'separator' },
            {
            label: 'Exit',
            accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
            click: () => this.exitApp(),
            },
        ],
    }));

    // File Menu
    this.menu.append(
      new MenuItem({
        label: 'File',
        submenu: [
          {
            label: 'New File',
            click: () => this.newFile(),
          },
          { type: 'separator' },
          {
            label: 'Open File',
            click: () => this.openFile(),
          },
          {
            label: 'Open Folder',
            click: () => this.openFolder(),
          },
          { type: 'separator' },
          {
            label: 'Save',
            click: () => this.saveFile(),
          },
          {
            label: 'Save As...',
            click: () => this.saveFileAs(),
          },
          { type: 'separator' },
          {
            label: 'Close File',
            click: () => this.closeFile(),
          },
          {
            label: 'Close All Files',
            click: () => this.closeAllFiles(),
          },
        ],
      })
    );

    // Edit Menu
    this.menu.append(
      new MenuItem({
        label: 'Edit',
        submenu: [
          {
            label: 'Undo',
            click: () => this.undo(),
          },
          {
            label: 'Redo',
            click: () => this.redo(),
          },
          { type: 'separator' },
          {
            label: 'Cut',
            click: () => this.cut(),
          },
          {
            label: 'Copy',
            click: () => this.copy(),
          },
          {
            label: 'Paste',
            click: () => this.paste(),
          },
          { type: 'separator' },
          {
            label: 'Find',
            click: () => this.find(),
          },
          {
            label: 'Replace',
            click: () => this.replace(),
          },
          { type: 'separator' },
          {
            label: 'Select All',
            click: () => this.selectAll(),
          },
          {
            label: 'Unselect All',
            click: () => this.unSelectAll(),
          },
          { type: 'separator' },
          {
            label: 'New Line',
            click: () => this.newLine(),
          },
          {
            label: 'Delete Line',
            click: () => this.deleteLine(),
          },
        ],
      })
    );

    // View Menu
    this.menu.append(
      new MenuItem({
        label: 'View',
        submenu: [
          {
            label: 'Reload',
            accelerator: 'CmdOrCtrl+R',
            click: () => this.reloadWindow(),
          },
          {
            label: 'Toggle Fullscreen',
            accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11',
            click: () => this.toggleFullscreen(),
          },
          {
            label: 'Toggle Developer Tools',
            accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
            click: () => this.openDevTools(),
          },
        ],
      })
    );

    // Help Menu
    this.menu.append(
      new MenuItem({
        label: 'Help',
        submenu: [
          {
            label: 'Documentation',
            click: () => this.openDocumentation(),
          },
        ],
      })
    );
  }

  checkUpdate() {
    console.log('Check Update');
  }

  settings() {
    console.log('Open Settings');
  }

  NDLSettings() {
    console.log('Open NDL Settings');
  }

  newFile() {
    console.log('Create a new file');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_new_file(); }"
    );
  }

  openFile() {
    console.log('Open an existing file');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_open_file(); }"
    );
  }

  openFolder() {
    console.log('Open a folder');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_open_folder(); }"
    );
  }

  saveFile() {
    console.log('Save the current file');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_save(); }"
    );
  }

  saveFileAs() {
    console.log('Save the current file as...');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_save(true); }"
    );
  }

  closeFile() {
    console.log('Close the current file');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_close_file(); }"
    );
  }

  closeAllFiles() {
    console.log('Close all files');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_close_all_file(); }"
    );
  }

  exitApp() {
    console.log('Exit the application');
    this.window.close();
  }

  undo() {
    console.log('Undo the last action');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_undo(); }"
    );
  }

  redo() {
    console.log('Redo the last undone action');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_redo(); }"
    );
  }

  cut() {
    console.log('Cut the selected text');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_cut(); }"
    );
  }

  copy() {
    console.log('Copy the selected text');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_copy(); }"
    );
  }

  paste() {
    console.log('Paste from clipboard');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_paste(); }"
    );
  }

  find() {
    console.log('Find text');
    this.window.webContents.executeJavaScript(
      "if (editor.keyBinding) { editor.keyBinding.control_find(); }"
    );
  }

  replace() {
    console.log('Replace text');
    this.window.webContents.executeJavaScript(
      "if (editor.keyBinding) { editor.keyBinding.control_replace(); }"
    );
  }

  unSelectAll() {
    console.log('Unselect all content');
    this.window.webContents.executeJavaScript(
        "if (editor.selectController) { editor.selectController.unSelectAll(); }"
    );
  }

  selectAll() {
    console.log('Select all content');
    this.window.webContents.executeJavaScript(
        "if (editor.keyBinding) { editor.keyBinding.control_select_all(); }"
    );
  }

  newLine() {
    console.log('Insert a new line');
    this.window.webContents.executeJavaScript(
      "if (editor.keyBinding) { editor.keyBinding.key_enter(); }"
    );
  }

  deleteLine() {
    console.log('Delete the current line');
    this.window.webContents.executeJavaScript(
      "if (editor.keyBinding) { editor.keyBinding.control_delete_line(); }"
    );
  }

  reloadWindow() {
    console.log('Reload the current window');
    this.window.reload();
  }

  toggleFullscreen() {
    const isFullscreen = this.window.isFullScreen();
    this.window.setFullScreen(!isFullscreen);
    console.log(isFullscreen ? 'Exit fullscreen mode' : 'Enter fullscreen mode');
  }

  openDevTools() {
    console.log('Open developer tools');
    this.window.webContents.openDevTools();
  }

  openDocumentation() {
    console.log('Open documentation');
  }



  showAbout() {
    console.log('Show About dialog');

    require('electron').dialog.showMessageBox(this.window, {
      type: 'info',
      title: 'About NCE',
      message: 'NCE Code Editor\nVersion 1.0.0',
    });
  }
}
