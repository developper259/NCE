import {
  app,
  dialog,
  shell,
  BrowserWindow,
  ipcMain,
  safeStorage,
} from "electron";
import { Window } from "../Window";
import { NceWorkspaceStorage } from "./NceWorkspaceStorage";
import { LargeFileStore } from "./LargeFileStore";
import {
  DirtyBufferRecoveryStore,
  type DirtyBufferRecoveryInput,
} from "./DirtyBufferRecovery";
import {
  BINARY_SAMPLE_SIZE,
  IMAGE_MIME_TYPES,
  looksBinary,
  MAX_IMAGE_FILE_SIZE,
} from "./OpenableFile";
export { MAX_IMAGE_FILE_SIZE } from "./OpenableFile";
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

function statOpaqueEntry(filePath: string): Promise<any> {
  try {
    return require("original-fs").promises.stat(filePath);
  } catch {
    return fs.stat(filePath);
  }
}

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
  forced?: boolean;
  code?: string;
  error?: string;
}

export const LARGE_FILE_MODE_THRESHOLD = 20 * 1024 * 1024;
// Kept as an alias for older imports. This is a mode threshold, not an open limit.
export const MAX_TEXT_FILE_SIZE = LARGE_FILE_MODE_THRESHOLD;
const RETRYABLE_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [0, 20, 50, 100];
export interface MarkdownImageReadContext {
  sourcePath: string;
  workspaceRoot?: string | null;
}

function pathImplementation(value: string): typeof path {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\")
    ? path.win32
    : path;
}

