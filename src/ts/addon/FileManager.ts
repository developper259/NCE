import { app, dialog, shell, BrowserWindow, ipcMain, safeStorage } from "electron";
import { Window } from "../Window";
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");

export type UnsavedCloseChoice = "save" | "dontSave" | "cancel";

export interface FileItem {
  name: string;
  path: string;
  type: "file" | "folder";
}

export interface FileOperationResult {
  success: boolean;
  path?: string;
  code?: string;
  error?: string;
}

export class FileManager {
  window: Window;
  private fileCache: Map<string, string[]> = new Map();

  constructor(window: Window) {
    this.window = window;
  }

  handleIPC() {
    ipcMain.handle("FileManager:selectFile", async () => {
      return await this.selectFile();
    });

    ipcMain.handle("FileManager:selectFiles", async () => {
      return await this.selectFiles();
    });

    ipcMain.handle("FileManager:selectNewFile", async (event, name) => {
      return await this.selectNewFile(name);
    });

    ipcMain.handle("FileManager:getFileContent", async (event, file) => {
      return await this.getFileContent(file);
    });

    ipcMain.handle("FileManager:saveFile", async (event, path, content) => {
      return await this.saveFile(path, content);
    });

    ipcMain.handle(
      "FileManager:confirmUnsavedChanges",
      async (event, fileName: string) => {
        if (!this.window.window) return "cancel";
        return await this.confirmUnsavedChanges(fileName);
      },
    );

    ipcMain.handle(
      "FileManager:getFolderContent",
      async (event, dirPath: string) => {
        return await this.getFolderContent(dirPath);
      },
    );

    ipcMain.handle("FileManager:selectFolder", async () => {
      return await this.selectFolder();
    });

    ipcMain.handle(
      "FileManager:initializeFile",
      async (event, filePath: string) => {
        return await this.initializeFile(filePath);
      },
    );

    ipcMain.handle(
      "FileManager:getFileChunk",
      async (event, filePath: string, startLine: number, lineCount: number) => {
        return await this.getFileChunk(filePath, startLine, lineCount);
      },
    );

    ipcMain.handle(
      "FileManager:saveState",
      async (event, stateString: string) => {
        const saved = await this.saveState(stateString);
        if (this.window.forceQuit) {
          this.window.window?.close();
        }
        return saved;
      },
    );

    ipcMain.handle("FileManager:loadState", async () => {
      return (await this.loadState()) ?? null;
    });

    ipcMain.handle(
      "FileManager:getAgentApiKey",
      async (_event, providerId: string) => this.getAgentApiKey(providerId),
    );

    ipcMain.handle(
      "FileManager:setAgentApiKey",
      async (_event, providerId: string, apiKey: string) =>
        this.setAgentApiKey(providerId, apiKey),
    );

    ipcMain.handle(
      "FileManager:rename",
      async (event, oldPath: string, newPath: string) => {
        return await this.renameEntry(oldPath, newPath);
      },
    );

    ipcMain.handle("FileManager:delete", async (event, targetPath: string) => {
      return await this.deleteEntry(targetPath);
    });

    ipcMain.handle(
      "FileManager:createFile",
      async (
        event,
        dirPath: string,
        fileName: string,
        content: string = "",
        overwrite: boolean = false,
      ) => {
        return await this.createFile(dirPath, fileName, content, overwrite);
      },
    );

    ipcMain.handle(
      "FileManager:createFolder",
      async (event, dirPath: string, folderName: string) => {
        return await this.createFolder(dirPath, folderName);
      },
    );

    ipcMain.handle(
      "FileManager:copy",
      async (event, sourcePath: string, destPath: string) => {
        return await this.copyEntry(sourcePath, destPath);
      },
    );

    ipcMain.handle(
      "FileManager:move",
      async (event, sourcePath: string, destPath: string) => {
        return await this.moveEntry(sourcePath, destPath);
      },
    );

    ipcMain.handle(
      "FileManager:duplicate",
      async (event, targetPath: string) => {
        return await this.duplicateEntry(targetPath);
      },
    );

    ipcMain.handle(
      "FileManager:revealInExplorer",
      async (event, targetPath: string) => {
        shell.showItemInFolder(targetPath);
        return { success: true };
      },
    );

    ipcMain.handle(
      "FileManager:pathExists",
      async (event, targetPath: string) => {
        return fsSync.existsSync(targetPath);
      },
    );
  }

