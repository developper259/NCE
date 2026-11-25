import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * The Node.js runtime owned by NCE itself.
 *
 * This is a standalone Node binary staged at build time into the app
 * resources, outside app.asar. It runs NCE internals (language servers and
 * internal tools). It is deliberately separate from any Node.js a user's
 * project selects: changing the project runtime must never change the runtime
 * used to launch a language server.
 *
 * No Electron fuse is involved. In particular RunAsNode stays disabled and
 * utilityProcess is not used, because LSPs need a piped stdin.
 */
export interface InternalNodeRuntimeInfo {
  /** Absolute path to the standalone Node executable. */
  executable: string;
  /** Pinned version of the embedded runtime. */
  version: string;
  /** Where the executable was resolved from, for diagnostics. */
  source: "packaged" | "development";
}

export interface InternalNodeRuntimeOptions {
  /** Override for tests. Defaults to `process.resourcesPath` in Electron. */
  resourcesPath?: string;
  /** Override for tests. Defaults to the pinned version. */
  version?: string;
  /** Override for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override for tests. Defaults to `process.cwd()`. */
  cwd?: string;
}

/** Pinned version. Keep in sync with scripts/internal-node-config.cjs. */
export const INTERNAL_NODE_VERSION = "24.22.3";
const RESOURCE_DIR = "internal-node";

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "node.exe" : "node";
}

function resourcesRoot(options: InternalNodeRuntimeOptions): string | null {
  if (options.resourcesPath) return options.resourcesPath;
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof electronResources === "string" && electronResources) return electronResources;
  return null;
}

/**
 * Resolve the embedded runtime without ever falling back to PATH or to a
 * user-managed Node installation. A missing runtime is an explicit error:
 * silently using another Node would break the separation of concerns.
 */
export async function resolveInternalNodeRuntime(
  options: InternalNodeRuntimeOptions = {},
): Promise<InternalNodeRuntimeInfo> {
  const root = resourcesRoot(options);
  if (!root) {
    throw new Error(
      "The internal Node.js runtime is unavailable: no application resources path was found.",
    );
  }
  const version = options.version || INTERNAL_NODE_VERSION;
  const platform = options.platform || process.platform;
  const executable = path.join(
    root,
    RESOURCE_DIR,
    version,
    executableName(platform),
  );

  let stats;
  try {
    stats = await fs.stat(executable);
  } catch {
    throw new Error(
      `The internal Node.js runtime is unavailable: ${executable} does not exist. ` +
      "It is staged during the build; rebuild NCE to restore it.",
    );
  }
  if (!stats.isFile()) {
    throw new Error(`The internal Node.js runtime is not a file: ${executable}.`);
  }
  if (platform !== "win32" && (stats.mode & 0o111) === 0) {
    throw new Error(`The internal Node.js runtime is not executable: ${executable}.`);
  }

  const packaged = typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string";
  return {
    executable,
    version,
    source: packaged ? "packaged" : "development",
  };
}

/** Candidate path for diagnostics and tests; does not touch the filesystem. */
export function internalNodeRuntimePath(
  options: InternalNodeRuntimeOptions = {},
): string | null {
  const root = resourcesRoot(options);
  if (!root) return null;
  return path.join(
    root,
    RESOURCE_DIR,
    options.version || INTERNAL_NODE_VERSION,
    executableName(options.platform || process.platform),
  );
}
