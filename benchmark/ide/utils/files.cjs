const fs = require("node:fs");
const path = require("node:path");

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.tmp`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temporaryPath, contents, "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    // Windows can reject replacement when a scanner briefly holds the target.
    // Preserve the progressively updated report even if atomic replacement is unavailable.
    if (process.platform !== "win32" || !["EPERM", "EEXIST", "EACCES"].includes(error.code)) throw error;
    fs.writeFileSync(filePath, contents, "utf8");
    fs.rmSync(temporaryPath, { force: true });
  }
}

function hashJson(value) {
  const crypto = require("node:crypto");
  const canonical = (input) => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input && typeof input === "object") {
      return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`;
    }
    return JSON.stringify(input);
  };
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

module.exports = { isInside, ensureDirectory, writeJsonAtomic, hashJson };
