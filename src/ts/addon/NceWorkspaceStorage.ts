import { promises as fs, lstatSync, mkdirSync } from "fs";
import path from "path";

const NCE_DIRECTORY = ".nce";
const CACHE_DIRECTORY = "cache";
const TEMP_DIRECTORY = "temp";
const WORKSPACE_STATE_FILE = "workspace.json";
export const MAX_WORKSPACE_STATE_BYTES = 256 * 1024;

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

  private async ensureDirectory(directory: string): Promise<void> {
    try {
      const stats = await fs.lstat(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory())
        throw new Error("Workspace storage must use real directories.");
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fs.mkdir(directory);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error("Workspace storage must use real directories.");
  }

  async ensureStructure(): Promise<void> {
    await this.ensureDirectory(this.nceRoot);
    await this.ensureDirectory(this.cacheRoot);
    await this.ensureDirectory(this.tempRoot);
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
      const serialized = JSON.stringify(value, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_STATE_BYTES)
        throw new Error("Workspace state exceeds the size limit.");
      await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, target);
      return target;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readWorkspaceState<T>(): Promise<T | null> {
    try {
      const stats = await fs.lstat(this.workspaceStatePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        console.warn("[NCE Workspace State] Refusing a non-regular state file", {
          root: this.workspaceRoot,
        });
        return null;
      }
      if (stats.size > MAX_WORKSPACE_STATE_BYTES) {
        console.warn("[NCE Workspace State] State exceeds size limit", {
          root: this.workspaceRoot,
          bytes: stats.size,
          maxBytes: MAX_WORKSPACE_STATE_BYTES,
        });
        return null;
      }
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

  ensureRunTempRoot(runId: string): string {
    const target = this.getRunTempRoot(runId);
    const ensure = (directory: string) => {
      try {
        const stats = lstatSync(directory);
        if (stats.isSymbolicLink() || !stats.isDirectory())
          throw new Error("Run storage must use real directories.");
        return;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      mkdirSync(directory);
      const stats = lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory())
        throw new Error("Run storage must use real directories.");
    };
    ensure(this.tempRoot);
    ensure(target);
    return target;
  }

  async writeCacheText(relativePath: string, content: string): Promise<string> {
    await this.ensureStructure();
    const target = this.getCachePath(relativePath);
    await this.ensureSafeRelativeDirectory(path.dirname(target), this.cacheRoot);
    await this.assertSafeTarget(target, this.cacheRoot);
    await fs.writeFile(target, String(content), "utf8");
    return target;
  }

  async readCacheText(relativePath: string): Promise<string | null> {
    try {
      const target = this.getCachePath(relativePath);
      await this.assertSafeTarget(target, this.cacheRoot);
      return await fs.readFile(target, "utf8");
    } catch {
      return null;
    }
  }

  private async ensureSafeRelativeDirectory(directory: string, root: string): Promise<void> {
    const relative = path.relative(root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Storage path escapes its root.");
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stats = await fs.lstat(current);
        if (stats.isSymbolicLink() || !stats.isDirectory())
          throw new Error("Storage directories must not be symbolic links.");
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        await fs.mkdir(current);
      }
    }
  }

  private async assertSafeTarget(target: string, root: string): Promise<void> {
    const realRoot = await fs.realpath(root);
    const realParent = await fs.realpath(path.dirname(target));
    const relative = path.relative(realRoot, realParent);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Storage path escapes its real root.");
    try {
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink())
        throw new Error("Storage targets must not be symbolic links.");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async writeCacheJson(relativePath: string, value: unknown): Promise<string> {
    await this.ensureStructure();
    const target = this.getCachePath(relativePath);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await this.ensureSafeRelativeDirectory(path.dirname(target), this.cacheRoot);
    await this.assertSafeTarget(target, this.cacheRoot);
    await fs.writeFile(temporary, JSON.stringify(value), "utf8");
    await fs.rename(temporary, target);
    return target;
  }

  async readCacheJson<T>(relativePath: string): Promise<T | null> {
    try {
      const target = this.getCachePath(relativePath);
      await this.assertSafeTarget(target, this.cacheRoot);
      return JSON.parse(await fs.readFile(target, "utf8")) as T;
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
        if (!entry.isDirectory() || entry.name === "recovery" ||
            (keepRunId && entry.name === keepRunId))
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

  async enforceTempQuota(maxBytes: number, keepRunId?: string): Promise<void> {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(this.tempRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "recovery" ||
          (keepRunId && entry.name === keepRunId))
        continue;
      const candidate = path.join(this.tempRoot, entry.name);
      try {
        const stats = await fs.lstat(candidate);
        if (stats.isSymbolicLink()) {
          await fs.rm(candidate, { force: true });
          continue;
        }
        candidates.push({
          path: candidate,
          size: await this.directorySize(candidate),
          mtimeMs: stats.mtimeMs,
        });
      } catch {
        /* best-effort quota enforcement */
      }
    }
    let total = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const candidate of candidates) {
      if (total <= maxBytes) break;
      try {
        await fs.rm(candidate.path, { recursive: true, force: true });
        total -= candidate.size;
      } catch {
        /* best-effort quota enforcement */
      }
    }
  }

  private async directorySize(directory: string, depth = 0): Promise<number> {
    if (depth > 8) return 0;
    let total = 0;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += await this.directorySize(target, depth + 1);
      else if (entry.isFile()) {
        try {
          total += (await fs.stat(target)).size;
        } catch {
          /* best-effort size accounting */
        }
      }
    }
    return total;
  }
}