  async selectFile(): Promise<string | undefined> {
    if (!this.window.window) return undefined;

    const result = await dialog.showOpenDialog(this.window.window, {
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
    if (!this.window.window) return undefined;

    const result = await dialog.showOpenDialog(this.window.window, {
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
    if (!this.window.window) return undefined;

    const result = await dialog.showSaveDialog(this.window.window, {
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

      await fs.mkdir(dir, {
        recursive: true,
      });

      this.window.watcher?.ignoreNextChange(filePath);

      await fs.writeFile(filePath, content);
      this.clearFileCache(filePath);

      console.log("File saved successfully:", filePath);

      return filePath;
    } catch (error) {
      console.error("Error saving file:", error);
    }

    return undefined;
  }

  async confirmUnsavedChanges(fileName: string): Promise<UnsavedCloseChoice> {
    if (!this.window.window) return "cancel";

    const { response } = await dialog.showMessageBox(this.window.window, {
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
    if (!this.window.window) return undefined;

    const { canceled, filePaths } = await dialog.showOpenDialog(
      this.window.window,
      {
        properties: ["openDirectory"],
      },
    );

    if (canceled || filePaths.length === 0) {
      return undefined;
    }

    return filePaths[0];
  }

  async renameEntry(
    oldPath: string,
    newPath: string,
  ): Promise<FileOperationResult> {
    try {
      if (!fsSync.existsSync(oldPath)) {
        return {
          success: false,
          code: "FILE_NOT_FOUND",
          error: "Le fichier source n'existe pas.",
        };
      }
      if (fsSync.existsSync(newPath)) {
        return {
          success: false,
          code: "DESTINATION_EXISTS",
          error: "Un fichier ou dossier portant ce nom existe déjà.",
        };
      }
      const sourceStats = await fs.stat(oldPath);
      if (!sourceStats.isFile()) {
        return {
          success: false,
          code: "NOT_A_FILE",
          error: "La source n'est pas un fichier.",
        };
      }
      if (!fsSync.existsSync(path.dirname(newPath))) {
        return {
          success: false,
          code: "PARENT_NOT_FOUND",
          error: "Le dossier de destination n'existe pas.",
        };
      }
      await fs.rename(oldPath, newPath);
      this.clearFileCache(oldPath);
      return { success: true, path: newPath };
    } catch (error: any) {
      console.error("Error renaming entry:", error);
      return {
        success: false,
        code:
          error?.code === "EACCES" || error?.code === "EPERM"
            ? "PERMISSION_DENIED"
            : "RENAME_FAILED",
        error: error?.message || "Rename failed.",
      };
    }
  }

  async deleteEntry(targetPath: string): Promise<FileOperationResult> {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      this.clearFileCache(targetPath);
      return { success: true };
    } catch (error: any) {
      console.error("Error deleting entry:", error);
      return { success: false, error: error?.message || "Delete failed." };
    }
  }

  async createFile(
    dirPath: string,
    fileName: string,
    content: string = "",
    overwrite: boolean = false,
  ): Promise<FileOperationResult> {
    const fullPath = path.join(dirPath, fileName);
    try {
      if (fsSync.existsSync(fullPath) && !overwrite) {
        return {
          success: false,
          code: "FILE_ALREADY_EXISTS",
          error: "Ce fichier existe déjà.",
        };
      }
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(
        fullPath,
        content,
        overwrite ? undefined : { flag: "wx" },
      );
      this.clearFileCache(fullPath);
      return { success: true, path: fullPath };
    } catch (error: any) {
      console.error("Error creating file:", error);
      return {
        success: false,
        code:
          error?.code === "EEXIST"
            ? "FILE_ALREADY_EXISTS"
            : error?.code === "EACCES" || error?.code === "EPERM"
              ? "PERMISSION_DENIED"
              : "CREATE_FAILED",
        error: error?.message || "Create file failed.",
      };
    }
  }

  async createFolder(
    dirPath: string,
    folderName: string,
  ): Promise<FileOperationResult> {
    const fullPath = path.join(dirPath, folderName);
    try {
      if (fsSync.existsSync(fullPath)) {
        return { success: false, error: "Ce dossier existe déjà." };
      }
      await fs.mkdir(fullPath, { recursive: true });
      return { success: true, path: fullPath };
    } catch (error: any) {
      console.error("Error creating folder:", error);
      return {
        success: false,
        error: error?.message || "Create folder failed.",
      };
    }
  }

  async copyEntry(
    sourcePath: string,
    destPath: string,
  ): Promise<FileOperationResult> {
    try {
      await fs.cp(sourcePath, destPath, {
        recursive: true,
        errorOnExist: true,
      });
      return { success: true, path: destPath };
    } catch (error: any) {
      console.error("Error copying entry:", error);
      return { success: false, error: error?.message || "Copy failed." };
    }
  }

  async moveEntry(
    sourcePath: string,
    destPath: string,
  ): Promise<FileOperationResult> {
    try {
      await fs.rename(sourcePath, destPath);
      this.clearFileCache(sourcePath);
      return { success: true, path: destPath };
    } catch (error: any) {
      if (error?.code === "EXDEV") {
        try {
          await fs.cp(sourcePath, destPath, { recursive: true });
          await fs.rm(sourcePath, { recursive: true, force: true });
          this.clearFileCache(sourcePath);
          return { success: true, path: destPath };
        } catch (fallbackError: any) {
          console.error("Error moving entry (fallback):", fallbackError);
          return {
            success: false,
            error: fallbackError?.message || "Move failed.",
          };
        }
      }
      console.error("Error moving entry:", error);
      return { success: false, error: error?.message || "Move failed." };
    }
  }

  async duplicateEntry(targetPath: string): Promise<FileOperationResult> {
    try {
      const dir = path.dirname(targetPath);
      const ext = path.extname(targetPath);
      const base = path.basename(targetPath, ext);

      let candidate = path.join(dir, `${base} copy${ext}`);
      let counter = 2;
      while (fsSync.existsSync(candidate)) {
        candidate = path.join(dir, `${base} copy ${counter}${ext}`);
        counter += 1;
      }

      await fs.cp(targetPath, candidate, { recursive: true });
      return { success: true, path: candidate };
    } catch (error: any) {
      console.error("Error duplicating entry:", error);
      return { success: false, error: error?.message || "Duplicate failed." };
    }
  }

  async initializeFile(
    filePath: string,
  ): Promise<{ success: boolean; totalLines: number; errorCode?: string }> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      this.fileCache.set(filePath, lines);

      return {
        success: true,
        totalLines: lines.length,
      };
    } catch (error: any) {
      console.error("Error initializing file:", error);
      return {
        success: false,
        totalLines: 0,
        errorCode: error?.code || "UNKNOWN",
      };
    }
  }

  async getFileChunk(
    filePath: string,
    startLine: number,
    lineCount: number,
  ): Promise<{ success: boolean; lines: string[] }> {
    try {
      const safeStartLine = Math.max(0, Number.isFinite(startLine) ? startLine : 0);
      const safeLineCount = Math.max(0, Number.isFinite(lineCount) ? lineCount : 0);
      let cachedLines = this.fileCache.get(filePath);

      if (!cachedLines) {
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const loadedLines: string[] = content.split(/\r?\n/);
          if (loadedLines.length > 0 && loadedLines[loadedLines.length - 1] === "") {
            loadedLines.pop();
          }
          cachedLines = loadedLines;
          this.fileCache.set(filePath, loadedLines);
        } catch (error) {
          console.error("Error loading file into cache for chunk request:", error);
          return {
            success: false,
            lines: [],
          };
        }
      }

      if (!cachedLines) {
        return {
          success: false,
          lines: [],
        };
      }

      const endLine = Math.min(safeStartLine + safeLineCount, cachedLines.length);
      const lines = cachedLines.slice(safeStartLine, endLine);

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

      const legacyKeys = (state as any).agent?.apiKeys;
      if (legacyKeys && typeof legacyKeys === "object") {
        for (const [providerId, apiKey] of Object.entries(legacyKeys)) {
          if (typeof apiKey === "string" && apiKey.trim()) {
            await this.setAgentApiKey(providerId, apiKey);
          }
        }
        delete (state as any).agent.apiKeys;
        await fs.writeFile(filePath, JSON.stringify(state), "utf-8");
      }

      return state;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      console.error("Error loading editor state:", error);
      return null;
    }
  }

  private getSecretsPath(): string {
    return path.join(app.getPath("userData"), "agent-secrets.json");
  }

  private async readAgentSecrets(): Promise<Record<string, string>> {
    if (!safeStorage.isEncryptionAvailable()) return {};
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.getSecretsPath(), "utf-8"),
      );
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async getAgentApiKey(providerId: string): Promise<string> {
    if (typeof providerId !== "string" || !safeStorage.isEncryptionAvailable())
      return "";
    const secrets = await this.readAgentSecrets();
    try {
      return safeStorage.decryptString(Buffer.from(secrets[providerId], "base64"));
    } catch {
      return "";
    }
  }

  private async setAgentApiKey(providerId: string, apiKey: string): Promise<boolean> {
    if (!providerId || !safeStorage.isEncryptionAvailable()) return false;
    const secrets = await this.readAgentSecrets();
    if (apiKey) {
      secrets[providerId] = safeStorage.encryptString(apiKey).toString("base64");
    } else {
      delete secrets[providerId];
    }
    await fs.mkdir(path.dirname(this.getSecretsPath()), { recursive: true });
    await fs.writeFile(this.getSecretsPath(), JSON.stringify(secrets), "utf-8");
    return true;
  }
}