function isPathInside(basePath: string, targetPath: string, pathApi: typeof path): boolean {
  const relative = pathApi.relative(basePath, targetPath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

/** Resolve a README image without allowing absolute paths or leaving its root. */
export function resolveMarkdownImagePath(
  sourcePathValue: unknown,
  imageReferenceValue: unknown,
  workspaceRootValue?: unknown,
): { sourcePath: string; workspaceRoot: string; imagePath: string } | null {
  if (!validPath(sourcePathValue) || !validPath(imageReferenceValue)) return null;
  const sourcePath = sourcePathValue.trim();
  const imageReference = imageReferenceValue.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(imageReference) ||
      /^(?:[\\/]|[a-z]:[\\/]|~)/i.test(imageReference) ||
      /[\u0000-\u001f\u007f?#]/.test(imageReference)) return null;

  const pathApi = pathImplementation(sourcePath);
  if (!pathApi.isAbsolute(sourcePath)) return null;
  const resolvedSourcePath = pathApi.resolve(sourcePath);
  const workspaceRoot = validPath(workspaceRootValue)
    ? pathApi.resolve(workspaceRootValue.trim())
    : pathApi.dirname(resolvedSourcePath);
  if (!pathApi.isAbsolute(workspaceRoot) ||
      !isPathInside(workspaceRoot, resolvedSourcePath, pathApi)) return null;

  const imagePath = pathApi.resolve(pathApi.dirname(resolvedSourcePath), imageReference);
  if (!isPathInside(workspaceRoot, imagePath, pathApi)) return null;
  return { sourcePath: resolvedSourcePath, workspaceRoot, imagePath };
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}
function isAsarPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".asar";
}
function validName(value: unknown): value is string {
  return (
    validPath(value) &&
    !/^(?:[\\/]|[A-Za-z]:)/.test(value) &&
    value
      .split(/[\\/]/)
      .every(
        (segment) => Boolean(segment) && segment !== "." && segment !== "..",
      )
  );
}
export function validateEntryName(
  value: unknown,
  platform: NodeJS.Platform = typeof process === "undefined"
    ? "linux"
    : process.platform,
): string | null {
  if (typeof value !== "string" || !value.trim()) return "INVALID_NAME";
  if (value !== value.trim() || value === "." || value === "..")
    return "INVALID_NAME";
  if (/[\\/\0]/.test(value)) return "INVALID_NAME";
  if (platform === "win32") {
    if (/[<>:\"|?*]/.test(value) || /[. ]$/.test(value)) return "INVALID_NAME";
    const stem = value.split(".")[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem))
      return "INVALID_NAME";
  }
  return null;
}
const invalidPath = (): FileOperationResult => ({
  success: false,
  code: "INVALID_PATH",
  error: "Invalid file path or arguments.",
});

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  operations: any = fs,
): Promise<void> {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const makeSiblingTempPath = () => path.join(
    dir,
    `.${basename}.nce-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let temporaryPath = makeSiblingTempPath();
  let backupPath = "";
  let preserveTemporary = false;
  let preserveBackup = false;
  let targetExisted = false;
  let targetIsSymbolicLink = false;
  let originalMode: number | undefined;
  try {
    try {
      targetIsSymbolicLink = (await operations.lstat(filePath)).isSymbolicLink();
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      const stats = await operations.stat(filePath);
      targetExisted = true;
      originalMode = stats.mode;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }

    const handle = await operations.open(temporaryPath, "wx", originalMode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    let renameError: any = null;
    for (const delayMs of RENAME_RETRY_DELAYS_MS) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await operations.rename(temporaryPath, filePath);
        temporaryPath = "";
        renameError = null;
        break;
      } catch (error: any) {
        renameError = error;
        if (!RETRYABLE_RENAME_ERRORS.has(error?.code)) throw error;
      }
    }

    if (temporaryPath && renameError) {
      if (targetIsSymbolicLink) {
        preserveTemporary = true;
        throw Object.assign(
          new Error(`Atomic rename failed (${renameError.code}); copy fallback was skipped because the destination is a symbolic link. Complete recovery file: ${temporaryPath}`),
          { code: "SAVE_REPLACEMENT_FAILED", cause: renameError, renameError, temporaryPath },
        );
      }

      let originalBytes: Buffer | null = null;
      if (targetExisted) {
        backupPath = makeSiblingTempPath();
        try {
          originalBytes = Buffer.from(await operations.readFile(filePath));
          const backupHandle = await operations.open(backupPath, "wx", originalMode);
          try {
            await backupHandle.writeFile(originalBytes);
            await backupHandle.sync();
          } finally {
            await backupHandle.close();
          }
          const backupBytes = Buffer.from(await operations.readFile(backupPath));
          if (!backupBytes.equals(originalBytes)) {
            throw Object.assign(new Error("Backup verification failed"), { code: "SAVE_BACKUP_VERIFY_FAILED" });
          }
        } catch (error: any) {
          try { await operations.unlink(backupPath); } catch {}
          backupPath = "";
          preserveTemporary = true;
          throw Object.assign(
            new Error(`Atomic rename failed (${renameError.code}); could not preserve the original file before copy fallback. Complete recovery file: ${temporaryPath}`),
            { code: "SAVE_REPLACEMENT_FAILED", cause: error, renameError, temporaryPath },
          );
        }
      }

      try {
        await operations.copyFile(temporaryPath, filePath);
        const written = await operations.readFile(filePath, "utf8");
        if (written !== content) {
          throw Object.assign(new Error("Destination verification failed after copy fallback"), { code: "SAVE_VERIFY_FAILED" });
        }
      } catch (fallbackError: any) {
        let restoreError: any = null;
        if (backupPath && originalBytes) {
          try {
            await operations.copyFile(backupPath, filePath);
            const restored = Buffer.from(await operations.readFile(filePath));
            if (!restored.equals(originalBytes)) {
              throw Object.assign(new Error("Original file verification failed after restore"), { code: "SAVE_RESTORE_VERIFY_FAILED" });
            }
          } catch (error: any) {
            restoreError = error;
            preserveBackup = true;
          }
        }

        preserveTemporary = true;
        const recovery = restoreError
          ? ` Original restore also failed; preserve backup: ${backupPath}.`
          : backupPath
            ? " The original file was restored."
            : " The destination may be incomplete; the complete recovery file is preserved.";
        throw Object.assign(
          new Error(`Atomic rename failed (${renameError.code}); copy fallback failed (${fallbackError?.code || "UNKNOWN"}). Complete recovery file: ${temporaryPath}.${recovery}`),
          {
            code: "SAVE_REPLACEMENT_FAILED",
            cause: fallbackError,
            renameError,
            fallbackError,
            restoreError,
            temporaryPath,
            ...(preserveBackup ? { backupPath } : {}),
          },
        );
      }

      console.warn("[NCE Save] Atomic rename failed; verified copy fallback succeeded", {
        path: filePath,
        code: renameError.code,
      });
      try { await operations.unlink(temporaryPath); } catch {}
      temporaryPath = "";
      if (backupPath) {
        try { await operations.unlink(backupPath); } catch {}
        backupPath = "";
      }
    }

    // Persisting the directory entry is supported on POSIX. Some platforms,
    // notably Windows, reject directory handles; that best-effort flush must
    // not turn an otherwise successful replacement into a failed save.
    try {
      const directory = await operations.open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {}
  } finally {
    if (temporaryPath && !preserveTemporary) {
      try {
        await operations.unlink(temporaryPath);
      } catch {}
    }
    if (backupPath && !preserveBackup) {
      try {
        await operations.unlink(backupPath);
      } catch {}
    }
  }
}

export class FileManager {
  window: Window;
  private fileCache: Map<string, string[]> = new Map();
  private largeFileStore = new LargeFileStore();
  private stateSaveQueue: Promise<boolean> = Promise.resolve(true);
  private workspaceStateSaveQueues: Map<string, Promise<boolean>> = new Map();
  private recoveryStores: Map<string, DirtyBufferRecoveryStore> = new Map();
  private recoveryStoreLoads: Map<string, Promise<DirtyBufferRecoveryStore | null>> = new Map();

  constructor(window: Window) {
    this.window = window;
  }

  async agentFileOperation(root: string, operation: string, args: unknown[]) {
    const methods: Record<
      string,
      { paths: number[]; run: (...values: any[]) => Promise<any> }
    > = {
      saveFile: { paths: [0], run: this.saveFile.bind(this) },
      createFile: { paths: [0], run: this.createFile.bind(this) },
      createFolder: { paths: [0], run: this.createFolder.bind(this) },
      renameEntry: { paths: [0, 1], run: this.renameEntry.bind(this) },
      deleteEntry: { paths: [0], run: this.deleteEntry.bind(this) },
      copyEntry: { paths: [0, 1], run: this.copyEntry.bind(this) },
      moveEntry: { paths: [0, 1], run: this.moveEntry.bind(this) },
      duplicateEntry: { paths: [0], run: this.duplicateEntry.bind(this) },
    };
    if (
      !validPath(root) ||
      !Array.isArray(args) ||
      !Object.prototype.hasOwnProperty.call(methods, operation)
    )
      return invalidPath();
    const method = methods[operation];
    try {
      const realRoot = await fs.realpath(root);
      const inside = (base: string, target: string) => {
        const relative = path.relative(base, target);
        return (
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      };
      const targets = method.paths.map((index) => args[index]);
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
        if (
          !inside(realRoot, await fs.realpath(existing)) ||
          !inside(path.resolve(root), path.resolve(target))
        ) {
          return {
            success: false,
            code: "OUTSIDE_WORKSPACE",
            error: "Path must remain inside the workspace.",
          };
        }
      }
      return await method.run(...args);
    } catch {
      return invalidPath();
    }
  }

  handleIPC() {
    ipcMain.handle("Agent:fileOperation", (_event, root, operation, args) =>
      this.agentFileOperation(root, operation, args),
    );
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
      "FileManager:saveRecoverySnapshot",
      async (_event, root: string | null, snapshot: unknown) =>
        this.saveRecoverySnapshot(root, snapshot),
    );
    ipcMain.handle(
      "FileManager:listRecoverySnapshots",
      async (_event, root: string | null) =>
        (await this.getRecoveryStore(root))?.list() || [],
    );
    ipcMain.handle(
      "FileManager:readRecoverySnapshot",
      async (_event, root: string | null, id: string) =>
        (await this.getRecoveryStore(root))?.read(id) || null,
    );
    ipcMain.handle(
      "FileManager:deleteRecoverySnapshot",
      async (_event, root: string | null, id: string) =>
        (await this.getRecoveryStore(root))?.delete(id) || false,
    );
    ipcMain.handle(
      "FileManager:confirmRecoverySnapshot",
      async (_event, snapshot: { displayName?: unknown; timestamp?: unknown; diskChanged?: unknown; diskMissing?: unknown }) =>
        this.confirmRecoverySnapshot(snapshot),
    );

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

    ipcMain.handle("FileManager:readImageFile", async (_event, filePath: string, context?: MarkdownImageReadContext) =>
      this.readImageFile(filePath, context),
    );

    ipcMain.handle(
      "FileManager:getFileChunk",
      async (event, filePath: string, startLine: number, lineCount: number) => {
        return await this.getFileChunk(filePath, startLine, lineCount);
      },
    );

    ipcMain.handle("FileManager:releaseFile", async (_event, filePath: string) => {
      return this.releaseFile(filePath);
    });

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
      "FileManager:saveWorkspaceState",
      async (_event, workspaceRoot: string, state: object) =>
        this.saveWorkspaceState(workspaceRoot, state),
    );

    ipcMain.handle(
      "FileManager:loadWorkspaceState",
      async (_event, workspaceRoot: string) =>
        this.loadWorkspaceState(workspaceRoot),
    );

    ipcMain.handle(
      "FileManager:resolveWorkspaceStatePath",
      async (_event, workspaceRoot: string, relativePath: string) =>
        this.resolveWorkspaceStatePath(workspaceRoot, relativePath),
    );

    ipcMain.handle(
      "FileManager:getAgentApiKey",
      async (_event, providerId: string) => this.getAgentApiKey(providerId),
    );

    ipcMain.handle(
      "FileManager:hasAgentApiKey",
      async (_event, providerId: string) => Boolean(await this.getAgentApiKey(providerId)),
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

    ipcMain.handle(
      "FileManager:delete",
      async (event, targetPath: string, force: unknown = false) => {
        return await this.deleteEntry(
          targetPath,
          typeof force === "boolean" ? force : false,
        );
      },
    );

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

    ipcMain.handle(
      "FileManager:pathStatus",
      async (_event, targetPath: string) => {
        if (!validPath(targetPath))
          return { exists: false, code: "INVALID_PATH" };
        try {
          const stats = await fs.stat(targetPath);
          const isDirectory = stats.isDirectory();
          if (isDirectory) {
            try {
              await fs.access(targetPath, fsSync.constants.R_OK);
            } catch (error: any) {
              return {
                exists: true,
                isDirectory: true,
                readable: false,
                code: error?.code || "ACCESS_DENIED",
                error: error?.message,
              };
            }
          }
          return {
            exists: true,
            isDirectory,
            readable: true,
            size: isDirectory ? undefined : stats.size,
            mtimeMs: isDirectory ? undefined : stats.mtimeMs,
          };
        } catch (error: any) {
          if (error?.code === "ENOENT")
            return { exists: false, code: "SOURCE_NOT_FOUND" };
          return {
            exists: false,
            code: error?.code || "STAT_FAILED",
            error: error?.message,
          };
        }
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
      if (isAsarPath(filePath)) continue;
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
    let ownWriteToken: symbol | null = null;
    try {
      const dir = path.dirname(filePath);

      await fs.mkdir(dir, {
        recursive: true,
      });

      ownWriteToken = this.window.watcher?.beginOwnWrite(filePath) || null;
      await atomicWriteFile(filePath, content);
      this.window.watcher?.commitOwnWrite(filePath, ownWriteToken);
      this.clearFileCache(filePath);
      await this.window.reloadSettingsFromDisk?.(filePath);

      return filePath;
    } catch (error) {
      this.window.watcher?.cancelOwnWrite(filePath, ownWriteToken);
      console.error("Error saving file:", error);
      throw error;
    }
  }

  private async getRecoveryStore(
    workspaceRoot: unknown,
  ): Promise<DirtyBufferRecoveryStore | null> {
    let requestedRoot: string;
    if (workspaceRoot === null || workspaceRoot === undefined || workspaceRoot === "") {
      requestedRoot = app.getPath("userData");
    } else if (validPath(workspaceRoot) && path.isAbsolute(workspaceRoot)) {
      requestedRoot = workspaceRoot;
    } else {
      return null;
    }
    let root: string;
    try {
      root = await fs.realpath(requestedRoot);
    } catch {
      return null;
    }
    let store = this.recoveryStores.get(root);
    if (store) {
      this.recoveryStores.delete(root);
      this.recoveryStores.set(root, store);
      return store;
    }
    const pending = this.recoveryStoreLoads.get(root);
    if (pending) return pending;
    const load = (async () => {
      try {
        if (!(await fs.stat(root)).isDirectory()) return null;
        const created = new DirtyBufferRecoveryStore(root);
        this.recoveryStores.set(root, created);
        while (this.recoveryStores.size > 32)
          this.recoveryStores.delete(this.recoveryStores.keys().next().value as string);
        return created;
      } catch {
        return null;
      }
    })();
    this.recoveryStoreLoads.set(root, load);
    try { return await load; }
    finally {
      if (this.recoveryStoreLoads.get(root) === load)
        this.recoveryStoreLoads.delete(root);
    }
  }

  async saveRecoverySnapshot(
    workspaceRoot: unknown,
    snapshotValue: unknown,
  ): Promise<{ success: boolean; id?: string; reason?: string }> {
    if (!snapshotValue || typeof snapshotValue !== "object" ||
        Array.isArray(snapshotValue))
      return { success: false, reason: "INVALID_SNAPSHOT" };
    const snapshot = snapshotValue as Record<string, unknown>;
    if (typeof snapshot.content !== "string" ||
        typeof snapshot.displayName !== "string" ||
        !Number.isSafeInteger(snapshot.lineCount) ||
        !Number.isSafeInteger(snapshot.editVersion))
      return { success: false, reason: "INVALID_SNAPSHOT" };

    const store = await this.getRecoveryStore(workspaceRoot);
    if (!store) return { success: false, reason: "INVALID_WORKSPACE" };
    let record: DirtyBufferRecoveryInput;
    if (typeof snapshot.filePath === "string" && validPath(snapshot.filePath) &&
        path.isAbsolute(snapshot.filePath)) {
      let filePath = path.resolve(snapshot.filePath);
      try {
        filePath = await fs.realpath(filePath);
      } catch {
        try {
          filePath = path.join(
            await fs.realpath(path.dirname(filePath)),
            path.basename(filePath),
          );
        } catch { /* Keep the normalized path when the original parent is gone. */ }
      }
      const relative = path.relative(store.root, filePath);
      const relativePath = relative === "" || (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        ? relative.split(path.sep).join("/")
        : null;
      record = {
        identity: `path:${relativePath ?? filePath}`,
        kind: "path",
        filePath,
        relativePath,
        displayName: snapshot.displayName,
        content: snapshot.content,
        lineCount: snapshot.lineCount as number,
        editVersion: snapshot.editVersion as number,
        diskFingerprint: typeof snapshot.diskFingerprint === "string"
          ? snapshot.diskFingerprint : null,
      };
    } else if (typeof snapshot.untitledId === "string" &&
        /^[A-Za-z0-9._-]{1,160}$/.test(snapshot.untitledId)) {
      record = {
        identity: `untitled:${snapshot.untitledId}`,
        kind: "untitled",
        displayName: snapshot.displayName,
        content: snapshot.content,
        lineCount: snapshot.lineCount as number,
        editVersion: snapshot.editVersion as number,
      };
    } else {
      return { success: false, reason: "INVALID_SNAPSHOT" };
    }
    return store.save(record);
  }

  async confirmRecoverySnapshot(snapshot: {
    displayName?: unknown;
    timestamp?: unknown;
    diskChanged?: unknown;
    diskMissing?: unknown;
  }): Promise<"restore" | "discard" | "cancel"> {
    if (!this.window.window || !validPath(snapshot?.displayName)) return "cancel";
    const date = Number.isFinite(snapshot.timestamp)
      ? new Date(Number(snapshot.timestamp)).toLocaleString()
      : "an earlier session";
    const detail = snapshot.diskChanged === true
      ? "The file on disk changed after this recovery snapshot. Restoring keeps the recovered text in NCE and does not write to disk."
      : snapshot.diskMissing === true
        ? "The original file is missing. Restoring opens the recovered text as a new unsaved buffer."
        : "Restoring opens the recovered text as an unsaved buffer and does not write to disk.";
    const { response } = await dialog.showMessageBox(this.window.window, {
      type: "warning",
      buttons: ["Restore", "Discard", "Later"],
      defaultId: 0,
      cancelId: 2,
      message: `Recover unsaved changes for “${snapshot.displayName}”?`,
      detail: `Saved ${date}. ${detail}`,
    });
    return response === 0 ? "restore" : response === 1 ? "discard" : "cancel";
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
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      const items = await Promise.all(
        entries.map(async (entry: any): Promise<FileItem> => {
          const name = typeof entry === "string" ? entry : entry.name;
          const fullPath = path.join(dirPath, name);
          let isDirectory = entry?.isDirectory?.() === true;
          const isRegularFile = entry?.isFile?.() === true;

          // Dirents classify regular files and directories without a stat.
          // Symlinks and special/opaque entries retain the previous stat path
          // so links to directories and entries with unknown types keep their type.
          if (!isDirectory && !isRegularFile) {
            const stats = await statOpaqueEntry(fullPath);
            isDirectory = stats.isDirectory();
          }

          return {
            name,
            path: fullPath,
            type: isDirectory ? "folder" : "file",
          };
        }),
      );

      return items.sort((a, b) => {
        if (a.type === b.type) {
          return a.name.localeCompare(b.name);
        }
        return a.type === "folder" ? -1 : 1;
      });
    } catch (error: any) {
      if (error?.code !== "ENOENT")
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
      const oldResolved = path.resolve(oldPath);
      const newResolved = path.resolve(newPath);
      if (
        path.dirname(oldResolved) !== path.dirname(newResolved) ||
        validateEntryName(path.basename(newResolved))
      ) {
        return {
          success: false,
          code: "INVALID_NAME",
          error: "Invalid file name.",
        };
      }
      const sourceStats = await fs.stat(oldPath);
      if (oldResolved === newResolved)
        return {
          success: true,
          path: newPath,
          type: sourceStats.isDirectory() ? "folder" : "file",
        };
      let destinationStats: any = null;
      try {
        destinationStats = await fs.stat(newPath);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      const sameEntry =
        destinationStats &&
        sourceStats.dev === destinationStats.dev &&
        sourceStats.ino === destinationStats.ino;
      if (destinationStats && !sameEntry) {
        return {
          success: false,
          code: "TARGET_EXISTS",
          error: "A file or folder with this name already exists.",
        };
      }

      if (sameEntry) {
        const temporaryPath = path.join(
          path.dirname(oldResolved),
          `.${path.basename(oldResolved)}.nce-rename-${crypto.randomUUID()}`,
        );
        await fs.rename(oldPath, temporaryPath);
        try {
          await fs.rename(temporaryPath, newPath);
        } catch (error) {
          try {
            await fs.rename(temporaryPath, oldPath);
          } catch (rollbackError) {
            console.error("Case-only rename rollback failed:", rollbackError);
          }
          throw error;
        }
      } else {
        await fs.rename(oldPath, newPath);
      }
      this.clearFileCache(oldPath);
      this.clearFileCache(newPath);
      return {
        success: true,
        path: newPath,
        type: sourceStats.isDirectory() ? "folder" : "file",
      };
    } catch (error: any) {
      if (error?.code !== "ENOENT")
        console.error("Error renaming entry:", error);
      return {
        success: false,
        code:
          error?.code === "ENOENT"
            ? "SOURCE_NOT_FOUND"
            : error?.code === "EEXIST" || error?.code === "ENOTEMPTY"
              ? "TARGET_EXISTS"
              : error?.code === "EACCES" || error?.code === "EPERM"
                ? "PERMISSION_DENIED"
                : "RENAME_FAILED",
        error: error?.message || "Rename failed.",
      };
    }
  }

  async deleteEntry(
    targetPath: string,
    force: boolean = false,
  ): Promise<FileOperationResult> {
    if (
      !validPath(targetPath) ||
      path.resolve(targetPath) === path.parse(path.resolve(targetPath)).root
    )
      return invalidPath();
    if (typeof force !== "boolean") {
      return {
        success: false,
        code: "INVALID_ARGUMENT",
        error: "force must be boolean.",
      };
    }
    try {
      const stats = await fs.lstat(targetPath);
      if (stats.isDirectory()) {
        if (force) {
          await fs.rm(targetPath, { recursive: true, force: true });
        } else {
          await fs.rmdir(targetPath);
        }
        this.clearFileCache(targetPath);
        return {
          success: true,
          path: targetPath,
          type: "folder",
          ...(force ? { forced: true } : {}),
        };
      }
      await fs.unlink(targetPath);
      this.clearFileCache(targetPath);
      return { success: true, path: targetPath, type: "file" };
    } catch (error: any) {
      const code =
        error?.code === "ENOENT"
          ? "SOURCE_NOT_FOUND"
          : error?.code === "ENOTEMPTY" || error?.code === "EEXIST"
            ? "FOLDER_NOT_EMPTY"
            : error?.code === "EACCES" || error?.code === "EPERM"
              ? "PERMISSION_DENIED"
              : "DELETE_FAILED";
      if (code !== "SOURCE_NOT_FOUND" && code !== "FOLDER_NOT_EMPTY") {
        console.error("Error deleting entry:", error);
      }
      return {
        success: false,
        code,
        type: code === "FOLDER_NOT_EMPTY" ? "folder" : undefined,
        path: targetPath,
        error:
          code === "FOLDER_NOT_EMPTY"
            ? "The folder is not empty."
            : error?.message || "Delete failed.",
      };
    }
  }

  async createFile(
    dirPath: string,
    fileName: string,
    content: string = "",
    overwrite: boolean = false,
  ): Promise<FileOperationResult> {
    if (
      !validPath(dirPath) ||
      !validName(fileName) ||
      typeof content !== "string" ||
      typeof overwrite !== "boolean"
    )
      return invalidPath();
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
    if (fsSync.existsSync(destPath))
      return { success: false, code: "DESTINATION_EXISTS" };
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
    if (fsSync.existsSync(destPath))
      return { success: false, code: "DESTINATION_EXISTS" };
    try {
      await fs.rename(sourcePath, destPath);
      this.clearFileCache(sourcePath);
      this.clearFileCache(destPath);
      return { success: true, path: destPath };
    } catch (error: any) {
      if (error?.code === "EXDEV") {
        try {
          await fs.cp(sourcePath, destPath, {
            recursive: true,
            force: false,
            errorOnExist: true,
          });
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
    if (
      !validPath(targetPath) ||
      path.resolve(targetPath) === path.parse(path.resolve(targetPath)).root
    )
      return invalidPath();
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

  async initializeFile(filePath: string): Promise<{
    success: boolean;
    totalLines: number;
    errorCode?: string;
    size?: number;
    largeFileMode?: boolean;
    eol?: string;
    hasFinalNewline?: boolean;
    maxLineLength?: number;
    incrementalEligible?: boolean;
    lineEndings?: string[];
  }> {
    try {
      if (!validPath(filePath))
        return { success: false, totalLines: 0, errorCode: "INVALID_PATH" };
      if (isAsarPath(filePath))
        return { success: false, totalLines: 0, errorCode: "BINARY_FILE" };
      // Reloads replace the old snapshot and cancel any index still being built.
      this.clearFileCache(filePath);
      const stats = await fs.stat(filePath);
      const sample = await fs.open(filePath, "r");
      let sampleBuffer = Buffer.alloc(0);
      try {
        const buffer = Buffer.alloc(Math.min(BINARY_SAMPLE_SIZE, stats.size));
        const { bytesRead } = await sample.read(buffer, 0, buffer.length, 0);
        sampleBuffer = buffer.subarray(0, bytesRead);
      } finally {
        await sample.close();
      }
      if (looksBinary(sampleBuffer)) {
        return {
          success: false,
          totalLines: 0,
          errorCode: "BINARY_FILE",
          size: stats.size,
        };
      }

      if (stats.size > LARGE_FILE_MODE_THRESHOLD) {
        // Large files keep only offsets and EOL codes in main; text is read on demand.
        const entry = await this.largeFileStore.index(filePath, stats);
        return {
          success: true,
          largeFileMode: true,
          totalLines: entry.totalLines,
          size: entry.size,
          eol: entry.eol,
          hasFinalNewline: entry.hasFinalNewline,
          incrementalEligible: false,
        };
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
        largeFileMode: false,
        totalLines: lines.length,
        size: stats.size,
        eol,
        hasFinalNewline,
        maxLineLength,
        incrementalEligible: stats.size <= 1024 * 1024 && maxLineLength <= 1000,
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

  async readImageFile(filePath: unknown, context?: MarkdownImageReadContext): Promise<{
    success: boolean; code?: string; mimeType?: string; data?: Uint8Array; size?: number;
  }> {
    if (!validPath(filePath)) return { success: false, code: "INVALID_PATH" };
    let imagePath = filePath;
    if (context !== undefined) {
      const resolved = resolveMarkdownImagePath(
        context?.sourcePath,
        filePath,
        context?.workspaceRoot,
      );
      if (!resolved) return { success: false, code: "OUTSIDE_WORKSPACE" };
      const pathApi = pathImplementation(resolved.sourcePath);
      try {
        const [realRoot, realSource, realImage] = await Promise.all([
          fs.realpath(resolved.workspaceRoot),
          fs.realpath(resolved.sourcePath),
          fs.realpath(resolved.imagePath),
        ]);
        if (!isPathInside(realRoot, realSource, pathApi) ||
            !isPathInside(realRoot, realImage, pathApi))
          return { success: false, code: "OUTSIDE_WORKSPACE" };
        imagePath = realImage;
      } catch (error: any) {
        return {
          success: false,
          code: error?.code === "ENOENT" || error?.code === "ENOTDIR"
            ? "SOURCE_NOT_FOUND" : "IMAGE_READ_FAILED",
        };
      }
    }
    const mimeType = IMAGE_MIME_TYPES[path.extname(imagePath).toLowerCase()];
    if (!mimeType) return { success: false, code: "UNSUPPORTED_IMAGE" };
    try {
      const stats = await fs.stat(imagePath);
      if (!stats.isFile()) return { success: false, code: "NOT_A_FILE" };
      if (stats.size > MAX_IMAGE_FILE_SIZE)
        return { success: false, code: "IMAGE_TOO_LARGE" };
      const buffer = await fs.readFile(imagePath);
      if (buffer.length > MAX_IMAGE_FILE_SIZE)
        return { success: false, code: "IMAGE_TOO_LARGE" };
      return { success: true, mimeType, data: Uint8Array.from(buffer), size: buffer.length };
    } catch (error: any) {
      return {
        success: false,
        code: error?.code === "ENOENT" || error?.code === "ENOTDIR"
          ? "SOURCE_NOT_FOUND" : "IMAGE_READ_FAILED",
      };
    }
  }

  async getFileChunk(
    filePath: string,
    startLine: number,
    lineCount: number,
  ): Promise<{
    success: boolean;
    lines: string[];
    lineEndings?: string[];
    errorCode?: string;
  }> {
    try {
      if (
        !validPath(filePath) ||
        !Number.isInteger(startLine) ||
        startLine < 0 ||
        !Number.isInteger(lineCount) ||
        lineCount < 0
      )
        return { success: false, lines: [] };
      const safeStartLine = startLine;
      const safeLineCount = lineCount;
      if (this.largeFileStore.has(filePath))
        return await this.largeFileStore.getChunk(
          filePath,
          safeStartLine,
          safeLineCount,
        );
      const cachedLines = this.fileCache.get(filePath);
      // Never splice a new disk version into an existing partial load.
      if (!cachedLines) return { success: false, lines: [] };

      const endLine = Math.min(
        safeStartLine + safeLineCount,
        cachedLines.length,
      );
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
      this.largeFileStore.release(normalized, true);
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
      this.largeFileStore.clear();
    }
  }

  releaseFile(filePath: string): boolean {
    if (!validPath(filePath)) return false;
    this.clearFileCache(filePath);
    return true;
  }

  saveState(stateString: string): Promise<boolean> {
    const next = this.stateSaveQueue
      .catch(() => false)
      .then(() => this.writeState(stateString));
    this.stateSaveQueue = next;
    return next;
  }

  private async writeState(stateString: string): Promise<boolean> {
    try {
      const filePath = path.join(app.getPath("userData"), "state.json");
      if (typeof stateString !== "string") return false;
      const state = JSON.parse(stateString);
      if (!state || typeof state !== "object" || Array.isArray(state))
        return false;
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

  async saveWorkspaceState(
    workspaceRoot: string,
    state: object,
  ): Promise<boolean> {
    if (!validPath(workspaceRoot) || !state || typeof state !== "object")
      return false;
    const key = path.resolve(workspaceRoot);
    const previous =
      this.workspaceStateSaveQueues.get(key) || Promise.resolve(true);
    const next = previous
      .catch(() => false)
      .then(() => this.writeWorkspaceState(workspaceRoot, state));
    this.workspaceStateSaveQueues.set(key, next);
    return next.finally(() => {
      if (this.workspaceStateSaveQueues.get(key) === next)
        this.workspaceStateSaveQueues.delete(key);
    });
  }

  private async writeWorkspaceState(
    workspaceRoot: string,
    state: object,
  ): Promise<boolean> {
    try {
      await new NceWorkspaceStorage(workspaceRoot).writeWorkspaceState(state);
      return true;
    } catch (error) {
      console.error("[NCE Workspace State] Unable to save state", {
        root: workspaceRoot,
        error,
      });
      return false;
    }
  }

  async loadWorkspaceState(workspaceRoot: string): Promise<object | null> {
    if (!validPath(workspaceRoot)) return null;
    return new NceWorkspaceStorage(workspaceRoot).readWorkspaceState<object>();
  }

  async resolveWorkspaceStatePath(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<{ path: string; isDirectory: boolean; readable: boolean } | null> {
    if (
      !validPath(workspaceRoot) ||
      !validPath(relativePath) ||
      path.isAbsolute(relativePath) ||
      /^(?:[A-Za-z]:|\\\\|\/|~|file:)/i.test(relativePath) ||
      relativePath.includes("\0")
    )
      return null;
    try {
      const root = await fs.realpath(workspaceRoot);
      const candidate = path.resolve(
        root,
        relativePath.replace(/[\\/]/g, path.sep),
      );
      const realCandidate = await fs.realpath(candidate);
      const relative = path.relative(root, realCandidate);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        return null;
      const stats = await fs.stat(realCandidate);
      await fs.access(realCandidate, fsSync.constants.R_OK);
      return {
        path: candidate,
        isDirectory: stats.isDirectory(),
        readable: true,
      };
    } catch {
      return null;
    }
  }

  private getSecretsPath(): string {
    return path.join(app.getPath("userData"), "agent-secrets.json");
  }

  private encryptionAvailable(): boolean {
    return (
      safeStorage.isEncryptionAvailable() &&
      safeStorage.getSelectedStorageBackend?.() !== "basic_text"
    );
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
      return safeStorage.decryptString(
        Buffer.from(secrets[providerId], "base64"),
      );
    } catch {
      return "";
    }
  }

  private async setAgentApiKey(
    providerId: string,
    apiKey: string,
  ): Promise<boolean> {
    if (
      typeof providerId !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(providerId) ||
      typeof apiKey !== "string" ||
      !this.encryptionAvailable()
    )
      return false;
    const secrets = await this.readAgentSecrets();
    if (apiKey) {
      secrets[providerId] = safeStorage
        .encryptString(apiKey)
        .toString("base64");
    } else {
      delete secrets[providerId];
    }
    await fs.mkdir(path.dirname(this.getSecretsPath()), { recursive: true });
    await fs.writeFile(this.getSecretsPath(), JSON.stringify(secrets), "utf-8");
    return true;
  }
}
