const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

class WorkspaceSnapshot {
  constructor(options = {}) { this.maxTextCharacters = options.maxTextFileSnapshotChars || 100000; }
  async capture(root) {
    const files = [];
    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error(`snapshot refuses symlink: ${absolute}`);
        if (stat.isDirectory()) await walk(absolute);
        else if (stat.isFile()) {
          const buffer = await fs.readFile(absolute);
          const binary = buffer.includes(0);
          const item = { path: path.relative(root, absolute).split(path.sep).join("/"), size: stat.size, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), type: "file", binary };
          if (!binary) {
            const content = buffer.toString("utf8");
            if (content.length <= this.maxTextCharacters) item.content = content;
            else Object.assign(item, { content: content.slice(0, this.maxTextCharacters), truncated: true, originalCharacters: content.length });
          }
          files.push(item);
        }
      }
    };
    await walk(path.resolve(root));
    return { files };
  }
  diff(before, after) {
    const left = new Map(before.files.map((file) => [file.path, file]));
    const right = new Map(after.files.map((file) => [file.path, file]));
    const changes = { created: [], modified: [], deleted: [] };
    const record = (status, oldFile, newFile) => ({ path: (newFile || oldFile).path, status, beforeSha256: oldFile?.sha256 || null, afterSha256: newFile?.sha256 || null, beforeSize: oldFile?.size ?? null, afterSize: newFile?.size ?? null, ...(oldFile?.content != null ? { beforeText: oldFile.content } : {}), ...(newFile?.content != null ? { afterText: newFile.content } : {}) });
    for (const [name, file] of right) !left.has(name) ? changes.created.push(record("created", null, file)) : left.get(name).sha256 !== file.sha256 && changes.modified.push(record("modified", left.get(name), file));
    for (const [name, file] of left) if (!right.has(name)) changes.deleted.push(record("deleted", file, null));
    return changes;
  }
}
module.exports = { WorkspaceSnapshot };
