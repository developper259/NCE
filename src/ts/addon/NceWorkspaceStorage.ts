import { promises as fs } from "fs";
import path from "path";

const NCE_DIRECTORY = ".nce";
const CACHE_DIRECTORY = "cache";
const TEMP_DIRECTORY = "temp";
const WORKSPACE_STATE_FILE = "workspace.json";

export class NceWorkspaceStorage {
  readonly workspaceRoot: string;
  readonly nceRoot: string;
  readonly cacheRoot: string;
  readonly tempRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.nceRoot = path.join(this.workspaceRoot, NCE_DIRECTORY);
    this.cacheRoot = path.join(this.nceRoot, CACHE_DIRECTORY);
    this.tempRoot = path.join(this.nceRoot, TEMP_DIRECTORY);
  }

  static isInternalPath(candidate: string, workspaceRoot: string): boolean {
    const root = path.resolve(workspaceRoot);
    const absolute = path.resolve(root, candidate.replace(/\\/g, path.sep));
    const relative = path.relative(root, absolute).split(path.sep);
    return relative[0] === NCE_DIRECTORY;
  }

  private safePath(root: string, relativePath: string): string {
    if (typeof relativePath !== "string" || !relativePath.trim())
      throw new Error("A relative storage path is required.");
    const normalized = relativePath.replace(/\\/g, "/");
    if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized))
      throw new Error("Storage paths must be relative.");
    const candidate = path.resolve(root, normalized);
    const relative = path.relative(root, candidate);
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".."
    )
      throw new Error("Storage path escapes the workspace.");
    return candidate;
  }

  async ensureStructure(): Promise<void> {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    await fs.mkdir(this.tempRoot, { recursive: true });
    const ignorePath = path.join(this.nceRoot, ".gitignore");
    try {
      await fs.access(ignorePath);
    } catch {
      await fs.writeFile(ignorePath, "*\n!.gitignore\n", "utf8");
    }
  }

  get workspaceStatePath(): string {
    return path.join(this.nceRoot, WORKSPACE_STATE_FILE);
  }

  async writeWorkspaceState(value: unknown): Promise<string> {
    await this.ensureStructure();
    const target = this.workspaceStatePath;
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), "utf8");
      await fs.rename(temporary, target);
      return target;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readWorkspaceState<T>(): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.workspaceStatePath, "utf8")) as T;
    } catch (error: any) {
      if (error?.code !== "ENOENT")
        console.warn("[NCE Workspace State] Unable to load state", {
          root: this.workspaceRoot,
          error: error?.message || String(error),
        });
      return null;
    }
  }

  getCachePath(relativePath: string): string {
    return this.safePath(this.cacheRoot, relativePath);
  }

  getTempPath(relativePath: string): string {
    return this.safePath(this.tempRoot, relativePath);
  }

  getRunTempRoot(runId: string): string {
    const safeId = String(runId || "").replace(/[^A-Za-z0-9._-]/g, "_");
    if (!safeId) throw new Error("A run id is required.");
    return this.getTempPath(safeId);
  }

  async writeCacheText(relativePath: string, content: string): Promise<string> {
    await this.ensureStructure();
    const target = this.getCachePath(relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, String(content), "utf8");
    return target;
  }

  async readCacheText(relativePath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.getCachePath(relativePath), "utf8");
    } catch {
      return null;
    }
  }

  async writeCacheJson(relativePath: string, value: unknown): Promise<string> {
    await this.ensureStructure();
    const target = this.getCachePath(relativePath);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(value), "utf8");
    await fs.rename(temporary, target);
    return target;
  }

  async readCacheJson<T>(relativePath: string): Promise<T | null> {
    try {
      return JSON.parse(
        await fs.readFile(this.getCachePath(relativePath), "utf8"),
      ) as T;
    } catch {
      return null;
    }
  }

  async clearCache(): Promise<void> {
    await fs.rm(this.cacheRoot, { recursive: true, force: true });
  }

  async cleanupTemp(maxAgeMs: number, keepRunId?: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(this.tempRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const now = Date.now();
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || (keepRunId && entry.name === keepRunId))
          return;
        const candidate = path.join(this.tempRoot, entry.name);
        try {
          const stat = await fs.stat(candidate);
          if (now - stat.mtimeMs > maxAgeMs)
            await fs.rm(candidate, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }),
    );
  }
}
