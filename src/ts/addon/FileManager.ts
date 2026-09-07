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
  type?: "file" | "folder";
  code?: string;
  error?: string;
}

export const MAX_TEXT_FILE_SIZE = 20 * 1024 * 1024;
const BINARY_SAMPLE_SIZE = 8192;
function validPath(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
function validName(value: unknown): value is string {
  return validPath(value) && !/^(?:[\\/]|[A-Za-z]:)/.test(value) &&
    value.split(/[\\/]/).every(segment => Boolean(segment) && segment !== "." && segment !== "..");
}
const invalidPath = (): FileOperationResult => ({ success: false, code: "INVALID_PATH", error: "Invalid file path or arguments." });

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  let controlBytes = 0;
  for (const byte of buffer) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes++;
  }
  return buffer.length > 0 && controlBytes / buffer.length > 0.05;
}

export class FileManager {
  window: Window;
  private fileCache: Map<string, string[]> = new Map();
  private stateSaveQueue: Promise<boolean> = Promise.resolve(true);

  constructor(window: Window) {
    this.window = window;
  }

  async agentFileOperation(root: string, operation: string, args: unknown[]) {
    const methods: Record<string, { paths: number[]; run: (...values: any[]) => Promise<any> }> = {
      saveFile: { paths: [0], run: this.saveFile.bind(this) },
      createFile: { paths: [0], run: this.createFile.bind(this) },
      createFolder: { paths: [0], run: this.createFolder.bind(this) },
      renameEntry: { paths: [0, 1], run: this.renameEntry.bind(this) },
      deleteEntry: { paths: [0], run: this.deleteEntry.bind(this) },
      copyEntry: { paths: [0, 1], run: this.copyEntry.bind(this) },
      moveEntry: { paths: [0, 1], run: this.moveEntry.bind(this) },
      duplicateEntry: { paths: [0], run: this.duplicateEntry.bind(this) },
    };
    if (!validPath(root) || !Array.isArray(args) || !Object.prototype.hasOwnProperty.call(methods, operation)) return invalidPath();
    const method = methods[operation];
    try {
      const realRoot = await fs.realpath(root);
      const inside = (base: string, target: string) => {
        const relative = path.relative(base, target);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      };
      const targets = method.paths.map(index => args[index]);
      if (operation === "createFile" || operation === "createFolder") {
        if (!validName(args[1]) || !validPath(args[0])) return invalidPath();
        targets.push(path.join(args[0], args[1]));
      }
      for (const target of targets) {
        if (!validPath(target)) return invalidPath();
        let existing = path.resolve(target);
        while (!fsSync.existsSync(existing)) {
          const parent = path.dirname(existing);
          if (parent === existing) return invalidPath();
          existing = parent;
        }
        if (!inside(realRoot, await fs.realpath(existing)) || !inside(path.resolve(root), path.resolve(target))) {
          return { success: false, code: "OUTSIDE_WORKSPACE", error: "Path must remain inside the workspace." };
        }
      }
      return await method.run(...args);
    } catch { return invalidPath(); }
  }

  handleIPC() {
    ipcMain.handle("Agent:fileOperation", (_event, root, operation, args) => this.agentFileOperation(root, operation, args));
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
      return undefined;
    }

