import fs from "node:fs/promises";
import path from "node:path";

function comparable(value: string, platform = process.platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(root: string, candidate: string, platform = process.platform): boolean {
  const relative = path.relative(comparable(root, platform), comparable(candidate, platform));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type PathAccessOptions = {
  allowMissing?: boolean;
  requireDirectory?: boolean;
  requireFile?: boolean;
};

export class PathAccess {
  private readonly roots = new Set<string>();
  private readonly files = new Set<string>();
  private readonly targets = new Set<string>();

  constructor(
    private readonly getWorkspaceRoot: () => string | null | undefined,
    private readonly platform: NodeJS.Platform = process.platform,
    authorizedFiles: readonly string[] = [],
  ) {
    // Stored grants are canonical; resolving symlinks again could authorize a different target.
    for (const file of authorizedFiles) this.files.add(comparable(file, this.platform));
  }

  getAuthorizedFiles(): string[] {
    return [...new Set([...this.files, ...this.targets])];
  }

  trustRootSync(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
    const resolved = comparable(value, this.platform);
    this.roots.add(resolved);
    return resolved;
  }

  async authorizeRoot(value: unknown): Promise<string | null> {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
    try {
      const real = await fs.realpath(value);
      if (!(await fs.stat(real)).isDirectory()) return null;
      this.roots.add(comparable(real, this.platform));
      return real;
    } catch {
      return null;
    }
  }

  async authorizeFile(
    value: unknown,
    { allowMissing = false }: { allowMissing?: boolean } = {},
  ): Promise<string | null> {
    const real = await this.canonical(value, allowMissing);
    if (!real) return null;
    let exists = true;
    try {
      const stats = await fs.stat(real);
      if (!stats.isFile()) return null;
    } catch (error: any) {
      if (!allowMissing || error?.code !== "ENOENT") return null;
      exists = false;
    }
    if (exists) this.files.add(comparable(real, this.platform));
    else this.targets.add(comparable(real, this.platform));
    return real;
  }

  async authorizeExternal(value: unknown): Promise<string | null> {
    const real = await this.canonical(value, false);
    if (!real) return null;
    try {
      const stats = await fs.stat(real);
      if (stats.isDirectory()) return this.authorizeRoot(real);
      if (stats.isFile()) return this.authorizeFile(real);
    } catch {}
    return null;
  }

  async isAuthorized(
    value: unknown,
    { allowMissing = false, requireDirectory = false, requireFile = false }: PathAccessOptions = {},
  ): Promise<boolean> {
    const real = await this.canonical(value, allowMissing);
    if (!real) return false;
    try {
      const stats = requireDirectory || requireFile ? await fs.stat(real) : null;
      if (requireDirectory && !stats?.isDirectory()) return false;
      if (requireFile && !stats?.isFile()) return false;
    } catch (error: any) {
      if (!allowMissing || error?.code !== "ENOENT") return false;
      if (requireDirectory || requireFile) return false;
    }
    const comparableReal = comparable(real, this.platform);
    if (this.files.has(comparableReal) || this.targets.has(comparableReal)) return true;
    const workspace = await this.workspaceRootReal();
    if (workspace && inside(workspace, comparableReal, this.platform)) return true;
    for (const root of this.roots)
      if (inside(root, comparableReal, this.platform)) return true;
    return false;
  }

  isWorkspaceRoot(value: unknown): boolean {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
    const workspace = this.workspaceRoot();
    return Boolean(workspace) &&
      comparable(workspace!, this.platform) === comparable(value, this.platform);
  }

  private workspaceRoot(): string | null {
    const root = this.getWorkspaceRoot();
    if (typeof root !== "string" || !root.trim() || root.includes("\0")) return null;
    return comparable(root, this.platform);
  }

  private async workspaceRootReal(): Promise<string | null> {
    const root = this.getWorkspaceRoot();
    if (typeof root !== "string" || !root.trim() || root.includes("\0")) return null;
    try {
      return comparable(await fs.realpath(root), this.platform);
    } catch {
      return comparable(root, this.platform);
    }
  }

  private async canonical(value: unknown, allowMissing: boolean): Promise<string | null> {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
    try {
      return await fs.realpath(value);
    } catch (error: any) {
      if (!allowMissing || error?.code !== "ENOENT") return null;
      try {
        const parent = await fs.realpath(path.dirname(path.resolve(value)));
        return path.join(parent, path.basename(path.resolve(value)));
      } catch {
        return null;
      }
    }
  }
}
