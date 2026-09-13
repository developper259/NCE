import fs from "node:fs/promises";
import path from "node:path";

export const RECENT_FOLDERS_LIMIT = 10;

export function normalizeRecentFolderPath(
  folderPath: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof folderPath !== "string" || !folderPath.trim()) return "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.normalize(pathApi.resolve(folderPath.trim()));
}

export function recentFolderKey(
  folderPath: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeRecentFolderPath(folderPath, platform);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class RecentFoldersManager {
  readonly storePath: string;
  readonly platform: NodeJS.Platform;
  private folders: string[] = [];
  private writeQueue: Promise<boolean> = Promise.resolve(true);

  constructor(userDataPath: string, platform: NodeJS.Platform = process.platform) {
    this.storePath = path.join(userDataPath, "recent-folders.json");
    this.platform = platform;
  }

  async initialize(): Promise<string[]> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      this.folders = this.sanitize(parsed);
    } catch (error: any) {
      this.folders = [];
      if (error?.code !== "ENOENT")
        console.warn("[Recent Folders] Invalid store; resetting history", error);
    }
    await this.save();
    return this.getAll();
  }

  getAll(): string[] {
    return [...this.folders];
  }

  async add(folderPath: unknown): Promise<boolean> {
    const normalized = normalizeRecentFolderPath(folderPath, this.platform);
    if (!normalized) return false;
    const key = recentFolderKey(normalized, this.platform);
    this.folders = [
      normalized,
      ...this.folders.filter(
        (folder) => recentFolderKey(folder, this.platform) !== key,
      ),
    ].slice(0, RECENT_FOLDERS_LIMIT);
    return this.save();
  }

  async remove(folderPath: unknown): Promise<boolean> {
    const key = recentFolderKey(folderPath, this.platform);
    if (!key) return false;
    this.folders = this.folders.filter(
      (folder) => recentFolderKey(folder, this.platform) !== key,
    );
    return this.save();
  }

  async clear(): Promise<boolean> {
    this.folders = [];
    return this.save();
  }

  private sanitize(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
      const normalized = normalizeRecentFolderPath(candidate, this.platform);
      const key = recentFolderKey(normalized, this.platform);
      if (!normalized || !key || seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
      if (result.length === RECENT_FOLDERS_LIMIT) break;
    }
    return result;
  }

  private save(): Promise<boolean> {
    this.writeQueue = this.writeQueue
      .catch(() => false)
      .then(() => this.writeSnapshot(this.folders));
    return this.writeQueue;
  }

  private async writeSnapshot(folders: string[]): Promise<boolean> {
    const temporaryPath = `${this.storePath}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      await fs.writeFile(temporaryPath, `${JSON.stringify(folders, null, 2)}\n`, "utf8");
      await fs.rename(temporaryPath, this.storePath);
      return true;
    } catch (error) {
      console.error("[Recent Folders] Failed to save history", error);
      try {
        await fs.unlink(temporaryPath);
      } catch {}
      return false;
    }
  }
}
