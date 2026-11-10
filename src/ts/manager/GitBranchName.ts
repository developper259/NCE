/** Validate a branch name using Git's ref-name rules for HEAD targets. */
export function isValidGitBranchName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.trim();
  if (!name || name.length > 255 || name === "@" || name === "HEAD") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")))
    return false;
  return !/[\u0000-\u0020\u007f~^:?*[\\]/.test(name);
}
