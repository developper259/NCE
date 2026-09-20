const path = require("node:path");
const SECRET_KEY = /^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|credential|cookie|cookies|requestheaders)$/i;
const TOKEN_METRIC = /^(input|output|total|prompt|completion|estimated|requested|max).*tokens?$/i;

class DatasetSanitizer {
  constructor(options = {}) { this.workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : null; this.secrets = (options.secrets || []).filter(Boolean).map(String); }
  sanitize(value, key = "") {
    if (SECRET_KEY.test(key) && !TOKEN_METRIC.test(key)) return "[REDACTED]";
    if (typeof value === "string") return this.sanitizeString(value);
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.sanitize(item, name)]));
    return value;
  }
  sanitizeString(input) {
    let value = input.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
    for (const secret of this.secrets) value = value.split(secret).join("[REDACTED]");
    if (this.workspaceRoot) {
      const roots = [this.workspaceRoot, this.workspaceRoot.replace(/\\/g, "/"), this.workspaceRoot.replace(/\//g, "\\")].sort((a, b) => b.length - a.length);
      for (const root of roots) value = value.split(root).join("<WORKSPACE>");
    }
    value = value.replace(/(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:Users|home)\/[^/\s]+)(?:[\\/][^\s"']*)?/g, "<EXTERNAL_PATH>");
    return value;
  }
}
module.exports = { DatasetSanitizer };
