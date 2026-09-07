// Renderer-safe paths; preserve spelling while comparing separator variants.
const NCEPath = {
  normalize(value) {
    if (typeof value !== "string") return "";
    const path = value.replace(/\\/g, "/");
    return path.replace(/\/+$/g, "") || (path.startsWith("/") ? "/" : "");
  },
  basename(value) { return this.normalize(value).split("/").pop() || ""; },
  dirname(value) {
    const path = this.normalize(value);
    const index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index) || "/";
  },
  equals(a, b) { return this.normalize(a) === this.normalize(b); },
  isInside(value, root) {
    const path = this.normalize(value), base = this.normalize(root);
    return Boolean(base) && (path === base || path.startsWith(base === "/" ? base : `${base}/`));
  },
  rebase(value, oldRoot, newRoot) {
    if (!this.isInside(value, oldRoot)) return value;
    const suffix = this.normalize(value).slice(this.normalize(oldRoot).length);
    const result = this.normalize(newRoot) + suffix;
    return newRoot.includes("\\") ? result.replace(/\//g, "\\") : result;
  },
};
