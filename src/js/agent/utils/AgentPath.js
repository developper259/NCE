function agentPathComponents(value) {
  const normalized = AgentPath.normalize(value);
  if (normalized.startsWith("//")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    const server = parts.shift() || "";
    const share = parts.shift() || "";
    return {
      kind: "unc",
      root: `//${server}${share ? `/${share}` : ""}`,
      rootKey: `//${server}/${share}`.toLowerCase(),
      parts,
      caseInsensitive: true,
    };
  }
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (drive) {
    return {
      kind: "drive",
      root: `${drive[1].toUpperCase()}:/`,
      rootKey: `${drive[1].toLowerCase()}:`,
      parts: drive[2].split("/").filter(Boolean),
      caseInsensitive: true,
    };
  }
  const driveRelative = normalized.match(/^([A-Za-z]:)(.*)$/);
  if (driveRelative) {
    return {
      kind: "drive-relative",
      root: driveRelative[1].toUpperCase(),
      rootKey: driveRelative[1].toLowerCase(),
      parts: driveRelative[2].split("/").filter(Boolean),
      caseInsensitive: true,
    };
  }
  if (normalized.startsWith("/")) {
    return {
      kind: "posix",
      root: "/",
      rootKey: "/",
      parts: normalized.slice(1).split("/").filter(Boolean),
      caseInsensitive: false,
    };
  }
  return {
    kind: "relative",
    root: "",
    rootKey: "",
    parts: normalized.split("/").filter(Boolean),
    caseInsensitive: false,
  };
}

const AgentPath = {
  sep: "/",
  normalize(value) {
    if (typeof value !== "string" || !value) return "";
    const normalized = value.replace(/\\/g, "/");

    if (normalized.startsWith("//") && !normalized.startsWith("///")) {
      const parts = normalized.slice(2).split("/").filter(Boolean);
      const server = parts.shift() || "";
      if (!server) return "//";
      const share = parts.shift() || "";
      const root = `//${server}${share ? `/${share}` : ""}`;
      const stack = [];
      for (const segment of parts) {
        if (segment === ".") continue;
        if (segment === "..") {
          if (stack.length) stack.pop();
          continue;
        }
        stack.push(segment);
      }
      return stack.length ? `${root}/${stack.join("/")}` : root;
    }

    const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (drive) {
      const stack = [];
      for (const segment of drive[2].split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") {
          if (stack.length) stack.pop();
          continue;
        }
        stack.push(segment);
      }
      return `${drive[1].toUpperCase()}:/${stack.join("/")}`;
    }

    const driveRelative = normalized.match(/^([A-Za-z]:)(.*)$/);
    if (driveRelative) {
      const stack = [];
      for (const segment of driveRelative[2].split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === ".." && stack.length && stack[stack.length - 1] !== "..") {
          stack.pop();
        } else {
          stack.push(segment);
        }
      }
      return `${driveRelative[1].toUpperCase()}${stack.length ? stack.join("/") : ""}`;
    }

    const absoluteUnix = normalized.startsWith("/");
    const stack = [];
    for (const segment of normalized.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (stack.length && stack[stack.length - 1] !== "..") stack.pop();
        else if (!absoluteUnix) stack.push("..");
        continue;
      }
      stack.push(segment);
    }

    const joined = stack.join("/");
    if (absoluteUnix) return joined ? `/${joined}` : "/";
    return joined;
  },
  comparisonKey(value) {
    if (typeof value !== "string") return "";
    const normalized = this.normalize(value);
    const windowsPath =
      /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
    return windowsPath ? normalized.toLowerCase() : normalized;
  },
  equals(a, b) {
    if (a === b) return true;
    return this.comparisonKey(a) === this.comparisonKey(b);
  },
  samePath(a, b) {
    return this.equals(a, b);
  },
  isInside(candidate, parent) {
    if (typeof candidate !== "string" || typeof parent !== "string") return false;
    const child = agentPathComponents(candidate);
    const base = agentPathComponents(parent);
    if (
      child.kind === "drive-relative" ||
      base.kind === "drive-relative" ||
      (child.kind === "relative" && child.parts.length === 0) ||
      (base.kind === "relative" && base.parts.length === 0) ||
      child.kind !== base.kind ||
      child.rootKey !== base.rootKey
    ) return false;
    if (child.parts.length < base.parts.length) return false;
    return base.parts.every((part, index) =>
      child.caseInsensitive
        ? child.parts[index].toLowerCase() === part.toLowerCase()
        : child.parts[index] === part,
    );
  },
  isAbsolute(value) {
    if (typeof value !== "string") return false;
    const normalized = value.replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  },
  resolve(...segments) {
    let resolved = "";
    for (const segment of segments) {
      if (typeof segment !== "string" || !segment) continue;
      if (this.isAbsolute(segment)) {
        resolved = this.normalize(segment);
      } else if (!resolved) {
        resolved = this.normalize(segment);
      } else if (/^[A-Za-z]:$/.test(resolved)) {
        resolved = this.normalize(`${resolved}${segment}`);
      } else {
        const separator = resolved.endsWith("/") ? "" : "/";
        resolved = this.normalize(`${resolved}${separator}${segment}`);
      }
    }
    return resolved || "/";
  },
  relative(from, to) {
    const base = agentPathComponents(from);
    const target = agentPathComponents(to);
    if (base.kind !== target.kind || base.rootKey !== target.rootKey) {
      return this.normalize(to);
    }
    const caseInsensitive = base.caseInsensitive;
    let index = 0;
    while (
      index < base.parts.length &&
      index < target.parts.length &&
      (caseInsensitive
        ? base.parts[index].toLowerCase() === target.parts[index].toLowerCase()
        : base.parts[index] === target.parts[index])
    ) {
      index += 1;
    }
    const up = Array(Math.max(0, base.parts.length - index)).fill("..");
    const down = target.parts.slice(index);
    return [...up, ...down].join("/");
  },
  dirname(value) {
    const normalized = this.normalize(value);
    if (!normalized) return "";
    const parsed = agentPathComponents(normalized);
    if (
      (parsed.kind === "posix" && parsed.parts.length === 0) ||
      (parsed.kind === "drive" && parsed.parts.length === 0) ||
      (parsed.kind === "unc" && parsed.parts.length === 0)
    ) return normalized;
    const index = normalized.lastIndexOf("/");
    if (index < 0) return "";
    if (index === 0) return "/";
    if (index === 2 && /^[A-Za-z]:\//.test(normalized)) {
      return normalized.slice(0, 3);
    }
    return normalized.slice(0, index);
  },
  basename(value) {
    const normalized = this.normalize(value);
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  },
};

window.AgentPath = AgentPath;
