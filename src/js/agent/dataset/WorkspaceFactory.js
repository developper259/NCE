const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

class WorkspaceFactory {
  constructor(options = {}) {
    this.baseDir = path.resolve(options.baseDir || process.cwd());
    this.tempRoot = options.tempRoot
      ? path.resolve(options.tempRoot)
      : os.tmpdir();
    this.ignores = new Set(options.ignores || [".git", ".nce"]);
  }
  resolveTemplate(template) {
    if (path.isAbsolute(template))
      throw new Error("workspace template must be relative");
    const resolved = path.resolve(this.baseDir, template);
    if (
      resolved !== this.baseDir &&
      !resolved.startsWith(this.baseDir + path.sep)
    )
      throw new Error("workspace template escapes its task directory");
    return resolved;
  }
  async create(task, attempt = 1) {
    const source = this.resolveTemplate(task.workspace.template);
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
      throw new Error("workspace template must be a real directory");
    await fs.mkdir(this.tempRoot, { recursive: true });
    const prefix = path.join(
      this.tempRoot,
      `nce-dataset-${String(task.id).replace(/[^a-zA-Z0-9_.-]/g, "_")}-${attempt}-`,
    );
    const root = await fs.mkdtemp(prefix);
    try {
      await this.copyDirectory(source, root);
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
    return {
      root,
      source,
      cleanup: () => fs.rm(root, { recursive: true, force: true }),
    };
  }
  async copyDirectory(source, target) {
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      if (this.ignores.has(entry.name)) continue;
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      const stat = await fs.lstat(from);
      if (stat.isSymbolicLink())
        throw new Error(
          `symlinks are not allowed in workspace templates: ${from}`,
        );
      if (stat.isDirectory()) {
        await fs.mkdir(to, { recursive: true, mode: stat.mode });
        await this.copyDirectory(from, to);
      } else if (stat.isFile()) {
        await fs.copyFile(from, to);
        await fs.chmod(to, stat.mode);
      }
    }
  }
}
module.exports = { WorkspaceFactory };
