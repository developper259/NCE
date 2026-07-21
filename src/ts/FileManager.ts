import { app, dialog, BrowserWindow } from "electron";
const fs = require("fs").promises;
const path = require("path");

export type UnsavedCloseChoice = "save" | "dontSave" | "cancel";

export interface FileItem {
  name: string;
  path: string;
  type: "file" | "folder";
}

export class FileManager {
  window: InstanceType<typeof BrowserWindow>;
  private fileCache: Map<string, string[]> = new Map();

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  async selectFile(): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(this.window, {
      properties: ["openFile"],
    });
    if (result.canceled) {
      console.log("User cancelled the file selection.");
      return undefined;
    }

    console.log("Selected file paths:", result.filePaths[0]);
    return result.filePaths[0];
  }

  async selectFiles(): Promise<string[] | undefined> {
    const result = await dialog.showOpenDialog(this.window, {
      properties: ["openFile", "multiSelections"],
    });

    if (result.canceled) {
      console.log("User cancelled the files selection.");
      return undefined;
    }

    console.log("Selected file paths:", result.filePaths);
    return result.filePaths;
  }

  async selectNewFile(name: string): Promise<string | undefined> {
    const result = await dialog.showSaveDialog(this.window, {
      title: "Save File",
      defaultPath: name,
      buttonLabel: "Save",
    });

    if (result.canceled) {
      console.log("User cancelled the save file dialog.");
      return undefined;
    }

    console.log("File path selected for saving:", result.filePath);
    return result.filePath || undefined;
  }

  async getFileContent(file: string[]): Promise<{} | undefined> {
    if (!file) {
      console.log("No file selected.");
      return Promise.resolve(undefined);
    }
    const fileContents: { [key: string]: string } = {};

    for (const filePath of file) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        fileContents[filePath] = content;
      } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
      }
    }

    return fileContents;
  }

  async saveFile(
    filePath: string,
    content: string,
  ): Promise<string | undefined> {
    try {
      const dir = path.dirname(filePath);

      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(filePath, content);
      console.log("File saved successfully:", filePath);
      return filePath;
    } catch (error) {
      console.error("Error saving file:", error);
    }
    return undefined;
  }

  async confirmUnsavedChanges(fileName: string): Promise<UnsavedCloseChoice> {
    const { response } = await dialog.showMessageBox(this.window, {
      type: "warning",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `Do you want to save the changes you made to "${fileName}"?`,
      detail: "Your changes will be lost if you don't save them.",
    });

    if (response === 0) return "save";
    if (response === 1) return "dontSave";
    return "cancel";
  }

  async getFolderContent(dirPath: string): Promise<FileItem[]> {
    if (!dirPath) return [];
    try {
      const entries = await fs.readdir(dirPath);

      const items = await Promise.all(
        entries.map(async (entry: string): Promise<FileItem> => {
          const fullPath = path.join(dirPath, entry);
          const stats = await fs.stat(fullPath);
          return {
            name: entry,
            path: fullPath,
            type: stats.isDirectory() ? "folder" : "file",
          };
        }),
      );

      return items.sort((a, b) => {
        if (a.type === b.type) {
          return a.name.localeCompare(b.name);
        }
        return a.type === "folder" ? -1 : 1;
      });
    } catch (error) {
      console.error("Erreur lors de la lecture du dossier :", error);
      return [];
    }
  }

  async selectFolder(): Promise<string | undefined> {
    const { canceled, filePaths } = await dialog.showOpenDialog(this.window, {
      properties: ["openDirectory"],
    });

    if (canceled || filePaths.length === 0) {
      return undefined;
    }

    return filePaths[0];
  }

  async initializeFile(
    filePath: string,
  ): Promise<{ success: boolean; totalLines: number }> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      this.fileCache.set(filePath, lines);

      return {
        success: true,
        totalLines: lines.length,
      };
    } catch (error) {
      console.error("Error initializing file:", error);
      return {
        success: false,
        totalLines: 0,
      };
    }
  }

  async getFileChunk(
    filePath: string,
    startLine: number,
    lineCount: number,
  ): Promise<{ success: boolean; lines: string[] }> {
    try {
      const cachedLines = this.fileCache.get(filePath);

      if (!cachedLines) {
        return {
          success: false,
          lines: [],
        };
      }

      const endLine = Math.min(startLine + lineCount, cachedLines.length);
      const lines = cachedLines.slice(startLine, endLine);

      return {
        success: true,
        lines,
      };
    } catch (error) {
      console.error("Error getting file chunk:", error);
      return {
        success: false,
        lines: [],
      };
    }
  }

  clearFileCache(filePath?: string) {
    if (filePath) {
      this.fileCache.delete(filePath);
    } else {
      this.fileCache.clear();
    }
  }

  async saveState(stateString: string): Promise<boolean> {
    try {
      const filePath = path.join(app.getPath("userData"), "state.json");
      await fs.writeFile(filePath, stateString, "utf-8");
      console.log("Editor state saved !");
      return true;
    } catch (error) {
      console.error("Error saving editor state:", error);
      return false;
    }
  }

  async loadState(): Promise<object | null> {
    try {
      const filePath = path.join(app.getPath("userData"), "state.json");
      const content = await fs.readFile(filePath, "utf-8");
      const trimmed = content.trim();
      if (!trimmed || trimmed === "{}") return null;

      const state = JSON.parse(trimmed);
      if (
        !state ||
        typeof state !== "object" ||
        Object.keys(state).length === 0
      ) {
        return null;
      }
      console.log("Editor state loaded !");
      return state;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      console.error("Error loading editor state:", error);
      return null;
    }
  }
}