    return result.filePaths[0];
  }

  async selectFiles(): Promise<string[] | undefined> {
    if (!this.window.window) return undefined;

    const result = await dialog.showOpenDialog(this.window.window, {
      properties: ["openFile", "multiSelections"],
    });

    if (result.canceled) {
      return undefined;
    }

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
      return undefined;
    }

    return result.filePath || undefined;
  }

  async getFileContent(file: string[]): Promise<{} | undefined> {
    if (!Array.isArray(file) || !file.every(validPath)) {
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
    if (!validPath(filePath) || typeof content !== "string") {
      return undefined;
    }
    try {
      const dir = path.dirname(filePath);

      await fs.mkdir(dir, {
        recursive: true,
      });

      this.window.watcher?.ignoreNextChange(filePath);

      await fs.writeFile(filePath, content);
      this.clearFileCache(filePath);


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
      if (
        typeof oldPath !== "string" ||
        typeof newPath !== "string" ||
        !validPath(oldPath) ||
        !validPath(newPath)
      ) {
        return {
          success: false,
          code: "INVALID_PATH",
          error: "Les chemins de renommage sont invalides.",
        };
      }
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
      if (!fsSync.existsSync(path.dirname(newPath))) {
        return {
          success: false,
          code: "PARENT_NOT_FOUND",
          error: "Le dossier de destination n'existe pas.",
        };
      }
      await fs.rename(oldPath, newPath);
      this.clearFileCache(oldPath);
      this.clearFileCache(newPath);
      return {
        success: true,
        path: newPath,
        type: sourceStats.isDirectory() ? "folder" : "file",
      };
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
    if (!validPath(targetPath) || path.resolve(targetPath) === path.parse(path.resolve(targetPath)).root) return invalidPath();
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
    if (!validPath(dirPath) || !validName(fileName) || typeof content !== "string" || typeof overwrite !== "boolean") return invalidPath();
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
    if (!validPath(dirPath) || !validName(folderName)) return invalidPath();
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
    if (!validPath(sourcePath) || !validPath(destPath)) return invalidPath();
    if (fsSync.existsSync(destPath)) return { success: false, code: "DESTINATION_EXISTS" };
    try {
      await fs.cp(sourcePath, destPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      this.clearFileCache(destPath);
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
    if (!validPath(sourcePath) || !validPath(destPath)) return invalidPath();
    if (fsSync.existsSync(destPath)) return { success: false, code: "DESTINATION_EXISTS" };
    try {
      await fs.rename(sourcePath, destPath);
      this.clearFileCache(sourcePath);
      this.clearFileCache(destPath);
      return { success: true, path: destPath };
    } catch (error: any) {
      if (error?.code === "EXDEV") {
        try {
          await fs.cp(sourcePath, destPath, { recursive: true, force: false, errorOnExist: true });
          await fs.rm(sourcePath, { recursive: true, force: true });
          this.clearFileCache(sourcePath);
          this.clearFileCache(destPath);
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
    if (!validPath(targetPath) || path.resolve(targetPath) === path.parse(path.resolve(targetPath)).root) return invalidPath();
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
      this.clearFileCache(candidate);
      return { success: true, path: candidate };
    } catch (error: any) {
      console.error("Error duplicating entry:", error);
      return { success: false, error: error?.message || "Duplicate failed." };
    }
  }

  async initializeFile(
    filePath: string,
  ): Promise<{
    success: boolean;
    totalLines: number;
    errorCode?: string;
    size?: number;
    maxSize?: number;
    eol?: string;
    hasFinalNewline?: boolean;
    maxLineLength?: number;
    incrementalEligible?: boolean;
    lineEndings?: string[];
  }> {
    try {
      if (!validPath(filePath)) return { success: false, totalLines: 0, errorCode: "INVALID_PATH" };
      const stats = await fs.stat(filePath);
      if (stats.size > MAX_TEXT_FILE_SIZE) {
        return {
          success: false,
          totalLines: 0,
          errorCode: "FILE_TOO_LARGE",
          size: stats.size,
          maxSize: MAX_TEXT_FILE_SIZE,
        };
      }

      const sample = await fs.open(filePath, "r");
      const sampleBuffer = Buffer.alloc(Math.min(BINARY_SAMPLE_SIZE, stats.size));
      await sample.read(sampleBuffer, 0, sampleBuffer.length, 0);
      await sample.close();
      if (looksBinary(sampleBuffer)) {
        return { success: false, totalLines: 0, errorCode: "BINARY_FILE", size: stats.size };
      }

      const content = decodeUtf8(await fs.readFile(filePath));
      const hasFinalNewline = /(?:\r\n|\n)$/.test(content);
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lineEndings = [...content.matchAll(/\r\n|\n/g)].map(
        (match) => match[0],
      );
      const lines = content.split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      this.fileCache.set(filePath, lines);
      const maxLineLength = lines.reduce(
        (maximum, line) => Math.max(maximum, line.length),
        0,
      );

      return {
        success: true,
        totalLines: lines.length,
        size: stats.size,
        eol,
        hasFinalNewline,
        maxLineLength,
        incrementalEligible:
          stats.size <= 1024 * 1024 && maxLineLength <= 1000,
        lineEndings,
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
      if (!validPath(filePath) || !Number.isInteger(startLine) || startLine < 0 ||
          !Number.isInteger(lineCount) || lineCount < 0) return { success: false, lines: [] };
      const safeStartLine = startLine;
      const safeLineCount = lineCount;
      const cachedLines = this.fileCache.get(filePath);
      // Never splice a new disk version into an existing partial load.
      if (!cachedLines) return { success: false, lines: [] };

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
      const normalized = path.normalize(filePath);
      for (const cachedPath of this.fileCache.keys()) {
        const normalizedCached = path.normalize(cachedPath);
        if (
          normalizedCached === normalized ||
          normalizedCached.startsWith(`${normalized}${path.sep}`)
        ) {
          this.fileCache.delete(cachedPath);
        }
      }
    } else {
      this.fileCache.clear();
    }
  }

  saveState(stateString: string): Promise<boolean> {
    const next = this.stateSaveQueue.catch(() => false).then(() => this.writeState(stateString));
    this.stateSaveQueue = next;
    return next;
  }

  private async writeState(stateString: string): Promise<boolean> {
    try {
      const filePath = path.join(app.getPath("userData"), "state.json");
      if (typeof stateString !== "string") return false;
      const state = JSON.parse(stateString);
      if (!state || typeof state !== "object" || Array.isArray(state)) return false;
      if (state.agent) delete state.agent.apiKeys;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(`${filePath}.tmp`, JSON.stringify(state), "utf-8");
      await fs.rename(`${filePath}.tmp`, filePath);

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

  private encryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable() &&
      safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  }

  private async readAgentSecrets(): Promise<Record<string, string>> {
    if (!this.encryptionAvailable()) return {};
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
    if (typeof providerId !== "string" || !this.encryptionAvailable())
      return "";
    const secrets = await this.readAgentSecrets();
    try {
      return safeStorage.decryptString(Buffer.from(secrets[providerId], "base64"));
    } catch {
      return "";
    }
  }

  private async setAgentApiKey(providerId: string, apiKey: string): Promise<boolean> {
    if (typeof providerId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(providerId) ||
        typeof apiKey !== "string" || !this.encryptionAvailable()) return false;
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
