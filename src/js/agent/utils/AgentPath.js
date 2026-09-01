const AgentPath = {
  sep: "/",
  normalize(value) {
    if (typeof value !== "string") return "";
    let normalized = value.replace(/\\/g, "/").trim();
    const driveMatch = normalized.match(/^([A-Za-z]:)/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : "";
    const remainder = drive ? normalized.slice(2) : normalized;
    const absoluteUnix = remainder.startsWith("/");
    const segments = remainder.split("/").filter(Boolean);
    const stack = [];

    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment === "..") {
        if (stack.length) {
          stack.pop();
        } else if (!absoluteUnix && !drive) {
          stack.push("..");
        }
        continue;
      }
      stack.push(segment);
    }

    const joined = stack.join("/");
    if (drive) {
      const withRoot = joined ? `/${joined}` : "";
      return `${drive}${withRoot}`.replace(/\/+$/g, "") || drive;
    }
    if (absoluteUnix) return `/${joined}`.replace(/\/+$/g, "") || "/";
    return joined;
  },
  isAbsolute(value) {
    if (typeof value !== "string") return false;
    const normalized = value.replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  },
  resolve(...segments) {
    const safeSegments = segments.filter(
      (segment) => typeof segment === "string" && segment.length > 0,
    );
    if (!safeSegments.length) return "/";
    const joined = safeSegments
      .map((segment) => segment.replace(/\\/g, "/"))
      .join("/");
    return this.normalize(joined);
  },
  relative(from, to) {
    const base = this.normalize(from);
    const target = this.normalize(to);
    const baseParts = base.split("/").filter(Boolean);
    const targetParts = target.split("/").filter(Boolean);
    let index = 0;

    while (
      index < baseParts.length &&
      index < targetParts.length &&
      baseParts[index] === targetParts[index]
    ) {
      index += 1;
    }

    const up = Array(Math.max(0, baseParts.length - index)).fill("..");
    const down = targetParts.slice(index);
    return [...up, ...down].join("/");
  },
  dirname(value) {
    const normalized = this.normalize(value);
    const index = normalized.lastIndexOf("/");
    if (index < 0) return "";
    if (index === 0) return "/";
    if (index === 2 && /^[A-Za-z]:\//.test(normalized)) {
      return `${normalized.slice(0, 2)}/`;
    }
    return normalized.slice(0, index);
  },
  basename(value) {
    const normalized = this.normalize(value);
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  },
};

window.AgentPath = AgentPath;
